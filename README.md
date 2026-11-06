# LedgerLine — Money Movement with a Ledger You Can Prove

> **Move money so the books always balance and the same request never pays twice.**  
> Built with Node.js, SQLite (WAL mode), SHA-256 Cryptographic Merkle Hash Chaining, and Two-Phase Deterministic Concurrency Locking.

---

## ⚡ Quick Evaluation Credentials (Seed Accounts)

The database automatically seeds pre-configured accounts and double-entry initial deposits upon startup:

| Role | Username | Password | Full Name | Primary Account # | Starting Balance | Authorized Overdraft |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Administrator** | `admin` | `AdminPass123!` | Alex Rivera (Administrator) | System Overseer | N/A | N/A |
| **Account Holder** | `alice` | `AlicePass123!` | Alice Henderson (Holder) | `ACT-ALICE-101` (Main)<br>`ACT-ALICE-102` (Payroll) | $1,000.00 (100,000¢)<br>$500.00 (50,000¢) | $0.00<br>$200.00 (20,000¢) |
| **Account Holder** | `bob` | `BobPass123!` | Bob Martinez (Holder) | `ACT-BOB-201` (Operating) | $250.00 (25,000¢) | $0.00 |
| **Auditor** *(Read-Only)* | `auditor` | `AuditorPass123!` | Charlie Audit (Auditor) | Read-Only Assurance | N/A | N/A |

*Note: In the web interface, click any of the top **"⚡ Evaluator Quick Roles"** buttons to switch between roles instantly.*

---

## 🎯 The Three Non-Negotiable Standards

### 1. The Books Always Balance
- **Double-Entry Principle:** Every transaction consists of balanced debits and credits ($\sum \text{Debits} - \sum \text{Credits} = 0$). External deposits debit `SYSTEM_CASH_INFLOW` and credit customer accounts; external withdrawals debit customer accounts and credit `SYSTEM_CASH_OUTFLOW`. Internal transfers debit source and credit destination.
- **The Conservation Invariant:**
  $$\sum \text{Customer Balances} \equiv \text{Total External Inflows} - \text{Total External Outflows}$$
  Internal transfers net to zero. Money is never created or destroyed.
- **Strict Non-Negative Bounds:** No account balance can fall below zero unless an explicit, authorized overdraft limit is configured (`CHECK (balance + overdraft_limit >= 0)`). This is enforced server-side and sealed at the SQLite database constraint layer.

### 2. Exactly Once (Idempotency)
- Money-moving requests carry an `Idempotency-Key` header.
- **In-Flight Concurrency Protection:** If Request 2 arrives while Request 1 is still processing, Request 2 does not execute concurrently; it subscribes to an async condition mutex and returns the identical response upon Request 1's completion.
- **Replay Interception:** Replaying the same key returns the original result with header `X-Idempotency-Replay: true` without moving money again.
- **Duplicate Tracking:** The database explicitly records `duplicate_count` in `idempotency_keys` to prove to auditors which calls were duplicate replays.
- **Parameter Mismatch Defense:** The request path and payload are hashed with SHA-256 (`request_hash`). If an idempotency key is reused with mismatched parameters (e.g., different amount or recipient), the server rejects it with HTTP `422 Unprocessable Entity`.

### 3. Proving What Happened
- **Cryptographic Merkle Hash Chaining:** Every ledger entry is cryptographically linked to its predecessor via SHA-256 (`entry_hash = SHA256(previous_hash + id + sequence_number + txId + accountId + type + amount + resultingBalance + createdAt)`). Sequence 1 links to a 64-zero Genesis hash. Any altered amount, deleted row, or sequence gap invalidates the mathematical proof.
- **Append-Only Immutability Triggers:** SQLite storage triggers abort any `UPDATE` or `DELETE` attempt on `ledger_entries` or `refused_transactions` with `IMMUTABILITY VIOLATION`.
- **Per-Account Statement with Refusal Logging:** The statement records every credit, every debit, and **every refused attempt** (insufficient funds, overdraft limit exceeded, unauthorized cross-account access), each with the resulting running balance and initiator.

---

## 🏗️ System Architecture & Concurrency Model

```
┌─────────────────────────────────────────────────────────────┐
│                 Client / Web Browser / API                  │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTP Requests + Idempotency-Key
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                     Express API Gateway                     │
│  ├── JWT Authentication & Multi-Role RBAC                   │
│  └── Idempotency Middleware (Payload Hashing & In-Flight)   │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│             Deterministic Keyed Mutex Service               │
│  ├── Canonical Lexicographical Lock Ordering ([src, dst])   │
│  └── Guarantees Deadlock-Free Concurrent Execution          │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│               Core Double-Entry Settlement Engine           │
│  ├── Balance & Overdraft Boundary Checks                    │
│  ├── Decoupled Immutable Refusal Audit Persistence          │
│  ├── SHA-256 Cryptographic Hash Chaining                    │
│  └── SQLite WAL Mode Atomic Transactions (BEGIN IMMEDIATE)  │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                  SQLite Relational Storage                  │
│  ├── CHECK (balance + overdraft_limit >= 0)                 │
│  ├── CHECK (amount > 0)                                     │
│  └── BEFORE UPDATE / DELETE Storage Triggers                │
└─────────────────────────────────────────────────────────────┘
```

### Deadlock Elimination via Canonical Lock Ordering
When moving money between Account A and Account B, two concurrent requests (`A -> B` and `B -> A`) could deadlock if each acquires its source account first. LedgerLine sorts all account identifiers lexicographically prior to lock acquisition:
```javascript
const uniqueSortedKeys = [...new Set(keys.filter(Boolean))].sort();
```
Because locks are always acquired in deterministic order, cyclical dependency deadlocks are mathematically impossible.

---

## 📡 API Documentation & Money Effects

All monetary values are sent and returned as **integers in minor units (cents)**. $10.00 is `1000`.

### 1. Authentication Endpoints

#### `POST /api/auth/login`
- **Allowed Roles:** Public
- **Money Effect:** None
- **Body:** `{ "username": "alice", "password": "AlicePass123!" }`
- **Response:** `{ "token": "<jwt>", "user": { "id": "...", "username": "alice", "role": "ACCOUNT_HOLDER", "name": "..." } }`

#### `GET /api/auth/me`
- **Allowed Roles:** Authenticated (`ADMIN`, `ACCOUNT_HOLDER`, `AUDITOR`)
- **Money Effect:** None

---

### 2. Money Movement Endpoints (Write Operations)

*Note: All money movement endpoints require header `Idempotency-Key: <unique-string>`.*

#### `POST /api/transactions/transfer`
- **Allowed Roles:** `ACCOUNT_HOLDER` (must own `sourceAccountId`), `ADMIN`. `AUDITOR` forbidden (403).
- **Money Effect:** Internal transfer. Source account balance decreases by `amount`; destination account balance increases by `amount`. **System total balance net change: exactly 0.**
- **Body:**
  ```json
  {
    "sourceAccountId": "acc_alice_main",
    "destinationAccountId": "acc_bob_main",
    "amount": 5000,
    "description": "Consulting invoice payment"
  }
  ```
- **Response (200 OK):**
  ```json
  {
    "success": true,
    "message": "Transfer executed successfully.",
    "transaction": {
      "transactionId": "tx_a1b2c3d4",
      "type": "TRANSFER",
      "sourceAccountId": "acc_alice_main",
      "destinationAccountId": "acc_bob_main",
      "amount": 5000,
      "sourcePreviousBalance": 100000,
      "sourceResultingBalance": 95000,
      "destinationResultingBalance": 30000,
      "status": "POSTED"
    }
  }
  ```
- **Error / Refusal (400 Bad Request):** If `amount > balance + overdraft_limit`, transaction is refused with `INSUFFICIENT_FUNDS` or `OVERDRAFT_LIMIT_EXCEEDED` and recorded in `refused_transactions`.

#### `POST /api/transactions/deposit`
- **Allowed Roles:** `ACCOUNT_HOLDER` (for own account), `ADMIN`. `AUDITOR` forbidden (403).
- **Money Effect:** External inflow. `SYSTEM_CASH_INFLOW` debited by `amount`; target account credited by `amount`. Total customer balances increase by `amount`.
- **Body:** `{ "accountId": "acc_alice_main", "amount": 10000, "description": "Payroll ACH" }`

#### `POST /api/transactions/withdraw`
- **Allowed Roles:** `ACCOUNT_HOLDER` (for own account), `ADMIN`. `AUDITOR` forbidden (403).
- **Money Effect:** External outflow. Target account debited by `amount`; `SYSTEM_CASH_OUTFLOW` credited by `amount`. Total customer balances decrease by `amount`.
- **Body:** `{ "accountId": "acc_alice_main", "amount": 2500, "description": "ATM cash withdrawal" }`

---

### 3. Account & Statement Endpoints

#### `GET /api/accounts`
- **Allowed Roles:** Authenticated.
- **Behavior:** `ACCOUNT_HOLDER` receives only accounts they own. `ADMIN` and `AUDITOR` receive all customer accounts.

#### `GET /api/accounts/:id/statement`
- **Allowed Roles:** Account Owner, `ADMIN`, `AUDITOR`. Unauthorized holders rejected (403).
- **Money Effect:** None.
- **Response:** Detailed chronological ledger of every debit, credit, and **refused attempt**, each with running balance, initiator name, timestamp, and hash.

#### `PATCH /api/accounts/:id/overdraft`
- **Allowed Roles:** `ADMIN` only.
- **Money Effect:** Adjusts authorized overdraft limit. Validates that `balance + newOverdraft >= 0` to prevent trapping accounts in deficit.

#### `PATCH /api/accounts/:id/status`
- **Allowed Roles:** `ADMIN` only. Freeze (`FROZEN`) or unfreeze (`ACTIVE`) accounts.

---

### 4. Audit & Verification Endpoints

#### `GET /api/audit/reconciliation`
- **Allowed Roles:** `ADMIN`, `AUDITOR`.
- **Money Effect:** None.
- **Proof:** Formally proves that:
  1. `Total Customer Balances == Total External Inflow - Total External Outflow` ($\Delta = 0$).
  2. `Sum(All Ledger Debits) == Sum(All Ledger Credits)` ($\Delta = 0$).
  3. Every individual account balance strictly equals the sum of its ledger postings.

#### `GET /api/audit/verify-chain`
- **Allowed Roles:** `ADMIN`, `AUDITOR`.
- **Proof:** Walks the SHA-256 Merkle chain from Genesis to Head. Confirms sequence contiguity and recalculates cryptographic hashes for all entries to prove zero row tampering or omissions.

#### `GET /api/audit/idempotency-log`
- **Allowed Roles:** `ADMIN`, `AUDITOR`.
- **Proof:** Returns all registered idempotency keys with duplicate counts, proving to auditors which client calls were duplicate replays.

#### `GET /api/audit/refused-log`
- **Allowed Roles:** `ADMIN`, `AUDITOR`.
- **Proof:** Returns all refused operations across all accounts with reasons, attempted amounts, user IDs, and metadata.

---

## 🚀 Running the Project from a Clean Clone

### Prerequisites
- Node.js v20+ (tested on Node v26)
- npm v10+

### 1. Local Setup
```bash
# Clone the repository
git clone <repo-url>
cd Syn

# Install dependencies
npm install

# Run the automated test suite (all 5 attack and integrity suites)
npm test

# Start the application server
npm start
```
The server will start at `http://localhost:3000` with seed accounts pre-funded and ready for evaluation.

### 2. Running with Docker
```bash
# Build and run container
docker-compose up --build
```
Open `http://localhost:3000` in your browser.

---

## 🧪 Automated Tests Suite Overview

Run the automated test suite with:
```bash
npm test
```

The automated tests actively attack the system and verify all core invariants:

1. **`tests/concurrency_race.test.js`**:
   - Spawns 10 concurrent requests of $100 simultaneously against a $100 balance.
   - Proves exactly 1 succeeds, 9 fail with refusal logged.
   - Proves final balance is strictly $0.00, never negative.
   - Proves statement contains 1 debit and 9 refused attempts.
2. **`tests/conservation.test.js`**:
   - Fires 40 randomized concurrent deposits, withdrawals, and cross-account transfers.
   - Verifies system reconciliation proof holds with $\Delta = 0$ across customer balances and double-entry debits/credits.
3. **`tests/idempotency.test.js`**:
   - Fires 15 concurrent and sequential requests with an identical idempotency key.
   - Verifies money moves once ($25 debited/credited once).
   - Verifies duplicate count equals 14 in database.
   - Verifies parameter mismatch attack (reusing key with different amount) is rejected with HTTP 422.
4. **`tests/authorization.test.js`**:
   - Tests cross-account theft: Alice attempts to withdraw or transfer Bob's funds (rejected with 403, refusal recorded).
   - Tests auditor privilege escalation: Auditor attempts to move money (rejected with 403).
   - Tests statement isolation: Alice cannot view Bob's statement.
5. **`tests/immutability.test.js`**:
   - Tests database triggers: Direct SQL `UPDATE` or `DELETE` on `ledger_entries` or `refused_transactions` is aborted.
   - Tests cryptographic tampering: Drops triggers and alters ledger row amount; verifier detects corruption and flags broken hash chain.

---

## 📝 Short Engineering Write-Up

### What We Built
- A strict **Double-Entry Settlement Engine** with immutable system clearing accounts (`SYSTEM_CASH_INFLOW`, `SYSTEM_CASH_OUTFLOW`) where money is represented strictly as integers in minor units.
- An **In-Flight Idempotency Engine** with payload hashing and duplicate tracking that handles in-flight concurrency races without double-moving money.
- A **Deterministic Two-Phase Locking Service** that eliminates multi-account transfer deadlocks via canonical resource ordering.
- An **Append-Only Tamper-Evident Ledger** secured by both SQLite storage triggers and a SHA-256 Merkle chain.
- A complete **Multi-Role RBAC System** (`ADMIN`, `ACCOUNT_HOLDER`, `AUDITOR`) with server-side account entitlement validation on every request.
- A **Fintech Web Application** with live balance cards, transfer forms, double-click race simulators, per-account statement explorers, and auditor cryptographic verification consoles.

### What We Deliberately Did Not Build (and Why)
1. **Multi-Currency FX Exchange:** We deliberately standardized on USD minor units (`USD` cents). Introducing dynamic foreign exchange rates during transfers introduces floating-point rounding hazards and non-deterministic slippage that detracts from the core invariant problem.
2. **Distributed Raft / Paxos Cluster:** We chose SQLite in WAL mode with deterministic in-process locking over a distributed microservice cluster. A single robust node with serialized writes guarantees ACID atomicity with zero distributed partition anomalies.
3. **Automated AI Money Movements:** We deliberately prohibited AI agents from initiating or moving money autonomously. All money movements require explicit authenticated human authorization.

### Our Integrity & Concurrency Model (In Our Own Words)
Our integrity model treats money as an immutable ledger of balanced postings, never as an editable counter. A balance is merely a cached derived sum of an account's credits and debits ($\sum \text{Credits} - \sum \text{Debits}$).

Concurrency safety is guaranteed through a two-layer defense-in-depth model:
1. *Application-Layer Serialization:* Before any balance is read or updated, the transaction acquires exclusive locks for all affected accounts in alphabetical order. Because locks are ordered canonically, deadlocks are impossible. Because locks are held throughout the transaction, race conditions cannot slip in.
2. *Database-Layer Invariants:* The database schema contains strict `CHECK (balance + overdraft_limit >= 0)` constraints and `CHECK (amount > 0)`. Even if an application lock failed, the database rejects the write.

### How We Used AI & Where It Was Wrong
We utilized AI to assist in boilerplate generation and test scaffolding, while critically verifying every concurrency, integrity, and money-moving routine. As documented in detail in `PROMPTS.md`:
- **AI Error 1 (Concurrency):** The AI generated a naive idempotency lookup that had an in-flight race window; two requests arriving milliseconds apart both proceeded and moved money twice. We caught this and implemented an async in-flight state machine with payload verification.
- **AI Error 2 (Concurrency):** The AI acquired transfer locks in naive source-to-destination order, causing bi-directional deadlocks. We caught this and implemented canonical lexicographical lock ordering.
- **AI Error 3 (Money Integrity):** The AI placed refusal logging inside the money-movement transaction block and threw an exception; SQLite rolled back the transaction and erased the refusal audit records! We caught this and decoupled refusal logging from money rollback boundaries.
- **AI Error 4 (Integrity):** The AI generated a hash chain that omitted sequence contiguity checks, allowing deleted rows to go unnoticed. We fixed this with strict contiguity assertions.

### Unfinished Areas & Future Improvements
- **Continuous WAL Archival:** In production, integration with Litestream for continuous S3 replication of SQLite WAL frames would provide real-time off-site disaster recovery.
- **Scheduled & Batch Payouts:** Implementing a multi-phase batch settlement queue for mass vendor disbursements.
