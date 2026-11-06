const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

// We use an isolated test database for concurrency race test
const testDbPath = path.join(__dirname, 'test_concurrency.db');

test('Concurrency Safety: Simultaneous race attacks cannot overdraw an account', async (t) => {
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  process.env.DB_PATH = testDbPath;
  const { getDatabase, closeDatabase } = require('../src/db/database');
  const { seedDatabase } = require('../src/db/seed');
  const { executeWithdrawal, getAccountStatement } = require('../src/services/ledgerService');

  const db = getDatabase(testDbPath);
  seedDatabase(db);

  // Setup: Create a test account with exactly $100 (10,000 cents) and $0 overdraft
  const accId = 'acc_race_victim';
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO accounts (id, account_number, user_id, account_type, balance, overdraft_limit, currency, status, created_at, updated_at)
    VALUES (?, 'ACT-RACE-001', 'usr_alice_01', 'CUSTOMER', 10000, 0, 'USD', 'ACTIVE', ?, ?)
  `).run(accId, now, now);

  // Attack: 10 concurrent requests, each attempting to withdraw the full $100 (10,000 cents)
  // Total attempted: $1,000 against a $100 balance.
  const CONCURRENT_REQUESTS = 10;
  const WITHDRAWAL_AMOUNT = 10000;

  const withdrawalPromises = Array.from({ length: CONCURRENT_REQUESTS }, (_, idx) => {
    return executeWithdrawal({
      accountId: accId,
      amount: WITHDRAWAL_AMOUNT,
      description: `Race withdrawal attempt #${idx + 1}`,
      initiatedByUserId: 'usr_alice_01',
      idempotencyKey: `race_key_${idx + 1}`,
      db
    }).then(
      (res) => ({ success: true, result: res }),
      (err) => ({ success: false, error: err.message, refusal: err.details })
    );
  });

  const results = await Promise.all(withdrawalPromises);

  const successfulWithdrawals = results.filter(r => r.success);
  const failedWithdrawals = results.filter(r => !r.success);

  // VERIFICATION 1: Exactly one withdrawal succeeded
  assert.strictEqual(
    successfulWithdrawals.length,
    1,
    `CRITICAL CONCURRENCY FAILURE: Exactly 1 withdrawal must succeed. Instead ${successfulWithdrawals.length} succeeded.`
  );

  // VERIFICATION 2: Exactly 9 withdrawals were refused
  assert.strictEqual(
    failedWithdrawals.length,
    CONCURRENT_REQUESTS - 1,
    `Refusal count mismatch: expected ${CONCURRENT_REQUESTS - 1}, got ${failedWithdrawals.length}`
  );

  // VERIFICATION 3: Final account balance must be strictly $0 (0 cents), NEVER negative
  const finalAccount = db.prepare('SELECT balance FROM accounts WHERE id = ?').get(accId);
  assert.strictEqual(
    finalAccount.balance,
    0,
    `BALANCE INTEGRITY VIOLATION: Final balance is ${finalAccount.balance}, expected 0.`
  );

  // VERIFICATION 4: Per-account statement records the 1 successful debit and 9 refused attempts
  const statementData = getAccountStatement(accId, db);
  assert.strictEqual(statementData.postedCount, 1, 'Statement must contain exactly 1 posted debit.');
  assert.strictEqual(statementData.refusedCount, 9, 'Statement must contain exactly 9 refused attempts.');

  closeDatabase();
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
});
