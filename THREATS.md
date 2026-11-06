# THREATS.md — LedgerLine Threat Model & Security Defense Architecture

> *"A judge will spend time trying to break the money, against your deployed system, using every route they can think of... Working that out is the job."*

This document provides an exhaustive inventory of the threat vectors analyzed during the design and implementation of LedgerLine, the mitigations implemented to close each threat, and the operational trade-offs and risks knowingly accepted.

---

## Threat Matrix Overview

| Threat ID | Threat Name | Severity | Status | Primary Defense Layer |
| :--- | :--- | :--- | :--- | :--- |
| **THREAT-01** | Race Condition Balance Overdraw | Critical | **Closed** | Keyed Account Mutex + `CHECK (balance >= 0)` |
| **THREAT-02** | Bi-Directional Transfer Deadlock | High | **Closed** | Canonical Lexicographical Lock Ordering |
| **THREAT-03** | Request Replay / Double Payment | Critical | **Closed** | Idempotency Key Registry & Duplicate Counting |
| **THREAT-04** | Idempotency Key Parameter Mismatch | High | **Closed** | Canonical Request Payload Hashing (SHA-256) |
| **THREAT-05** | In-Flight Idempotency Concurrency Race | High | **Closed** | Async In-Flight Event Mutex & State Tracking |
| **THREAT-06** | Unauthorized Cross-Account Money Movement | Critical | **Closed** | Server-Side Entitlement Enforcement + Refusal Log |
| **THREAT-07** | Auditor Privilege Escalation | Medium | **Closed** | Strict RBAC Route Guards (Read-Only) |
| **THREAT-08** | Direct Database UPDATE/DELETE Tampering | Critical | **Closed** | SQLite Storage Triggers (`RAISE(ABORT)`) |
| **THREAT-09** | Silent Ledger Modification or Sequence Gaps | Critical | **Closed** | Cryptographic SHA-256 Merkle Hash Chain |
| **THREAT-10** | Loss of Refusal Audit Records in Rollback | High | **Closed** | Decoupled Committed Refusal Persistence |
| **THREAT-11** | Floating-Point Arithmetic Precision Drift | High | **Closed** | Integer Minor Units (Cents/Paise) Throughout |
| **THREAT-12** | Negative / Zero Amount Money Exploits | High | **Closed** | Strict Input Bounds & Database `CHECK (amount > 0)` |
| **THREAT-13** | Self-Transfer State Corruption | Medium | **Closed** | Distinct Account Validation (`source !== destination`) |
| **THREAT-14** | Overdraft Deficit Trap Exploitation | Medium | **Closed** | Boundary Check (`balance + newOverdraft >= 0`) |

---

## Detailed Threat Analysis & Mitigations

### THREAT-01: Race Condition Balance Overdraw (Double-Spend)
- **Attack Vector:** An attacker sends 10 concurrent withdrawal or transfer requests of $100 simultaneously against an account that holds only $100. In naive systems, all 10 threads read the balance ($100), all 10 verify that $100 >= $100, and all 10 write debits, driving the balance to -$900.
- **Mitigation:** Two-layer defense-in-depth:
  1. *Application Layer:* `LockService` acquires an exclusive in-memory asynchronous lock for the account prior to evaluating balances. Concurrent requests for the same account are serialized.
  2. *Database Layer:* SQLite `CHECK (balance + overdraft_limit >= 0)` constraint guarantees that even if application concurrency controls were removed or bypassed, the database engine aborts the transaction at write time.
- **Verification:** Exercised in `tests/concurrency_race.test.js` where 10 concurrent requests of $100 are launched against a $100 balance. Exactly 1 succeeds, 9 are refused, and final balance is strictly $0.

### THREAT-02: Bi-Directional Transfer Deadlock
- **Attack Vector:** User A initiates a transfer to User B at the exact same moment User B initiates a transfer to User A. Thread 1 locks Account A and waits for Account B; Thread 2 locks Account B and waits for Account A. Both threads deadlock indefinitely.
- **Mitigation:** Canonical Lexicographical Lock Ordering (Dijkstra's Resource Hierarchy). `lockService.withLocks([src, dst])` sorts all account identifiers deterministically before acquiring locks: `const uniqueSortedKeys = [...new Set(keys)].sort()`. Because every thread acquires locks in identical order, cyclical dependency deadlocks are mathematically impossible.
- **Verification:** Verified in concurrent cross-account transfer sweeps in `tests/conservation.test.js`.

### THREAT-03: Request Replay / Double Payment
- **Attack Vector:** A network timeout causes a client library to retry a payment request, or an end-user double-clicks "Submit Transfer". The duplicate HTTP request moves money a second time.
- **Mitigation:** The system requires an `Idempotency-Key` header on all money-moving endpoints. When a key is first received, it is recorded in `idempotency_keys` with status `PROCESSING`. Once executed, the HTTP response status code and JSON body are saved. When the replayed request arrives, the server detects the existing completed key, increments `duplicate_count`, sets the `X-Idempotency-Replay: true` header, and returns the cached response without moving money again.
- **Verification:** Exercised in `tests/idempotency.test.js` where 15 identical requests are fired; money moves exactly once and duplicate count in the database is recorded as 14.

### THREAT-04: Idempotency Key Parameter Mismatch Attack
- **Attack Vector:** An attacker attempts to reuse a legitimate idempotency key previously used for a $10 payment to pay an altered amount ($10,000) or to a different destination account.
- **Mitigation:** The system calculates a deterministic SHA-256 hash of the canonicalized request path and JSON body (`hashRequest(path, body)`). If an incoming request presents an existing key whose payload hash does not match, the request is immediately rejected with HTTP `422 Unprocessable Entity` ("Idempotency key reuse with mismatched parameters") without touching any balances.
- **Verification:** Exercised in `tests/idempotency.test.js`.

### THREAT-05: In-Flight Idempotency Concurrency Race
- **Attack Vector:** Request 1 arrives with key `K`. While Request 1 is actively executing database writes, duplicate Request 2 arrives with key `K` 5ms later. If Request 2 checks `status === 'COMPLETED'`, it finds no completed record and might try to execute concurrently.
- **Mitigation:** If Request 2 finds the key with status `PROCESSING`, it does not execute. Instead, it subscribes to an in-memory `EventEmitter` promise associated with `completed:${key}` with a 10-second timeout. When Request 1 finishes, it emits the completion event with the response; Request 2 resolves, increments `duplicate_count`, and returns the exact same result.
- **Verification:** Exercised in parallel promise sweeps in `tests/idempotency.test.js`.

### THREAT-06: Unauthorized Cross-Account Money Movement
- **Attack Vector:** Account Holder Alice modifies the HTTP request body to specify Bob's account ID as the source account for a transfer or withdrawal.
- **Mitigation:** Server-side authorization middleware (`requireAccountEntitlement`) resolves the target account from the database on every request and validates that `account.user_id === req.user.id` (or user role is `ADMIN`). If unauthorized, the request is rejected with HTTP `403 Forbidden` and an immutable record is inserted into `refused_transactions` with reason `UNAUTHORIZED_CROSS_ACCOUNT_ACCESS`.
- **Verification:** Exercised in `tests/authorization.test.js`.

### THREAT-07: Auditor Privilege Escalation
- **Attack Vector:** An Auditor token is used to attempt a POST to `/api/transactions/transfer` or `/api/transactions/withdraw`.
- **Mitigation:** Route middleware enforces `requireRoles('ADMIN', 'ACCOUNT_HOLDER')` on all transaction endpoints. Furthermore, `requireAccountEntitlement` checks `if (req.user.role === 'AUDITOR' && isWriteOperation)` and immediately halts execution with HTTP `403 Forbidden`. Auditors have access only to read-only statements, ledger streams, hash chain verification, and reconciliation proofs.
- **Verification:** Exercised in `tests/authorization.test.js`.

### THREAT-08: Direct Database UPDATE or DELETE Tampering
- **Attack Vector:** An attacker with SQL injection or a malicious insider with database access attempts to execute `UPDATE ledger_entries SET amount = 0` or `DELETE FROM ledger_entries` to conceal an unauthorized withdrawal.
- **Mitigation:** SQLite Storage-Level Triggers:
  ```sql
  CREATE TRIGGER trg_prevent_ledger_update BEFORE UPDATE ON ledger_entries
  BEGIN SELECT RAISE(ABORT, 'IMMUTABILITY VIOLATION: ledger_entries is strictly append-only. UPDATE is forbidden.'); END;
  CREATE TRIGGER trg_prevent_ledger_delete BEFORE DELETE ON ledger_entries
  BEGIN SELECT RAISE(ABORT, 'IMMUTABILITY VIOLATION: ledger_entries is strictly append-only. DELETE is forbidden.'); END;
  ```
  Identical triggers protect `refused_transactions`.
- **Verification:** Exercised in `tests/immutability.test.js`.

### THREAT-09: Silent Ledger Modification or Sequence Gaps (Hash Chain)
- **Attack Vector:** A privileged database administrator bypasses SQLite triggers (e.g., via `DROP TRIGGER` or direct disk block hex editing) and modifies historical amounts or deletes ledger entries.
- **Mitigation:** Cryptographic SHA-256 Hash Chain:
  - Every ledger entry contains: `sequence_number`, `previous_hash`, and `entry_hash = SHA256(previous_hash + id + sequence_number + txId + accountId + type + amount + resultingBalance + createdAt)`.
  - Genesis entry links to `0000000000000000000000000000000000000000000000000000000000000000`.
  - `verifyLedgerChain()` walks the chain from sequence 1 to head, confirming that $seq_n = seq_{n-1} + 1$, $prevHash_n = entryHash_{n-1}$, and recalculates SHA-256 for every entry. Any modified, inserted, or omitted row breaks the mathematical proof.
- **Verification:** Exercised in `tests/immutability.test.js` by dropping triggers and modifying amounts; the verifier flags the tamper and pinpoints the corrupted entry.

### THREAT-10: Loss of Refusal Audit Records via Transaction Rollback
- **Attack Vector:** A withdrawal is refused due to `INSUFFICIENT_FUNDS`. In naive implementations, the refusal log is written inside the money transaction block and an error is thrown, which causes `ROLLBACK`. As a consequence, the refusal record is rolled back and erased from the audit trail.
- **Mitigation:** LedgerLine explicitly decouples business rule validation and refusal recording from the transactional rollback boundary. While holding the account lock, the system checks balances and writes the refusal record directly to `refused_transactions` outside any rolled-back transaction block, ensuring 100% of refused attempts are permanently retained.
- **Verification:** Exercised in `tests/concurrency_race.test.js` where all 9 refused attempts are verified present on the statement.

### THREAT-11: Floating-Point Arithmetic Precision Drift
- **Attack Vector:** Using IEEE 754 floating-point numbers (`0.1 + 0.2 = 0.30000000000000004`) causes fractions of a cent to disappear or accumulate, breaking ledger balancing.
- **Mitigation:** All monetary quantities are strictly represented as integers in minor units (cents / paise). All API inputs validate `Number.isInteger(amount)` and reject fractional cents.
- **Verification:** Enforced across all schemas, service methods, and tests.

### THREAT-12: Negative or Zero Amount Money Exploits
- **Attack Vector:** An attacker submits a transfer with `amount: -5000`. If naive subtraction is used (`balance - (-5000)`), the sender's account is credited rather than debited.
- **Mitigation:** Multi-tier validation:
  1. API and Service layer validation rejects non-positive or non-integer amounts.
  2. Database constraint on `transactions`: `amount INTEGER NOT NULL CHECK (amount > 0)`.
  3. Database constraint on `ledger_entries`: `amount INTEGER NOT NULL CHECK (amount > 0)`.
- **Verification:** Tested in unit and route validations.

### THREAT-13: Self-Transfer State Corruption
- **Attack Vector:** A user transfers money from Account A to Account A. If not prevented, this could trigger self-deadlocks, duplicate ledger sequence increments, or balance race glitches.
- **Mitigation:** `executeTransfer` explicitly validates `if (sourceAccountId === destinationAccountId) throw new LedgerError(...)`.
- **Verification:** Enforced in `ledgerService.js`.

### THREAT-14: Overdraft Deficit Trap Exploitation
- **Attack Vector:** An account holder with a $200 overdraft limit spends $150 (balance: -$150). An administrator or process lowers the overdraft limit to $50. The account is now violating the balance boundary.
- **Mitigation:** The overdraft update endpoint (`PATCH /api/accounts/:id/overdraft`) verifies `if (account.balance + newOverdraft < 0)` and rejects any reduction that would violate the invariant.
- **Verification:** Tested in `accountRoutes.js`.

---

## Known Accepted Risks & Operational Boundaries

1. **Multi-Node In-Memory Lock Boundary:**
   - *Risk:* `LockService` uses an in-process asynchronous mutex. In a multi-instance horizontally scaled deployment behind a round-robin load balancer without sticky sessions, two concurrent requests for the same account could hit different Node.js processes.
   - *Why Accepted / Defense:* In SQLite, the single file writer serializes at the page level via WAL mode with `BEGIN IMMEDIATE`. Even across multiple processes, SQLite blocks the second write. In an enterprise multi-node PostgreSQL deployment, this would be replaced with `SELECT ... FOR UPDATE` or a Redis/Raft distributed lock.
2. **Database File Catastrophic Loss:**
   - *Risk:* If the host server disk physically fails, un-replicated local SQLite files could be lost.
   - *Mitigation in Production:* Use Litestream or PostgreSQL streaming replication to replicate WAL blocks continuously to S3/GCS.
3. **Client Clock Skew:**
   - *Risk:* Timestamps on client requests cannot be trusted.
   - *Mitigation:* All transaction timestamps (`created_at`) are generated strictly by the server runtime (`new Date().toISOString()`).
