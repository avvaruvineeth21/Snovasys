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
  Commit `f4e191a` (Day 1: `feat(core): initialize double-entry schema, SQLite WAL, and base models`)
