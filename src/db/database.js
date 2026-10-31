const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

let dbInstance = null;

function getDatabase(dbPath = config.dbPath) {
  if (dbInstance) {
    return dbInstance;
  }

  const db = new DatabaseSync(dbPath);
  
  // Configure SQLite for high-performance and strict transactional integrity
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');

  // Initialize schema
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schemaSql);

  // Initialize system accounts if they don't exist
  initSystemAccounts(db);

  dbInstance = db;
  return db;
}

function initSystemAccounts(db) {
  const checkStmt = db.prepare('SELECT id FROM accounts WHERE id = ?');
  const insertAccount = db.prepare(`
    INSERT INTO accounts (id, account_number, user_id, account_type, balance, overdraft_limit, currency, status, created_at, updated_at)
    VALUES (?, ?, NULL, ?, 0, 0, ?, 'ACTIVE', ?, ?)
  `);

  const now = new Date().toISOString();

  // System Cash Inflow account (external counterparty for deposits)
  if (!checkStmt.get(config.systemAccounts.cashInflow)) {
    insertAccount.run(
      config.systemAccounts.cashInflow,
      'SYS-CASH-INFLOW',
      'SYSTEM_EXTERNAL_DEPOSIT',
      config.currency,
      now,
      now
    );
  }

  // System Cash Outflow account (external counterparty for withdrawals)
  if (!checkStmt.get(config.systemAccounts.cashOutflow)) {
    insertAccount.run(
      config.systemAccounts.cashOutflow,
      'SYS-CASH-OUTFLOW',
      'SYSTEM_EXTERNAL_WITHDRAWAL',
      config.currency,
      now,
      now
    );
  }
}

/**
 * Executes a function inside a BEGIN IMMEDIATE SQLite transaction.
 * Automatically commits on return, and rolls back on error.
 */
function runInTransaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback(db);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (rollbackErr) {
      // rollback could fail if connection was closed or already rolled back
    }
    throw error;
  }
}

function closeDatabase() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

module.exports = {
  getDatabase,
  runInTransaction,
  closeDatabase
};
