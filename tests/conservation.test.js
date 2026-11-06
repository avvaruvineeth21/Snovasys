const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const testDbPath = path.join(__dirname, 'test_conservation.db');

test('Conservation Invariant: Money is mathematically conserved across random concurrent movements', async (t) => {
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  process.env.DB_PATH = testDbPath;
  const { getDatabase, closeDatabase } = require('../src/db/database');
  const { seedDatabase } = require('../src/db/seed');
  const { executeDeposit, executeWithdrawal, executeTransfer, reconcileSystem } = require('../src/services/ledgerService');

  const db = getDatabase(testDbPath);
  seedDatabase(db);

  // Accounts available from seed:
  // acc_alice_main, acc_alice_payroll, acc_bob_main
  const accounts = ['acc_alice_main', 'acc_alice_payroll', 'acc_bob_main'];

  // Record starting reconciliation
  const initialRecon = reconcileSystem(db);
  assert.strictEqual(initialRecon.isHealthy, true, 'Initial state must be 100% reconciled');

  // Spawn 40 concurrent operations with random amounts and destinations
  const operations = [];

  for (let i = 0; i < 40; i++) {
    const opType = i % 3; // 0: deposit, 1: transfer, 2: withdraw
    const amount = Math.floor(Math.random() * 5000) + 100; // $1.00 to $50.00
    const key = `conserve_test_${i}_${Date.now()}`;

    if (opType === 0) {
      // Deposit
      const acc = accounts[i % accounts.length];
      operations.push(
        executeDeposit({
          accountId: acc,
          amount,
          description: `Random deposit #${i}`,
          initiatedByUserId: 'usr_admin_01',
          idempotencyKey: key,
          db
        }).catch(err => ({ error: err.message }))
      );
    } else if (opType === 1) {
      // Transfer
      const src = accounts[i % accounts.length];
      const dst = accounts[(i + 1) % accounts.length];
      operations.push(
        executeTransfer({
          sourceAccountId: src,
          destinationAccountId: dst,
          amount,
          description: `Random transfer #${i}`,
          initiatedByUserId: 'usr_alice_01',
          idempotencyKey: key,
          db
        }).catch(err => ({ error: err.message }))
      );
    } else {
      // Withdrawal
      const acc = accounts[i % accounts.length];
      operations.push(
        executeWithdrawal({
          accountId: acc,
          amount,
          description: `Random withdrawal #${i}`,
          initiatedByUserId: 'usr_alice_01',
          idempotencyKey: key,
          db
        }).catch(err => ({ error: err.message }))
      );
    }
  }

  // Await all concurrent operations
  await Promise.all(operations);

  // RIGOROUS MATHEMATICAL AUDIT
  const finalRecon = reconcileSystem(db);

  // 1. Invariant: System is healthy
  assert.strictEqual(
    finalRecon.isHealthy,
    true,
    `System balance health failed: ${JSON.stringify(finalRecon.invariants)}`
  );

  // 2. Invariant: Money Conservation holds exactly (delta === 0)
  assert.strictEqual(
    finalRecon.invariants.moneyConservation.holds,
    true,
    'Money conservation invariant broke under concurrent load!'
  );
  assert.strictEqual(
    finalRecon.invariants.moneyConservation.delta,
    0,
    `Discrepancy detected between customer balances and net external cash flow: delta=${finalRecon.invariants.moneyConservation.delta}`
  );

  // 3. Invariant: Double-Entry debits === credits (delta === 0)
  assert.strictEqual(
    finalRecon.invariants.doubleEntryBalancing.holds,
    true,
    'Double-entry books do not balance!'
  );
  assert.strictEqual(
    finalRecon.invariants.doubleEntryBalancing.netDelta,
    0,
    'Sum of debits differs from sum of credits in ledger!'
  );

  // 4. Invariant: All individual accounts strictly match their derived ledger postings
  assert.strictEqual(
    finalRecon.invariants.perAccountDerivation.holds,
    true,
    `Account cached balances diverged from ledger: ${JSON.stringify(finalRecon.invariants.perAccountDerivation.discrepancies)}`
  );

  closeDatabase();
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
});
