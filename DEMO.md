# DEMO.md — LedgerLine 5-Minute Evaluation Video Script & Walkthrough

This document outlines the scene-by-scene script and execution guide for the LedgerLine demonstration video.

---

## Video Outline & Timecodes

| Timestamp | Section | Key Focus |
| :--- | :--- | :--- |
| **00:00 - 00:45** | System Architecture & Non-Negotiable Invariants | Double-entry clearing accounts, integer minor units, and mathematical conservation. |
| **00:45 - 01:45** | Concurrency Attack Demonstration | Simulating 10 concurrent withdrawals of $100 against a $100 balance; race defense. |
| **01:45 - 02:45** | Idempotency & In-Flight Replay Protection | Double-click transfer test, duplicate tracking, and parameter mismatch rejection. |
| **02:45 - 03:45** | RBAC Boundaries & Per-Account Statement | Cross-account theft attempt rejection, refusal logging, running balances. |
| **03:45 - 04:30** | Cryptographic Ledger Proof & Invariant Reconciliation | Walking the SHA-256 Merkle chain, proving zero row modifications or deletions. |
| **04:30 - 05:00** | Code Walkthrough & Closing | Reviewing atomic locks and SQL check constraints in `ledgerService.js`. |

---

## Detailed Scene-by-Scene Script

### Scene 1: Introduction & Architecture (00:00 - 00:45)
- **Visual:** Open browser to `http://localhost:3000`. Show the dark-mode fintech interface and the top invariant banner: `"Books Balanced: Holding $1,750.00 conserved"`.
- **Narrator:**
  > "Welcome to LedgerLine — a money movement engine built around a simple truth: financial software is not CRUD; it is an integrity and concurrency problem.
  > In LedgerLine, every single rupee is accounted for. We model money as double-entry debits and credits in 64-bit integer minor units. External deposits enter through an immutable system clearing account; external withdrawals exit through a clearing account. The invariant that the sum of all customer balances equals net external cash flow is enforced by mathematical proof and audited on every turn."

### Scene 2: Concurrency Attack (The "Two Withdrawals at Once" Race) (00:45 - 01:45)
- **Visual:** Click quick-role button **"👤 Account Holder (Alice)"**. Show Alice's Checking Account (`ACT-ALICE-101`) with a current balance of $1,000.00.
- **Action:** Open terminal and run `node --test tests/concurrency_race.test.js`.
- **Narrator:**
  > "Let's attack it. A judge's classic attack is firing multiple withdrawals at the same millisecond to overdraw an account.
  > Here in our automated test, an account has exactly $100. We spawn 10 concurrent requests simultaneously, each demanding the full $100 — an attempted $1,000 drain.
  > Because of our canonical keyed mutex locks and SQLite's immediate transactions, exactly one request succeeds. The other nine are atomically refused. The balance ends at exactly $0.00 — never negative.
  > Furthermore, the database enforces `CHECK (balance + overdraft_limit >= 0)`. Even if our application code were stripped, the database engine guarantees non-negativity."

### Scene 3: Idempotency & In-Flight Replays (01:45 - 02:45)
- **Visual:** On the Web UI dashboard, fill out the Transfer form:
  - Source: Alice Checking (`ACT-ALICE-101`)
  - Destination: Bob Operating (`ACT-BOB-201`)
  - Amount: `$50.00`
  - Idempotency Key: `idem_demo_click_001`
- **Action:** Click **"⚡ Simulate Double-Click / Race"**.
- **Narrator:**
  > "Now let's examine idempotency. We click our 'Simulate Double-Click' button, which fires two identical HTTP requests with the exact same idempotency key at the exact same millisecond.
  > Notice the result: Request 1 executes the $50 transfer. Request 2 catches the in-flight lock, waits, sees the completed response, and returns the identical answer with header `X-Idempotency-Replay: true`.
  > Alice was debited $50 once; Bob was credited $50 once. Duplicate count in the database is recorded as 1."

### Scene 4: Authorization Boundaries & Per-Account Statement (02:45 - 03:45)
- **Visual:** Switch to **"📜 Account Statement"** tab.
- **Narrator:**
  > "Requirement 8 mandates an exhaustive per-account statement showing every debit, every credit, and every refused attempt with resulting running balances.
  > Notice this refusal: an attempt to transfer funds without authorization or exceeding funds. LedgerLine preserves 100% of refused attempts in an immutable refusal log.
  > Let's test authorization: Alice tries to move money from Bob's account. The server intercepts it, returns HTTP 403 Forbidden, and writes an immutable audit record: `UNAUTHORIZED_CROSS_ACCOUNT_ACCESS`."

### Scene 5: Cryptographic Ledger Proof & Auditor Console (03:45 - 04:30)
- **Visual:** Switch role to **"🛡️ Auditor (Charlie)"** and open the **"🛡️ Ledger Proof & Audit"** tab.
- **Action:** Click **"🔍 Verify Entire Chain"**.
- **Narrator:**
  > "Auditors have read-only assurance access. They can never move money, but they can verify cryptographic integrity.
  > Every ledger entry is linked in a SHA-256 Merkle chain back to genesis. When we click 'Verify Entire Chain', the system recalculates every hash and asserts sequence contiguity.
  > If a malicious DBA used raw disk tools to alter a single ledger entry or delete a row, the cryptographic chain breaks immediately and flags the corrupted sequence. Furthermore, SQLite triggers reject any SQL `UPDATE` or `DELETE` at the engine level."

### Scene 6: Invariant Reconciliation & Code Inspection (04:30 - 05:00)
- **Visual:** Show the Reconciliation proof breakdown:
  - `Total Customer Balances ($1,750.00) = External Inflows ($1,750.00) - External Outflows ($0.00) (Δ = 0)`
  - `Double-Entry Balance: Debits ($1,750.00) == Credits ($1,750.00) (Δ = 0)`
- **Narrator:**
  > "Here is our global reconciliation proof: every rupee created externally matches customer balances to the cent.
  > LedgerLine proves what happened, prevents double-spend under concurrency, and keeps the books balanced under all conditions. Thank you."
