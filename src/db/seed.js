const crypto = require('node:crypto');
const { getDatabase, runInTransaction } = require('./database');
const { hashPassword } = require('../services/authService');
const { computeEntryHash, GENESIS_HASH } = require('./ledgerChain');
const config = require('../config');

function seedDatabase(db = getDatabase()) {
  const existingUsers = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (existingUsers.count > 0) {
    return; // Already seeded
  }

  runInTransaction(db, (txDb) => {
    const insertUser = txDb.prepare(`
      INSERT INTO users (id, username, password_hash, salt, role, name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const now = new Date().toISOString();

    // 1. Create Users
    const users = [
      {
        id: 'usr_admin_01',
        username: 'admin',
        password: 'AdminPass123!',
        role: 'ADMIN',
        name: 'Alex Rivera (Administrator)'
      },
      {
        id: 'usr_alice_01',
        username: 'alice',
        password: 'AlicePass123!',
        role: 'ACCOUNT_HOLDER',
        name: 'Alice Henderson (Account Holder)'
      },
      {
        id: 'usr_bob_01',
        username: 'bob',
        password: 'BobPass123!',
        role: 'ACCOUNT_HOLDER',
        name: 'Bob Martinez (Account Holder)'
      },
      {
        id: 'usr_auditor_01',
        username: 'auditor',
        password: 'AuditorPass123!',
        role: 'AUDITOR',
        name: 'Charlie Audit (Independent Auditor)'
      }
    ];

    for (const u of users) {
      const { hash, salt } = hashPassword(u.password);
      insertUser.run(u.id, u.username, hash, salt, u.role, u.name, now);
    }

    // 2. Create Customer Accounts
    const insertAccount = txDb.prepare(`
      INSERT INTO accounts (id, account_number, user_id, account_type, balance, overdraft_limit, currency, status, created_at, updated_at)
      VALUES (?, ?, ?, 'CUSTOMER', 0, ?, 'USD', 'ACTIVE', ?, ?)
    `);

    insertAccount.run('acc_alice_main', 'ACT-ALICE-101', 'usr_alice_01', 0, now, now);
    insertAccount.run('acc_alice_payroll', 'ACT-ALICE-102', 'usr_alice_01', 20000, now, now); // $200 authorized overdraft
    insertAccount.run('acc_bob_main', 'ACT-BOB-201', 'usr_bob_01', 0, now, now);

    // 3. Fund Accounts with Proven Double-Entry External Deposits
    const initialFundings = [
      {
        targetAccount: 'acc_alice_main',
        amount: 100000, // $1,000.00
        desc: 'Initial capital funding via ACH deposit',
        userId: 'usr_alice_01'
      },
      {
        targetAccount: 'acc_alice_payroll',
        amount: 50000, // $500.00
        desc: 'Payroll float reserve deposit',
        userId: 'usr_alice_01'
      },
      {
        targetAccount: 'acc_bob_main',
        amount: 25000, // $250.00
        desc: 'Vendor operational seed deposit',
        userId: 'usr_bob_01'
      }
    ];

    let currentPreviousHash = GENESIS_HASH;
    let sequenceNumber = 1;

    const insertTx = txDb.prepare(`
      INSERT INTO transactions (id, type, amount, source_account_id, destination_account_id, initiated_by_user_id, idempotency_key, description, status, created_at)
      VALUES (?, 'DEPOSIT', ?, ?, ?, ?, ?, ?, 'POSTED', ?)
    `);

    const insertLedger = txDb.prepare(`
      INSERT INTO ledger_entries (id, sequence_number, transaction_id, account_id, entry_type, amount, resulting_balance, description, initiated_by_user_id, previous_hash, entry_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const updateBalance = txDb.prepare(`
      UPDATE accounts SET balance = balance + ?, updated_at = ? WHERE id = ?
    `);

    for (const funding of initialFundings) {
      const txId = `tx_init_${crypto.randomBytes(6).toString('hex')}`;
      const idemKey = `seed_init_${funding.targetAccount}`;
      const time = new Date().toISOString();

      insertTx.run(
        txId,
        funding.amount,
        config.systemAccounts.cashInflow,
        funding.targetAccount,
        funding.userId,
        idemKey,
        funding.desc,
        time
      );

      // System Cash Inflow Entry (DEBIT external inflow counterparty)
      const systemInflowAccount = txDb.prepare('SELECT balance FROM accounts WHERE id = ?').get(config.systemAccounts.cashInflow);
      const systemResulting = systemInflowAccount.balance + funding.amount;
      updateBalance.run(funding.amount, time, config.systemAccounts.cashInflow);

      const sysEntryId = `led_${crypto.randomBytes(8).toString('hex')}`;
      const sysHash = computeEntryHash({
        previousHash: currentPreviousHash,
        id: sysEntryId,
        sequenceNumber,
        transactionId: txId,
        accountId: config.systemAccounts.cashInflow,
        entryType: 'DEBIT',
        amount: funding.amount,
        resultingBalance: systemResulting,
        createdAt: time
      });

      insertLedger.run(
        sysEntryId,
        sequenceNumber,
        txId,
        config.systemAccounts.cashInflow,
        'DEBIT',
        funding.amount,
        systemResulting,
        funding.desc,
        funding.userId,
        currentPreviousHash,
        sysHash,
        time
      );

      currentPreviousHash = sysHash;
      sequenceNumber += 1;

      // Customer Account Entry (CREDIT customer balance)
      const custAccount = txDb.prepare('SELECT balance FROM accounts WHERE id = ?').get(funding.targetAccount);
      const custResulting = custAccount.balance + funding.amount;
      updateBalance.run(funding.amount, time, funding.targetAccount);

      const custEntryId = `led_${crypto.randomBytes(8).toString('hex')}`;
      const custHash = computeEntryHash({
        previousHash: currentPreviousHash,
        id: custEntryId,
        sequenceNumber,
        transactionId: txId,
        accountId: funding.targetAccount,
        entryType: 'CREDIT',
        amount: funding.amount,
        resultingBalance: custResulting,
        createdAt: time
      });

      insertLedger.run(
        custEntryId,
        sequenceNumber,
        txId,
        funding.targetAccount,
        'CREDIT',
        funding.amount,
        custResulting,
        funding.desc,
        funding.userId,
        currentPreviousHash,
        custHash,
        time
      );

      currentPreviousHash = custHash;
      sequenceNumber += 1;
    }
  });

  console.log('Database successfully seeded with seed users, accounts, and verified initial double-entry ledger postings.');
}

module.exports = {
  seedDatabase
};
