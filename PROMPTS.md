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
  Commit `3c8d92b` (Day 2: `feat(idempotency): implement idempotency engine with in-flight lock and replay tracking`)
