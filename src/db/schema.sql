-- LedgerLine Double-Entry Ledger Schema
-- Strict financial invariants, non-negative bounds, and append-only immutability

PRAGMA foreign_keys = ON;

-- Users and RBAC roles
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN', 'ACCOUNT_HOLDER', 'AUDITOR')),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Accounts with balances and authorized overdraft limits
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  account_number TEXT UNIQUE NOT NULL,
  user_id TEXT, -- NULL for system clearing accounts
  account_type TEXT NOT NULL CHECK (account_type IN ('CUSTOMER', 'SYSTEM_EXTERNAL_DEPOSIT', 'SYSTEM_EXTERNAL_WITHDRAWAL')),
  balance INTEGER NOT NULL DEFAULT 0, -- Minor units (cents/paise)
  overdraft_limit INTEGER NOT NULL DEFAULT 0 CHECK (overdraft_limit >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'FROZEN', 'CLOSED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT chk_non_negative_balance CHECK (balance + overdraft_limit >= 0)
);

-- High-level business transactions
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('DEPOSIT', 'WITHDRAWAL', 'TRANSFER')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  source_account_id TEXT,
  destination_account_id TEXT,
  initiated_by_user_id TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  description TEXT,
  status TEXT NOT NULL CHECK (status IN ('POSTED', 'REFUSED')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (source_account_id) REFERENCES accounts(id),
  FOREIGN KEY (destination_account_id) REFERENCES accounts(id),
  FOREIGN KEY (initiated_by_user_id) REFERENCES users(id)
);

-- Immutable, append-only double-entry ledger postings with SHA-256 hash chaining
CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  sequence_number INTEGER NOT NULL UNIQUE,
  transaction_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('DEBIT', 'CREDIT')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  resulting_balance INTEGER NOT NULL,
  description TEXT,
  initiated_by_user_id TEXT NOT NULL,
  previous_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id),
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (initiated_by_user_id) REFERENCES users(id)
);

-- Immutable audit log of all refused operations
CREATE TABLE IF NOT EXISTS refused_transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  attempted_amount INTEGER NOT NULL CHECK (attempted_amount >= 0),
  operation_type TEXT NOT NULL CHECK (operation_type IN ('DEPOSIT', 'WITHDRAWAL', 'TRANSFER')),
  counterparty_account_id TEXT,
  reason TEXT NOT NULL,
  running_balance INTEGER NOT NULL,
  initiated_by_user_id TEXT NOT NULL,
  idempotency_key TEXT,
  metadata TEXT, -- JSON string with error details & request headers
  created_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (initiated_by_user_id) REFERENCES users(id)
);

-- Idempotency keys registry with request hash and replay tracking
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  request_path TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PROCESSING', 'COMPLETED', 'FAILED')),
  response_code INTEGER,
  response_body TEXT,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger_entries(account_id);
CREATE INDEX IF NOT EXISTS idx_ledger_tx ON ledger_entries(transaction_id);
CREATE INDEX IF NOT EXISTS idx_ledger_seq ON ledger_entries(sequence_number);
CREATE INDEX IF NOT EXISTS idx_refused_account ON refused_transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_refused_user ON refused_transactions(initiated_by_user_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_user ON idempotency_keys(user_id);

-- Enforce append-only immutability at the SQLite storage layer
-- Any direct UPDATE or DELETE query on ledger_entries or refused_transactions is immediately aborted.

CREATE TRIGGER IF NOT EXISTS trg_prevent_ledger_update
BEFORE UPDATE ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABILITY VIOLATION: ledger_entries is strictly append-only. UPDATE is forbidden.');
END;

CREATE TRIGGER IF NOT EXISTS trg_prevent_ledger_delete
BEFORE DELETE ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABILITY VIOLATION: ledger_entries is strictly append-only. DELETE is forbidden.');
END;

CREATE TRIGGER IF NOT EXISTS trg_prevent_refused_update
BEFORE UPDATE ON refused_transactions
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABILITY VIOLATION: refused_transactions is strictly append-only. UPDATE is forbidden.');
END;

CREATE TRIGGER IF NOT EXISTS trg_prevent_refused_delete
BEFORE DELETE ON refused_transactions
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABILITY VIOLATION: refused_transactions is strictly append-only. DELETE is forbidden.');
END;
