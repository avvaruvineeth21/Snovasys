# PROMPTS.md — Engineering Log: Directing AI & Catching Critical Flaws

This document details interactions with AI code generation tools during the development of LedgerLine between October 31, 2026 and November 6, 2026. Each entry documents what was requested, what the model produced, the precise architectural or financial integrity flaw in the generated code, and how it was diagnosed and corrected.

---

### Entry 1 — October 31, 2026
- **What I asked the tool to do:**
  Design the initial SQLite database schema for LedgerLine accounts and transactions, including balances, overdraft limits, and ledger entries.
- **What it produced:**
  The model generated a schema where `balance REAL DEFAULT 0.00` and `amount REAL NOT NULL` were represented as SQLite floating-point `REAL` columns. It also generated a single-entry table with columns `from_account_id` and `to_account_id` and a naive balance update: `UPDATE accounts SET balance = balance - amount WHERE id = from_account_id`.
- **What was specifically wrong with it:**
  1. *Floating-Point Precision Loss:* Financial amounts must never be represented as IEEE 754 floating-point numbers. Over millions of transactions, fractional rounding errors (`0.1 + 0.2 = 0.30000000000000004`) lead to penny-shaving discrepancies and break the fundamental invariant that the books must balance to the exact cent.
  2. *Single-Entry Vulnerability:* In single-entry accounting, external deposits and withdrawals have no immutable counterparty; creating money requires updating an account with no equal and opposite debit to an external clearing account.
- **What I did instead:**
  1. Migrated all monetary representations to 64-bit integer minor units (cents/paise): `balance INTEGER NOT NULL DEFAULT 0` and `amount INTEGER NOT NULL CHECK (amount > 0)`.
  2. Redesigned the architecture to strict **Double-Entry Accounting**. Created two dedicated system clearing accounts (`SYSTEM_CASH_INFLOW` and `SYSTEM_CASH_OUTFLOW`). Every transaction writes at least two balanced ledger postings ($\sum \text{debits} - \sum \text{credits} = 0$).
  3. Added SQL CHECK constraints `CHECK (balance + overdraft_limit >= 0)` and triggers preventing updates or deletions on ledger rows.
- **Commit reference:**
  Commit `e68205d` (Day 1: `feat(core): initialize double-entry schema, SQLite WAL, and base models`)

---

### Entry 2 — November 1, 2026
- **What I asked the tool to do:**
  Implement an idempotency service with an `idempotency_keys` table to guarantee that retried transfer requests do not execute twice.
- **What it produced (Money / Concurrency Logic):**
  The model provided a simple middleware that checked:
  ```javascript
  const existing = db.prepare('SELECT response_json FROM idempotency_keys WHERE key = ?').get(key);
  if (existing) {
    return res.json(JSON.parse(existing.response_json));
  }
  // Proceed with transaction...
  const result = await executeTransfer(...);
  db.prepare('INSERT INTO idempotency_keys (key, response_json) VALUES (?, ?)').run(key, JSON.stringify(result));
  return res.json(result);
  ```
- **What was specifically wrong with it (Critical Concurrency & Replay Vulnerability):**
  1. *In-Flight Race Window:* If two identical requests with the same idempotency key arrive within 5ms of each other (e.g., an aggressive HTTP client retry or rapid double-click before network ACK), Request 2 queries the database while Request 1 is still in flight. Because Request 1 has not yet inserted the key into the database, Request 2 sees no record and proceeds to execute the transfer a second time! The money is transferred twice.
  2. *Parameter Mismatch Attack:* The model's code did not validate the request body against the key. An attacker could use a key from a $1 transfer and resubmit it with a $10,000 transfer, or replay a vendor payment to a personal account.
- **What I did instead:**
  1. Implemented a three-state machine for idempotency keys: `PROCESSING`, `COMPLETED`, and `FAILED`.
  2. When Request 1 arrives, it immediately registers the key as `PROCESSING` inside the database.
  3. If Request 2 arrives while Request 1 is still `PROCESSING`, Request 2 does *not* execute; instead, it subscribes to an async condition event (`inFlightEvents.once('completed:' + key)`) and awaits Request 1's completion.
  4. Implemented canonical request payload hashing: `request_hash = SHA256(path + ':' + JSON.stringify(sortedBody))`. If a request attempts to reuse a key with altered parameters, it is immediately rejected with HTTP `422 Unprocessable Entity`.
  5. Added `duplicate_count` tracking in `idempotency_keys` to prove to auditors which requests were intercepted replays.
- **Commit reference:**
  Commit `ee4d31d` (Day 2: `feat(idempotency): implement idempotency engine with in-flight lock and replay tracking`)

---

### Entry 3 — November 2, 2026
- **What I asked the tool to do:**
  Implement resource locking for multi-account transfers to prevent race conditions during concurrent money movement.
- **What it produced (Money / Concurrency Logic):**
  The model created an asynchronous keyed mutex with an `acquireLock(accountId)` helper, and locked accounts sequentially in the transfer service:
  ```javascript
  async function executeTransfer({ sourceAccountId, destinationAccountId, amount }) {
    const unlockSource = await lockService.acquire(sourceAccountId);
    const unlockDest = await lockService.acquire(destinationAccountId);
    try {
      // Execute transfer inside transaction...
    } finally {
      unlockDest();
      unlockSource();
    }
  }
  ```
- **What was specifically wrong with it (Deadlock Vulnerability):**
  This is the textbook Dining Philosophers deadlock flaw.
  If User A transfers $50 to User B at the exact same millisecond that User B transfers $50 to User A:
  - Thread 1 acquires `acc_alice` and requests `acc_bob`.
  - Thread 2 acquires `acc_bob` and requests `acc_alice`.
  Both threads hang indefinitely waiting on each other's lock. Under heavy production load, connection pools exhaust and the service crashes.
- **What I did instead:**
  1. Implemented Canonical Lexicographical Lock Ordering (Dijkstra's Resource Hierarchy).
  2. Replaced sequential locking with `lockService.withLocks([sourceAccountId, destinationAccountId], callback)`.
  3. Inside `acquireMany(keys)`:
     ```javascript
     const uniqueSortedKeys = [...new Set(keys.filter(Boolean))].sort();
     ```
     Locks are *always* acquired in strictly sorted lexicographical order (`acc_alice` is always locked before `acc_bob`, regardless of transfer direction).
  4. Guaranteed deadlock impossibility across any number of concurrent bi-directional transfers.
- **Commit reference:**
  Commit `0be52b6` (Day 3: `feat(concurrency): add deterministic two-phase locking and atomic money movements`)

---

### Entry 4 — November 3, 2026
- **What I asked the tool to do:**
  Log refused transactions (insufficient funds, account frozen, overdraft exceeded) into the audit statement so that refused attempts appear alongside debits and credits as required by the specification.
- **What it produced (Money Integrity / Audit Trail Flaw):**
  The model wrapped the transaction check and refusal recording directly inside `runInTransaction`:
  ```javascript
  return runInTransaction(db, (txDb) => {
    const account = txDb.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    if (amount > account.balance + account.overdraft_limit) {
      recordRefusal(txDb, { accountId, attemptedAmount: amount, reason: 'INSUFFICIENT_FUNDS', ... });
      throw new LedgerError('Withdrawal refused: Insufficient funds.', 400);
    }
    // Debit account...
  });
  ```
- **What was specifically wrong with it (Audit Deletion Flaw):**
  When `LedgerError` is thrown, `runInTransaction` catches the error and executes `txDb.exec('ROLLBACK')`.
  Because `recordRefusal` was executed on `txDb` inside that very same transaction, the `ROLLBACK` completely wiped out the refusal row from SQLite!
  As a result:
  - The refusal was never saved.
  - The customer statement showed zero record of the attempted overdraft.
  - Auditors could not see who attempted to overdraw the account.
  This directly violated Requirement 8 ("a per-account statement: every debit, every credit, and every refused attempt").
- **What I did instead:**
  1. Decoupled the refusal audit log from the money-movement rollback boundary.
  2. While holding the account's mutex lock, the system checks account balances and statuses. If business rules are violated, it records and commits the refusal record into `refused_transactions` outside the rolled-back money movement block.
  3. Verified via automated test `tests/concurrency_race.test.js`: firing 10 concurrent requests of $100 against a $100 balance asserts that exactly 1 succeeds and all 9 refused attempts are permanently logged and returned in the statement.
- **Commit reference:**
  Commit `0e56d81` (Day 4: `feat(ledger): per-account statements, immutable refusal audit, and RBAC`)

---

### Entry 5 — November 4, 2026
- **What I asked the tool to do:**
  Implement a tamper-evident cryptographic hash chain on `ledger_entries` so an auditor can mathematically prove that no historical rows have been altered or deleted.
- **What it produced:**
  The model generated a function that computed `SHA256(prevHash + entry.amount + entry.account_id)` and a verification script that looped through rows:
  ```javascript
  function verifyChain(db) {
    const rows = db.prepare('SELECT * FROM ledger_entries').all();
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].previous_hash !== rows[i - 1].entry_hash) return false;
    }
    return true;
  }
  ```
- **What was specifically wrong with it (Security / Sequence Gap Exploit):**
  1. *Omission of Sequence Number & Identifiers:* The hash did not bind the entry's unique ID, transaction ID, sequence number, resulting balance, or timestamp. An attacker could swap two ledger entries or duplicate a credit without invalidating the hash formula if the amounts were identical.
  2. *Sequence Gap Vulnerability:* The query did not order by sequence number (`ORDER BY sequence_number ASC`), nor did it assert sequence contiguity ($seq_n = seq_{n-1} + 1$). If an insider deleted sequence #4 and altered sequence #5's previous_hash pointer, the loop would verify rows [1, 2, 3, 5] as "valid" because it never checked for missing sequence numbers!
  3. *Empty Ledger Edge Case:* The model did not establish a fixed Genesis block hash pointer, leaving the chain anchor unverified.
- **What I did instead:**
  1. Established a fixed 64-character Genesis hash: `0000000000000000000000000000000000000000000000000000000000000000`.
  2. Structured the cryptographic hash to seal every critical ledger field:
     `SHA256(previousHash : id : sequenceNumber : transactionId : accountId : entryType : amount : resultingBalance : createdAt)`.
  3. Rewrote `verifyLedgerChain` to strictly assert:
     - Sequence contiguity: `entry.sequence_number === expectedSequence`.
     - Hash pointer integrity: `entry.previous_hash === expectedPreviousHash`.
     - Full re-computation of SHA-256 hash for every row against raw database values.
  4. Added `tests/immutability.test.js` to simulate database tampering and verify that sequence gaps and row edits are caught with 100% precision.
- **Commit reference:**
  Commit `6d94c12` (Day 5: `feat(integrity): cryptographic SHA-256 hash chaining and reconciliation verifier`)
