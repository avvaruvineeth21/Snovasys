const crypto = require('node:crypto');
const { getDatabase, runInTransaction } = require('../db/database');
const { computeEntryHash, getNextChainState } = require('../db/ledgerChain');
const lockService = require('./lockService');
const config = require('../config');

class LedgerError extends Error {
  constructor(message, code = 400, details = {}) {
    super(message);
    name = 'LedgerError';
    this.statusCode = code;
    this.details = details;
  }
}

/**
 * Record an immutable refused transaction.
 */
function recordRefusal(db, {
  accountId,
  attemptedAmount,
  operationType,
  counterpartyAccountId = null,
  reason,
  runningBalance,
  initiatedByUserId,
  idempotencyKey = null,
  metadata = {}
}) {
  const refusalId = `ref_${crypto.randomBytes(8).toString('hex')}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO refused_transactions (
      id, account_id, attempted_amount, operation_type, counterparty_account_id,
      reason, running_balance, initiated_by_user_id, idempotency_key, metadata, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    refusalId,
    accountId,
    attemptedAmount,
    operationType,
    counterpartyAccountId,
    reason,
    runningBalance,
    initiatedByUserId,
    idempotencyKey,
    JSON.stringify(metadata),
    now
  );

  return {
    refusalId,
    accountId,
    reason,
    attemptedAmount,
    runningBalance,
    createdAt: now
  };
}

/**
 * Execute an external deposit into a customer account.
 * Double-Entry:
 * - DEBIT: SYSTEM_CASH_INFLOW
 * - CREDIT: Customer Account
 */
async function executeDeposit({
  accountId,
  amount,
  description = 'External deposit',
  initiatedByUserId,
  idempotencyKey = null,
  db = getDatabase()
}) {
  if (!amount || amount <= 0 || !Number.isInteger(amount)) {
    throw new LedgerError('Deposit amount must be a positive integer in minor units (cents).', 400);
  }

  // Lock account
  return await lockService.withLocks([accountId, config.systemAccounts.cashInflow], async () => {
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    if (!account) {
      throw new LedgerError('Target account not found.', 404);
    }
    if (account.status !== 'ACTIVE') {
      const refusal = recordRefusal(db, {
        accountId,
        attemptedAmount: amount,
        operationType: 'DEPOSIT',
        reason: `ACCOUNT_${account.status}`,
        runningBalance: account.balance,
        initiatedByUserId,
        idempotencyKey
      });
      throw new LedgerError(`Deposit refused: Account is ${account.status}.`, 403, refusal);
    }

    return runInTransaction(db, (txDb) => {
      const txId = `tx_${crypto.randomBytes(8).toString('hex')}`;
      const now = new Date().toISOString();

      // Record transaction
      txDb.prepare(`
        INSERT INTO transactions (id, type, amount, source_account_id, destination_account_id, initiated_by_user_id, idempotency_key, description, status, created_at)
        VALUES (?, 'DEPOSIT', ?, ?, ?, ?, ?, ?, 'POSTED', ?)
      `).run(
        txId,
        amount,
        config.systemAccounts.cashInflow,
        accountId,
        initiatedByUserId,
        idempotencyKey,
        description,
        now
      );

      // 1. Double-Entry Posting: SYSTEM_CASH_INFLOW (DEBIT)
      const systemInflowAccount = txDb.prepare('SELECT balance FROM accounts WHERE id = ?').get(config.systemAccounts.cashInflow);
      const systemResulting = systemInflowAccount.balance + amount;
      txDb.prepare('UPDATE accounts SET balance = balance + ?, updated_at = ? WHERE id = ?').run(amount, now, config.systemAccounts.cashInflow);

      const sysChain = getNextChainState(txDb);
      const sysEntryId = `led_${crypto.randomBytes(8).toString('hex')}`;
      const sysHash = computeEntryHash({
        previousHash: sysChain.previousHash,
        id: sysEntryId,
        sequenceNumber: sysChain.sequenceNumber,
        transactionId: txId,
        accountId: config.systemAccounts.cashInflow,
        entryType: 'DEBIT',
        amount,
        resultingBalance: systemResulting,
        createdAt: now
      });

      txDb.prepare(`
        INSERT INTO ledger_entries (id, sequence_number, transaction_id, account_id, entry_type, amount, resulting_balance, description, initiated_by_user_id, previous_hash, entry_hash, created_at)
        VALUES (?, ?, ?, ?, 'DEBIT', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sysEntryId,
        sysChain.sequenceNumber,
        txId,
        config.systemAccounts.cashInflow,
        amount,
        systemResulting,
        description,
        initiatedByUserId,
        sysChain.previousHash,
        sysHash,
        now
      );

      // 2. Double-Entry Posting: Customer Account (CREDIT)
      const custResulting = account.balance + amount;
      txDb.prepare('UPDATE accounts SET balance = balance + ?, updated_at = ? WHERE id = ?').run(amount, now, accountId);

      const custChain = getNextChainState(txDb);
      const custEntryId = `led_${crypto.randomBytes(8).toString('hex')}`;
      const custHash = computeEntryHash({
        previousHash: custChain.previousHash,
        id: custEntryId,
        sequenceNumber: custChain.sequenceNumber,
        transactionId: txId,
        accountId,
        entryType: 'CREDIT',
        amount,
        resultingBalance: custResulting,
        createdAt: now
      });

      txDb.prepare(`
        INSERT INTO ledger_entries (id, sequence_number, transaction_id, account_id, entry_type, amount, resulting_balance, description, initiated_by_user_id, previous_hash, entry_hash, created_at)
        VALUES (?, ?, ?, ?, 'CREDIT', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        custEntryId,
        custChain.sequenceNumber,
        txId,
        accountId,
        amount,
        custResulting,
        description,
        initiatedByUserId,
        custChain.previousHash,
        custHash,
        now
      );

      return {
        transactionId: txId,
        type: 'DEPOSIT',
        accountId,
        amount,
        previousBalance: account.balance,
        resultingBalance: custResulting,
        currency: account.currency,
        status: 'POSTED',
        createdAt: now
      };
    });
  });
}

/**
 * Execute an external withdrawal from a customer account.
 * Double-Entry:
 * - DEBIT: Customer Account
 * - CREDIT: SYSTEM_CASH_OUTFLOW
 */
async function executeWithdrawal({
  accountId,
  amount,
  description = 'External withdrawal',
  initiatedByUserId,
  idempotencyKey = null,
  db = getDatabase()
}) {
  if (!amount || amount <= 0 || !Number.isInteger(amount)) {
    throw new LedgerError('Withdrawal amount must be a positive integer in minor units (cents).', 400);
  }

  return await lockService.withLocks([accountId, config.systemAccounts.cashOutflow], async () => {
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    if (!account) {
      throw new LedgerError('Source account not found.', 404);
    }
    if (account.status !== 'ACTIVE') {
      const refusal = recordRefusal(db, {
        accountId,
        attemptedAmount: amount,
        operationType: 'WITHDRAWAL',
        reason: `ACCOUNT_${account.status}`,
        runningBalance: account.balance,
        initiatedByUserId,
        idempotencyKey
      });
      throw new LedgerError(`Withdrawal refused: Account is ${account.status}.`, 403, refusal);
    }

    // Check available funds including authorized overdraft
    const availableFunds = account.balance + account.overdraft_limit;
    if (amount > availableFunds) {
      const reason = account.overdraft_limit > 0 ? 'OVERDRAFT_LIMIT_EXCEEDED' : 'INSUFFICIENT_FUNDS';
      const refusal = recordRefusal(db, {
        accountId,
        attemptedAmount: amount,
        operationType: 'WITHDRAWAL',
        reason,
        runningBalance: account.balance,
        initiatedByUserId,
        idempotencyKey,
        metadata: {
          availableFunds,
          overdraftLimit: account.overdraft_limit
        }
      });

      throw new LedgerError(
        `Withdrawal refused: ${reason}. Available: ${availableFunds}, Requested: ${amount}.`,
        400,
        refusal
      );
    }

    return runInTransaction(db, (txDb) => {
      const txId = `tx_${crypto.randomBytes(8).toString('hex')}`;
      const now = new Date().toISOString();

      // Record transaction
      txDb.prepare(`
        INSERT INTO transactions (id, type, amount, source_account_id, destination_account_id, initiated_by_user_id, idempotency_key, description, status, created_at)
        VALUES (?, 'WITHDRAWAL', ?, ?, ?, ?, ?, ?, 'POSTED', ?)
      `).run(
        txId,
        amount,
        accountId,
        config.systemAccounts.cashOutflow,
        initiatedByUserId,
        idempotencyKey,
        description,
        now
      );

      // 1. Double-Entry Posting: Customer Account (DEBIT)
      const custResulting = account.balance - amount;
      txDb.prepare('UPDATE accounts SET balance = balance - ?, updated_at = ? WHERE id = ?').run(amount, now, accountId);

      const custChain = getNextChainState(txDb);
      const custEntryId = `led_${crypto.randomBytes(8).toString('hex')}`;
      const custHash = computeEntryHash({
        previousHash: custChain.previousHash,
        id: custEntryId,
        sequenceNumber: custChain.sequenceNumber,
        transactionId: txId,
        accountId,
        entryType: 'DEBIT',
        amount,
        resultingBalance: custResulting,
        createdAt: now
      });

      txDb.prepare(`
        INSERT INTO ledger_entries (id, sequence_number, transaction_id, account_id, entry_type, amount, resulting_balance, description, initiated_by_user_id, previous_hash, entry_hash, created_at)
        VALUES (?, ?, ?, ?, 'DEBIT', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        custEntryId,
        custChain.sequenceNumber,
        txId,
        accountId,
        amount,
        custResulting,
        description,
        initiatedByUserId,
        custChain.previousHash,
        custHash,
        now
      );

      // 2. Double-Entry Posting: SYSTEM_CASH_OUTFLOW (CREDIT)
      const systemOutflowAccount = txDb.prepare('SELECT balance FROM accounts WHERE id = ?').get(config.systemAccounts.cashOutflow);
      const systemResulting = systemOutflowAccount.balance + amount;
      txDb.prepare('UPDATE accounts SET balance = balance + ?, updated_at = ? WHERE id = ?').run(amount, now, config.systemAccounts.cashOutflow);

      const sysChain = getNextChainState(txDb);
      const sysEntryId = `led_${crypto.randomBytes(8).toString('hex')}`;
      const sysHash = computeEntryHash({
        previousHash: sysChain.previousHash,
        id: sysEntryId,
        sequenceNumber: sysChain.sequenceNumber,
        transactionId: txId,
        accountId: config.systemAccounts.cashOutflow,
        entryType: 'CREDIT',
        amount,
        resultingBalance: systemResulting,
        createdAt: now
      });

      txDb.prepare(`
        INSERT INTO ledger_entries (id, sequence_number, transaction_id, account_id, entry_type, amount, resulting_balance, description, initiated_by_user_id, previous_hash, entry_hash, created_at)
        VALUES (?, ?, ?, ?, 'CREDIT', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sysEntryId,
        sysChain.sequenceNumber,
        txId,
        config.systemAccounts.cashOutflow,
        amount,
        systemResulting,
        description,
        initiatedByUserId,
        sysChain.previousHash,
        sysHash,
        now
      );

      return {
        transactionId: txId,
        type: 'WITHDRAWAL',
        accountId,
        amount,
        previousBalance: account.balance,
        resultingBalance: custResulting,
        currency: account.currency,
        status: 'POSTED',
        createdAt: now
      };
    });
  });
}

/**
 * Execute an internal transfer between two accounts.
 * Invariant: Internal transfers net to zero.
 * Double-Entry:
 * - DEBIT: Source Account
 * - CREDIT: Destination Account
 */
async function executeTransfer({
  sourceAccountId,
  destinationAccountId,
  amount,
  description = 'Account transfer',
  initiatedByUserId,
  idempotencyKey = null,
  db = getDatabase()
}) {
  if (!amount || amount <= 0 || !Number.isInteger(amount)) {
    throw new LedgerError('Transfer amount must be a positive integer in minor units (cents).', 400);
  }

  if (sourceAccountId === destinationAccountId) {
    throw new LedgerError('Source and destination accounts must be distinct.', 400);
  }

  // Deterministic lock acquisition order eliminates deadlocks
  return await lockService.withLocks([sourceAccountId, destinationAccountId], async () => {
    const sourceAccount = db.prepare('SELECT * FROM accounts WHERE id = ?').get(sourceAccountId);
    if (!sourceAccount) {
      throw new LedgerError('Source account not found.', 404);
    }

    const destAccount = db.prepare('SELECT * FROM accounts WHERE id = ?').get(destinationAccountId);
    if (!destAccount) {
      const refusal = recordRefusal(db, {
        accountId: sourceAccountId,
        attemptedAmount: amount,
        operationType: 'TRANSFER',
        counterpartyAccountId: destinationAccountId,
        reason: 'INVALID_DESTINATION_ACCOUNT',
        runningBalance: sourceAccount.balance,
        initiatedByUserId,
        idempotencyKey
      });
      throw new LedgerError('Transfer refused: Destination account does not exist.', 404, refusal);
    }

    if (sourceAccount.status !== 'ACTIVE') {
      const refusal = recordRefusal(db, {
        accountId: sourceAccountId,
        attemptedAmount: amount,
        operationType: 'TRANSFER',
        counterpartyAccountId: destinationAccountId,
        reason: `SOURCE_ACCOUNT_${sourceAccount.status}`,
        runningBalance: sourceAccount.balance,
        initiatedByUserId,
        idempotencyKey
      });
      throw new LedgerError(`Transfer refused: Source account is ${sourceAccount.status}.`, 403, refusal);
    }

    if (destAccount.status !== 'ACTIVE') {
      const refusal = recordRefusal(db, {
        accountId: sourceAccountId,
        attemptedAmount: amount,
        operationType: 'TRANSFER',
        counterpartyAccountId: destinationAccountId,
        reason: `DESTINATION_ACCOUNT_${destAccount.status}`,
        runningBalance: sourceAccount.balance,
        initiatedByUserId,
        idempotencyKey
      });
      throw new LedgerError(`Transfer refused: Destination account is ${destAccount.status}.`, 403, refusal);
    }

    // Check available funds including authorized overdraft
    const availableFunds = sourceAccount.balance + sourceAccount.overdraft_limit;
    if (amount > availableFunds) {
      const reason = sourceAccount.overdraft_limit > 0 ? 'OVERDRAFT_LIMIT_EXCEEDED' : 'INSUFFICIENT_FUNDS';
      const refusal = recordRefusal(db, {
        accountId: sourceAccountId,
        attemptedAmount: amount,
        operationType: 'TRANSFER',
        counterpartyAccountId: destinationAccountId,
        reason,
        runningBalance: sourceAccount.balance,
        initiatedByUserId,
        idempotencyKey,
        metadata: {
          availableFunds,
          overdraftLimit: sourceAccount.overdraft_limit
        }
      });

      throw new LedgerError(
        `Transfer refused: ${reason}. Available: ${availableFunds}, Requested: ${amount}.`,
        400,
        refusal
      );
    }

    return runInTransaction(db, (txDb) => {
      const txId = `tx_${crypto.randomBytes(8).toString('hex')}`;
      const now = new Date().toISOString();

      // Record transaction
      txDb.prepare(`
        INSERT INTO transactions (id, type, amount, source_account_id, destination_account_id, initiated_by_user_id, idempotency_key, description, status, created_at)
        VALUES (?, 'TRANSFER', ?, ?, ?, ?, ?, ?, 'POSTED', ?)
      `).run(
        txId,
        amount,
        sourceAccountId,
        destinationAccountId,
        initiatedByUserId,
        idempotencyKey,
        description,
        now
      );

      // 1. Double-Entry Posting: Source Account (DEBIT)
      const srcResulting = sourceAccount.balance - amount;
      txDb.prepare('UPDATE accounts SET balance = balance - ?, updated_at = ? WHERE id = ?').run(amount, now, sourceAccountId);

      const srcChain = getNextChainState(txDb);
      const srcEntryId = `led_${crypto.randomBytes(8).toString('hex')}`;
      const srcHash = computeEntryHash({
        previousHash: srcChain.previousHash,
        id: srcEntryId,
        sequenceNumber: srcChain.sequenceNumber,
        transactionId: txId,
        accountId: sourceAccountId,
        entryType: 'DEBIT',
        amount,
        resultingBalance: srcResulting,
        createdAt: now
      });

      txDb.prepare(`
        INSERT INTO ledger_entries (id, sequence_number, transaction_id, account_id, entry_type, amount, resulting_balance, description, initiated_by_user_id, previous_hash, entry_hash, created_at)
        VALUES (?, ?, ?, ?, 'DEBIT', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        srcEntryId,
        srcChain.sequenceNumber,
        txId,
        sourceAccountId,
        amount,
        srcResulting,
        `Transfer to ${destAccount.account_number}: ${description}`,
        initiatedByUserId,
        srcChain.previousHash,
        srcHash,
        now
      );

      // 2. Double-Entry Posting: Destination Account (CREDIT)
      const dstResulting = destAccount.balance + amount;
      txDb.prepare('UPDATE accounts SET balance = balance + ?, updated_at = ? WHERE id = ?').run(amount, now, destinationAccountId);

      const dstChain = getNextChainState(txDb);
      const dstEntryId = `led_${crypto.randomBytes(8).toString('hex')}`;
      const dstHash = computeEntryHash({
        previousHash: dstChain.previousHash,
        id: dstEntryId,
        sequenceNumber: dstChain.sequenceNumber,
        transactionId: txId,
        accountId: destinationAccountId,
        entryType: 'CREDIT',
        amount,
        resultingBalance: dstResulting,
        createdAt: now
      });

      txDb.prepare(`
        INSERT INTO ledger_entries (id, sequence_number, transaction_id, account_id, entry_type, amount, resulting_balance, description, initiated_by_user_id, previous_hash, entry_hash, created_at)
        VALUES (?, ?, ?, ?, 'CREDIT', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        dstEntryId,
        dstChain.sequenceNumber,
        txId,
        destinationAccountId,
        amount,
        dstResulting,
        `Transfer from ${sourceAccount.account_number}: ${description}`,
        initiatedByUserId,
        dstChain.previousHash,
        dstHash,
        now
      );

      return {
        transactionId: txId,
        type: 'TRANSFER',
        sourceAccountId,
        destinationAccountId,
        amount,
        sourcePreviousBalance: sourceAccount.balance,
        sourceResultingBalance: srcResulting,
        destinationResultingBalance: dstResulting,
        status: 'POSTED',
        createdAt: now
      };
    });
  });
}

/**
 * Generates an exhaustive per-account statement containing:
 * - Every DEBIT
 * - Every CREDIT
 * - Every REFUSED attempt
 * Each with resulting running balance, timestamp, and initiator.
 */
function getAccountStatement(accountId, db = getDatabase()) {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!account) {
    throw new LedgerError('Account not found.', 404);
  }

  // 1. Fetch all posted ledger entries for this account
  const postings = db.prepare(`
    SELECT 
      le.id as entry_id,
      le.sequence_number,
      le.transaction_id,
      le.entry_type,
      le.amount,
      le.resulting_balance,
      le.description,
      le.created_at,
      le.previous_hash,
      le.entry_hash,
      t.type as transaction_type,
      t.idempotency_key,
      t.source_account_id,
      t.destination_account_id,
      u.id as initiator_id,
      u.name as initiator_name,
      u.role as initiator_role,
      'POSTED' as status,
      NULL as refusal_reason
    FROM ledger_entries le
    JOIN transactions t ON le.transaction_id = t.id
    JOIN users u ON le.initiated_by_user_id = u.id
    WHERE le.account_id = ?
  `).all(accountId);

  // 2. Fetch all refused attempts for this account
  const refusals = db.prepare(`
    SELECT 
      r.id as entry_id,
      NULL as sequence_number,
      NULL as transaction_id,
      CASE 
        WHEN r.operation_type = 'DEPOSIT' THEN 'CREDIT'
        ELSE 'DEBIT'
      END as entry_type,
      r.attempted_amount as amount,
      r.running_balance as resulting_balance,
      'Refused ' || r.operation_type || ' (' || r.reason || ')' as description,
      r.created_at,
      NULL as previous_hash,
      NULL as entry_hash,
      r.operation_type as transaction_type,
      r.idempotency_key,
      r.account_id as source_account_id,
      r.counterparty_account_id as destination_account_id,
      u.id as initiator_id,
      u.name as initiator_name,
      u.role as initiator_role,
      'REFUSED' as status,
      r.reason as refusal_reason
    FROM refused_transactions r
    JOIN users u ON r.initiated_by_user_id = u.id
    WHERE r.account_id = ?
  `).all(accountId);

  // Merge and sort chronologically (most recent first)
  const combined = [...postings, ...refusals].sort((a, b) => {
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  return {
    account: {
      id: account.id,
      accountNumber: account.account_number,
      balance: account.balance,
      overdraftLimit: account.overdraft_limit,
      currency: account.currency,
      status: account.status
    },
    totalEntries: combined.length,
    postedCount: postings.length,
    refusedCount: refusals.length,
    statement: combined
  };
}

/**
 * System-wide invariant reconciliation proof.
 * Mathematically verifies:
 * 1. Total Customer Balances === Total External Inflows - Total External Outflows
 * 2. Total Ledger Debits === Total Ledger Credits
 * 3. Individual account balances match their summed ledger postings
 */
function reconcileSystem(db = getDatabase()) {
  // 1. Total Customer Balances
  const customerRow = db.prepare(`
    SELECT COALESCE(SUM(balance), 0) as total_customer_balances, COUNT(*) as count 
    FROM accounts 
    WHERE account_type = 'CUSTOMER'
  `).get();

  // 2. System Counterparty Inflows and Outflows
  const inflowAccount = db.prepare('SELECT balance FROM accounts WHERE id = ?').get(config.systemAccounts.cashInflow);
  const outflowAccount = db.prepare('SELECT balance FROM accounts WHERE id = ?').get(config.systemAccounts.cashOutflow);

  const totalInflows = inflowAccount ? inflowAccount.balance : 0;
  const totalOutflows = outflowAccount ? outflowAccount.balance : 0;
  const netExternal = totalInflows - totalOutflows;

  // 3. Double-Entry Invariant (Debits == Credits)
  const ledgerSumRow = db.prepare(`
    SELECT 
      COALESCE(SUM(CASE WHEN entry_type = 'DEBIT' THEN amount ELSE 0 END), 0) as total_debits,
      COALESCE(SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE 0 END), 0) as total_credits,
      COUNT(*) as total_entries
    FROM ledger_entries
  `).get();

  const isMoneyConserved = customerRow.total_customer_balances === netExternal;
  const isDoubleEntryBalanced = ledgerSumRow.total_debits === ledgerSumRow.total_credits;

  // 4. Per-account derived balance check
  const accountAuditDiscrepancies = [];
  const allAccounts = db.prepare('SELECT id, account_number, balance FROM accounts').all();
  for (const acc of allAccounts) {
    const derived = db.prepare(`
      SELECT 
        COALESCE(SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE 0 END), 0) as credits,
        COALESCE(SUM(CASE WHEN entry_type = 'DEBIT' THEN amount ELSE 0 END), 0) as debits
      FROM ledger_entries 
      WHERE account_id = ?
    `).get(acc.id);

    // For customer and system accounts, verify against postings
    let expectedBalance;
    if (acc.id === config.systemAccounts.cashInflow) {
      expectedBalance = derived.debits;
    } else if (acc.id === config.systemAccounts.cashOutflow) {
      expectedBalance = derived.credits;
    } else {
      expectedBalance = derived.credits - derived.debits;
    }

    if (acc.balance !== expectedBalance) {
      accountAuditDiscrepancies.push({
        accountId: acc.id,
        accountNumber: acc.account_number,
        cachedBalance: acc.balance,
        derivedBalance: expectedBalance
      });
    }
  }

  return {
    isHealthy: isMoneyConserved && isDoubleEntryBalanced && accountAuditDiscrepancies.length === 0,
    invariants: {
      moneyConservation: {
        holds: isMoneyConserved,
        formula: 'Total Customer Balances == Total External Inflow - Total External Outflow',
        totalCustomerBalances: customerRow.total_customer_balances,
        totalExternalInflows: totalInflows,
        totalExternalOutflows: totalOutflows,
        netExternalInflow: netExternal,
        delta: customerRow.total_customer_balances - netExternal
      },
      doubleEntryBalancing: {
        holds: isDoubleEntryBalanced,
        formula: 'Sum(All Ledger Debits) == Sum(All Ledger Credits)',
        totalDebits: ledgerSumRow.total_debits,
        totalCredits: ledgerSumRow.total_credits,
        totalPostings: ledgerSumRow.total_entries,
        netDelta: ledgerSumRow.total_debits - ledgerSumRow.total_credits
      },
      perAccountDerivation: {
        holds: accountAuditDiscrepancies.length === 0,
        discrepancies: accountAuditDiscrepancies
      }
    },
    timestamp: new Date().toISOString()
  };
}

module.exports = {
  LedgerError,
  recordRefusal,
  executeDeposit,
  executeWithdrawal,
  executeTransfer,
  getAccountStatement,
  reconcileSystem
};
