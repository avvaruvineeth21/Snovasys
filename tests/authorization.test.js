const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const testDbPath = path.join(__dirname, 'test_authorization.db');

test('Authorization Boundaries: Users cannot move another user money & Auditors are strictly read-only', async (t) => {
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  process.env.DB_PATH = testDbPath;
  const { getDatabase, closeDatabase } = require('../src/db/database');
  const { seedDatabase } = require('../src/db/seed');
  const { createServer } = require('../src/server');
  const { generateToken } = require('../src/services/authService');

  const db = getDatabase(testDbPath);
  seedDatabase(db);

  const app = createServer();
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const aliceUser = db.prepare("SELECT * FROM users WHERE username = 'alice'").get();
  const bobUser = db.prepare("SELECT * FROM users WHERE username = 'bob'").get();
  const auditorUser = db.prepare("SELECT * FROM users WHERE username = 'auditor'").get();

  const aliceToken = generateToken(aliceUser);
  const auditorToken = generateToken(auditorUser);

  const bobAccount = db.prepare("SELECT * FROM accounts WHERE user_id = 'usr_bob_01'").get();
  const aliceAccount = db.prepare("SELECT * FROM accounts WHERE user_id = 'usr_alice_01'").get();
  const bobStartingBalance = bobAccount.balance;

  // TEST 1: Alice attempts to withdraw from Bob's account
  const withdrawAttempt = await fetch(`${baseUrl}/api/transactions/withdraw`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${aliceToken}`,
      'Idempotency-Key': 'auth_attack_withdraw_' + Date.now()
    },
    body: JSON.stringify({
      accountId: bobAccount.id,
      amount: 5000,
      description: 'Unauthorized theft attempt'
    })
  });

  assert.strictEqual(
    withdrawAttempt.status,
    403,
    `Cross-account withdrawal must be rejected with 403 Forbidden. Got ${withdrawAttempt.status}`
  );

  // Verify Bob's balance was NOT touched
  const bobBalanceAfterWithdraw = db.prepare('SELECT balance FROM accounts WHERE id = ?').get(bobAccount.id);
  assert.strictEqual(bobBalanceAfterWithdraw.balance, bobStartingBalance, 'Bob balance was altered by unauthorized withdrawal!');

  // TEST 2: Alice attempts to transfer FROM Bob's account to Alice's account
  const transferAttempt = await fetch(`${baseUrl}/api/transactions/transfer`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${aliceToken}`,
      'Idempotency-Key': 'auth_attack_transfer_' + Date.now()
    },
    body: JSON.stringify({
      sourceAccountId: bobAccount.id, // Alice does NOT own this
      destinationAccountId: aliceAccount.id,
      amount: 5000,
      description: 'Unauthorized transfer theft attempt'
    })
  });

  assert.strictEqual(
    transferAttempt.status,
    403,
    `Cross-account transfer must be rejected with 403 Forbidden. Got ${transferAttempt.status}`
  );

  // Verify refusal was recorded in refused_transactions
  const loggedRefusals = db.prepare(`
    SELECT * FROM refused_transactions 
    WHERE account_id = ? AND initiated_by_user_id = ? AND reason = 'UNAUTHORIZED_CROSS_ACCOUNT_ACCESS'
  `).all(bobAccount.id, aliceUser.id);

  assert.strictEqual(
    loggedRefusals.length >= 2,
    true,
    'Unauthorized attempts must be logged in the immutable refusal ledger!'
  );

  // TEST 3: Auditor Charlie attempts to execute a money movement
  const auditorTransferAttempt = await fetch(`${baseUrl}/api/transactions/transfer`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${auditorToken}`,
      'Idempotency-Key': 'auditor_write_attempt_' + Date.now()
    },
    body: JSON.stringify({
      sourceAccountId: aliceAccount.id,
      destinationAccountId: bobAccount.id,
      amount: 1000,
      description: 'Auditor unauthorized movement'
    })
  });

  assert.strictEqual(
    auditorTransferAttempt.status,
    403,
    `Auditor must be forbidden from write operations. Got ${auditorTransferAttempt.status}`
  );

  // TEST 4: Auditor CAN read statements, logs, and cryptographic verification
  const auditChainRes = await fetch(`${baseUrl}/api/audit/verify-chain`, {
    headers: { 'Authorization': `Bearer ${auditorToken}` }
  });
  assert.strictEqual(auditChainRes.status, 200, 'Auditor must have read access to verify cryptographic chain.');

  const auditReconRes = await fetch(`${baseUrl}/api/audit/reconciliation`, {
    headers: { 'Authorization': `Bearer ${auditorToken}` }
  });
  assert.strictEqual(auditReconRes.status, 200, 'Auditor must have read access to system reconciliation.');

  // TEST 5: Alice cannot inspect Bob's statement
  const crossStatementRes = await fetch(`${baseUrl}/api/accounts/${bobAccount.id}/statement`, {
    headers: { 'Authorization': `Bearer ${aliceToken}` }
  });
  assert.strictEqual(crossStatementRes.status, 403, 'User cannot view another user statement.');

  server.close();
  closeDatabase();
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
});
