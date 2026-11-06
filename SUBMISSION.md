# LedgerLine — Final Evaluation Submission Document

This document contains the ready-to-submit text for each box on the evaluation portal.

---

## 📌 Header Fields

### Project Title
```text
LedgerLine — Money Movement with a Ledger You Can Prove
```

### One-Line Description / Summary
```text
A double-entry financial settlement engine with deterministic concurrency locking, in-flight idempotency replay protection, cryptographic SHA-256 Merkle chain verification, and mathematical money conservation.
```

### Contact
```text
Avvaru Vineeth (panduvineeth42@gmail.com)
```

### GitHub Repository Link
```text
https://github.com/<your-username>/Syn
```
*(Ensure repository visibility is set to **Public**)*

### Live Website Link
```text
https://<your-deployed-service>.onrender.com
```
*(Deploy via Render / Railway / Fly using the included Dockerfile or Node.js runtime)*

---

## 📝 The Six Submission Questions

### Box 1: The problem you solved, in your own words.
```text
Financial applications are frequently built as CRUD systems, but money movement is fundamentally a distributed concurrency and integrity problem. In naive systems, two concurrent withdrawals race, both check the balance, both see sufficient funds, and both debit the account—driving it negative. When network requests time out and retry, double-clicks create duplicate payments. If an internal transfer fails midway, money is either created out of thin air or destroyed. And when balances mismatch, audit trails lack the cryptographic proof or refusal records to prove who moved what and when.

I built LedgerLine to solve this decisively: a financial ledger where internal transfers net to zero, external flows balance to the penny, duplicate requests never pay twice, concurrent races cannot overdraw or corrupt accounts, and every debit, credit, and refused attempt is cryptographically sealed in an append-only, tamper-evident hash chain.
```

---

### Box 2: What actually works right now. Be specific and honest.
```text
The following capabilities are fully built, verified, and backed by automated attack tests:

1. Double-Entry Invariant: Money is modeled strictly as 64-bit integer minor units (cents). Every transaction creates equal and opposite postings (Σ Debits - Σ Credits = 0). External deposits and withdrawals balance against immutable clearing accounts (SYSTEM_CASH_INFLOW, SYSTEM_CASH_OUTFLOW).
2. Non-Negative Floor: No account can drop below zero unless an explicit overdraft limit is authorized. Enforced server-side and protected by SQLite's CHECK (balance + overdraft_limit >= 0) constraint.
3. In-Flight Idempotency: All money-moving requests require an Idempotency-Key. If an identical request arrives while the first is in-flight, it awaits the result rather than executing in parallel. Replays return the cached response with X-Idempotency-Replay: true. The database tracks duplicate_count to prove replays to auditors. Parameter mismatch attacks (reusing a key with altered amounts or recipients) are rejected with HTTP 422.
4. Concurrency Safety: Multi-account transfers use Canonical Lexicographical Lock Ordering ([src, dst].sort()), making deadlocks mathematically impossible. Concurrent race attacks on an account are serialized atomically.
5. Per-Account Statements: Emits an exhaustive chronological statement for every account containing every debit, credit, and REFUSED attempt (insufficient funds, overdraft limit exceeded, unauthorized cross-account access) with running balance and user attribution.
6. Server-Side RBAC: Three distinct roles (ADMIN, ACCOUNT_HOLDER, AUDITOR). Account holders can only move money from accounts they own. Auditors have strictly read-only access.
7. Cryptographic Merkle Hash Chain: Every ledger row links to its predecessor via SHA-256. Database triggers abort any direct SQL UPDATE or DELETE queries. The /api/audit/verify-chain endpoint walks the chain from genesis to head and proves zero row alterations or sequence gaps.
8. Single-Page Application: A responsive web dashboard with live account cards, transfer forms, double-click race simulators, statement explorers with refusal filters, and auditor verification consoles.
```

---

### Box 3: How to run it on our machine. The exact commands - we will try them.
```bash
# 1. Clone the repository
git clone <your-repo-url>
cd Syn

# 2. Install dependencies
npm install
# (Note: On Windows PowerShell if script execution is restricted, use: npm.cmd install)

# 3. Run the automated test suite (runs all 5 attack and concurrency suites)
npm test
# (On Windows PowerShell: npm.cmd test)

# 4. Start the server
npm start
# (On Windows PowerShell: npm.cmd start)

# 5. Open http://localhost:3000 in your browser
```

**Seed Credentials Pre-Loaded in Database:**
- **Administrator:** `admin` / `AdminPass123!` (Alex Rivera)
- **Account Holder 1:** `alice` / `AlicePass123!` (Alice Henderson — Accounts: `ACT-ALICE-101` [\$1,000.00], `ACT-ALICE-102` [\$500.00 with \$200.00 overdraft])
- **Account Holder 2:** `bob` / `BobPass123!` (Bob Martinez — Account: `ACT-BOB-201` [\$250.00])
- **Auditor (Read-Only):** `auditor` / `AuditorPass123!` (Charlie Audit)

*(In the Web UI, use the top "⚡ Evaluator Quick Roles" buttons to switch between accounts with one click).*
```

---

### Box 4: Which AI tools you used.
```text
Google Antigravity with Gemini 3.8 Flash (High) and Gemini Pro. Used for rapid architectural scaffolding, schema design, and test suite generation, with rigorous code review and manual fixes applied to all concurrency and financial integrity boundaries.
```

---

### Box 5: What the AI got wrong, and what you fixed yourself. (25 of the 100 marks!)
```text
I caught and fixed four critical flaws where the AI produced confident, broken code that would have caused deadlocks, lost audit trails, and double-spent money:

1. In-Flight Idempotency Race (Money / Concurrency Logic):
The AI generated a naive idempotency check that merely queried the database for a finished response. If two identical requests arrived 5ms apart (before the first finished writing), Request 2 found no record and proceeded to execute concurrently—transferring the money twice!
Fix: I implemented a three-state machine (PROCESSING, COMPLETED, FAILED). Request 1 immediately registers the key as PROCESSING. Request 2 catches the in-flight state and subscribes to an async condition event (inFlightEvents.once), returning the cached result once Request 1 resolves. I also added SHA-256 canonical payload hashing to reject parameter mismatch attacks. (Documented in PROMPTS.md Entry 2).

2. Multi-Account Bi-Directional Deadlock (Concurrency Logic):
The AI acquired mutex locks sequentially in source-to-destination order. When User A transferred to User B at the same millisecond User B transferred to User A, Thread 1 held A waiting for B while Thread 2 held B waiting for A, deadlocking both threads indefinitely.
Fix: I implemented Canonical Lexicographical Lock Ordering (Dijkstra's Resource Hierarchy). Locks are always sorted ([src, dst].sort()) prior to acquisition, ensuring all threads acquire resources in identical order and eliminating deadlocks. (Documented in PROMPTS.md Entry 3).

3. Refusal Audit Trail Rollback Eradication (Money Integrity Logic):
The AI placed refusal logging inside the money-movement database transaction block and threw a LedgerError on insufficient funds. The transaction handler caught the error and issued txDb.exec('ROLLBACK')—which rolled back and erased the refusal record from SQLite! Customer statements and auditors showed zero record of the attempted overdraft.
Fix: I decoupled refusal audit logging from the money rollback boundary. The system validates balances while holding the account mutex and commits the refusal directly to refused_transactions outside any rolled-back transaction. (Documented in PROMPTS.md Entry 4).

4. Cryptographic Hash Chain Sequence Gap Exploit (Integrity Logic):
The AI wrote a hash chaining function that did not bind unique entry IDs, sequence numbers, or timestamps, and did not assert sequence contiguity (seq_n = seq_{n-1} + 1). If an insider deleted row #4 and pointed row #5's previous_hash to row #3, the AI's verifier reported the chain as valid.
Fix: I bound all transaction fields into the hash payload and rewrote verifyLedgerChain to enforce strict sequence contiguity from Genesis (64 zeros) to Head, detecting any row deletions, insertions, or tampering. (Documented in PROMPTS.md Entry 5).
```

---

### Box 6: What is not finished. Saying this honestly scores better than hiding them.
```text
In the interest of full engineering transparency:

1. In-Process Mutex vs. Distributed Multi-Node Clustering:
The current locking service (LockService) uses an in-memory keyed mutex designed for a single instance or sticky-session routing. While SQLite's WAL mode and single-writer architecture prevent database corruption even across multiple processes, scaling horizontally across multiple stateless Kubernetes pods would require replacing the in-process mutex with a distributed lease (e.g., Redis Redlock or Postgres SELECT FOR UPDATE).

2. Continuous Off-Site WAL Archival:
While SQLite triggers and cryptographic hash chains protect the ledger from in-place tampering and deletion, the system does not yet bundle automated real-time replication (such as Litestream streaming WAL frames to AWS S3/GCS) for catastrophic hardware failure recovery.

3. Multi-Currency FX Conversions:
All accounts currently operate in USD minor units (cents). Support for dynamic currency exchange (e.g., USD to EUR or INR) was deliberately omitted to prevent foreign exchange rate slippage and IEEE 754 floating-point conversion rounding discrepancies from corrupting the exact integer conservation invariant.

4. Recurring & Scheduled Batch Transfers:
Transfers are executed on-demand in real-time. A background queue for bulk scheduled payroll runs (e.g., executing 500 vendor payouts in a scheduled batch) has not yet been built.
```
