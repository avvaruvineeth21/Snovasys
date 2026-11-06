const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const testDbPath = path.join(__dirname, 'test_immutability.db');

test('Ledger Immutability & Cryptographic Hash Chain Proof', async (t) => {
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  process.env.DB_PATH = testDbPath;
  const { getDatabase, closeDatabase } = require('../src/db/database');
  const { seedDatabase } = require('../src/db/seed');
  const { verifyLedgerChain } = require('../src/db/ledgerChain');
  const { recordRefusal } = require('../src/services/ledgerService');

  const db = getDatabase(testDbPath);
  seedDatabase(db);

  // 1. Verify that initial ledger chain is 100% valid
  const initialVerification = verifyLedgerChain(db);
  assert.strictEqual(initialVerification.valid, true);
  assert.strictEqual(initialVerification.totalEntries >= 6, true);

  // 2. TRIGGER DEFENSE: Attempt direct SQL UPDATE on ledger_entries
  const firstEntry = db.prepare('SELECT id, amount FROM ledger_entries LIMIT 1').get();
  assert.throws(
    () => {
      db.prepare('UPDATE ledger_entries SET amount = 999999 WHERE id = ?').run(firstEntry.id);
    },
    /IMMUTABILITY VIOLATION: ledger_entries is strictly append-only/,
    'Database trigger must forbid UPDATE on ledger_entries'
  );

  // 3. TRIGGER DEFENSE: Attempt direct SQL DELETE on ledger_entries
  assert.throws(
    () => {
      db.prepare('DELETE FROM ledger_entries WHERE id = ?').run(firstEntry.id);
    },
    /IMMUTABILITY VIOLATION: ledger_entries is strictly append-only/,
    'Database trigger must forbid DELETE on ledger_entries'
  );

  // 4. TRIGGER DEFENSE: Attempt direct SQL UPDATE on refused_transactions
  const refusalRecord = recordRefusal(db, {
    accountId: 'acc_alice_main',
    attemptedAmount: 500,
    operationType: 'WITHDRAWAL',
    reason: 'TEST_REFUSAL',
    runningBalance: 1000,
    initiatedByUserId: 'usr_alice_01'
  });

  assert.throws(
    () => {
      db.prepare("UPDATE refused_transactions SET reason = 'ALTERED' WHERE id = ?").run(refusalRecord.refusalId);
    },
    /IMMUTABILITY VIOLATION: refused_transactions is strictly append-only/,
    'Database trigger must forbid UPDATE on refused_transactions'
  );

  // 5. CRYPTOGRAPHIC PROOF: Simulate Raw File / Root Disk Tampering
  // Drop trigger to simulate root attacker who bypassed SQLite triggers by hex-editing the DB file
  db.exec('DROP TRIGGER trg_prevent_ledger_update;');
  db.prepare('UPDATE ledger_entries SET amount = amount + 500 WHERE id = ?').run(firstEntry.id);

  // Run the cryptographic chain verifier
  const tamperedVerification = verifyLedgerChain(db);
  assert.strictEqual(
    tamperedVerification.valid,
    false,
    'Cryptographic verifier must catch altered ledger entry!'
  );
  assert.strictEqual(
    tamperedVerification.error.includes('Cryptographic hash corruption detected'),
    true,
    'Verifier must pinpoint cryptographic corruption!'
  );

  closeDatabase();
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
});
