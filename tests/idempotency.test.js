const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const testDbPath = path.join(__dirname, 'test_idempotency.db');

test('Idempotency: Replayed requests move money once, return identical responses, and track duplicates', async (t) => {
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
  const token = generateToken(aliceUser);

  const bobAccount = db.prepare("SELECT * FROM accounts WHERE user_id = 'usr_bob_01'").get();
  const aliceAccount = db.prepare("SELECT * FROM accounts WHERE user_id = 'usr_alice_01'").get();

  const startingAliceBalance = aliceAccount.balance;
  const startingBobBalance = bobAccount.balance;

  const idempotencyKey = 'idem_replay_test_' + Date.now();
  const transferAmount = 2500; // $25.00

  // 1. Fire 15 concurrent requests with IDENTICAL idempotency key
  const requests = Array.from({ length: 15 }, () => {
    return fetch(`${baseUrl}/api/transactions/transfer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify({
        sourceAccountId: aliceAccount.id,
        destinationAccountId: bobAccount.id,
        amount: transferAmount,
        description: 'Vendor payment'
      })
    });
  });

  const responses = await Promise.all(requests);
  const responseDataList = await Promise.all(responses.map(r => r.json()));

  // All 15 requests should return 200 OK
  for (let i = 0; i < responses.length; i++) {
    assert.strictEqual(responses[i].status, 200, `Request #${i + 1} failed with status ${responses[i].status}`);
  }

  // All 15 responses must have identical transaction ID
  const primaryTxId = responseDataList[0].transaction.transactionId;
  for (let i = 1; i < responseDataList.length; i++) {
    assert.strictEqual(
      responseDataList[i].transaction.transactionId,
      primaryTxId,
      'Replayed requests returned different transaction IDs!'
    );
  }

  // 2. VERIFY MONEY MOVED EXACTLY ONCE
  const finalAlice = db.prepare('SELECT balance FROM accounts WHERE id = ?').get(aliceAccount.id);
  const finalBob = db.prepare('SELECT balance FROM accounts WHERE id = ?').get(bobAccount.id);

  assert.strictEqual(
    finalAlice.balance,
    startingAliceBalance - transferAmount,
    `Alice debited incorrectly! Expected ${startingAliceBalance - transferAmount}, got ${finalAlice.balance}`
  );
  assert.strictEqual(
    finalBob.balance,
    startingBobBalance + transferAmount,
    `Bob credited incorrectly! Expected ${startingBobBalance + transferAmount}, got ${finalBob.balance}`
  );

  // 3. VERIFY DUPLICATE TRACKING IN DATA
  const idemRecord = db.prepare('SELECT * FROM idempotency_keys WHERE key = ?').get(idempotencyKey);
  assert.strictEqual(idemRecord.status, 'COMPLETED');
  assert.strictEqual(
    idemRecord.duplicate_count,
    14, // 1 primary + 14 replayed duplicates
    `Duplicate count mismatch: expected 14, got ${idemRecord.duplicate_count}`
  );

  // 4. PARAMETER MISMATCH ATTACK TEST
  // Attempt to reuse the SAME idempotency key with different amount
  const mismatchRes = await fetch(`${baseUrl}/api/transactions/transfer`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Idempotency-Key': idempotencyKey
    },
    body: JSON.stringify({
      sourceAccountId: aliceAccount.id,
      destinationAccountId: bobAccount.id,
      amount: 999999, // Mismatched parameter!
      description: 'Vendor payment'
    })
  });

  assert.strictEqual(
    mismatchRes.status,
    422,
    `Expected 422 Unprocessable Entity for mismatched parameters, got ${mismatchRes.status}`
  );

  server.close();
  closeDatabase();
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
});
