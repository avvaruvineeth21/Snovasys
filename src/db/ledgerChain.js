const crypto = require('node:crypto');

const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Computes SHA-256 hash for a ledger entry.
 */
function computeEntryHash({
  previousHash,
  id,
  sequenceNumber,
  transactionId,
  accountId,
  entryType,
  amount,
  resultingBalance,
  createdAt
}) {
  const payload = [
    previousHash,
    id,
    sequenceNumber,
    transactionId,
    accountId,
    entryType,
    amount,
    resultingBalance,
    createdAt
  ].join(':');

  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Gets the latest ledger sequence and hash to link the next entry.
 * Must be executed within a transaction to maintain contiguous ordering.
 */
function getNextChainState(db) {
  const row = db.prepare(`
    SELECT sequence_number, entry_hash 
    FROM ledger_entries 
    ORDER BY sequence_number DESC 
    LIMIT 1
  `).get();

  if (!row) {
    return {
      sequenceNumber: 1,
      previousHash: GENESIS_HASH
    };
  }

  return {
    sequenceNumber: row.sequence_number + 1,
    previousHash: row.entry_hash
  };
}

/**
 * Verifies the integrity of the entire cryptographic ledger chain.
 * Returns { valid: boolean, totalEntries: number, headHash: string, error?: string, compromisedEntry?: object }
 */
function verifyLedgerChain(db) {
  const entries = db.prepare(`
    SELECT * FROM ledger_entries ORDER BY sequence_number ASC
  `).all();

  if (entries.length === 0) {
    return {
      valid: true,
      totalEntries: 0,
      headHash: GENESIS_HASH,
      message: 'Ledger is empty; genesis state holds.'
    };
  }

  let expectedPreviousHash = GENESIS_HASH;
  let expectedSequence = 1;

  for (const entry of entries) {
    // 1. Check sequence number contiguity (no missing or skipped entries)
    if (entry.sequence_number !== expectedSequence) {
      return {
        valid: false,
        totalEntries: entries.length,
        error: `Sequence gap detected: expected ${expectedSequence}, got ${entry.sequence_number}`,
        compromisedEntry: entry
      };
    }

    // 2. Check previous hash pointer
    if (entry.previous_hash !== expectedPreviousHash) {
      return {
        valid: false,
        totalEntries: entries.length,
        error: `Previous hash mismatch at sequence ${entry.sequence_number}. Expected ${expectedPreviousHash}, found ${entry.previous_hash}`,
        compromisedEntry: entry
      };
    }

    // 3. Recalculate hash from stored fields to detect row tampering
    const recalculatedHash = computeEntryHash({
      previousHash: entry.previous_hash,
      id: entry.id,
      sequenceNumber: entry.sequence_number,
      transactionId: entry.transaction_id,
      accountId: entry.account_id,
      entryType: entry.entry_type,
      amount: entry.amount,
      resultingBalance: entry.resulting_balance,
      createdAt: entry.created_at
    });

    if (entry.entry_hash !== recalculatedHash) {
      return {
        valid: false,
        totalEntries: entries.length,
        error: `Cryptographic hash corruption detected at sequence ${entry.sequence_number}. Entry hash has been tampered with.`,
        compromisedEntry: {
          ...entry,
          recalculatedHash
        }
      };
    }

    expectedPreviousHash = entry.entry_hash;
    expectedSequence += 1;
  }

  return {
    valid: true,
    totalEntries: entries.length,
    headHash: expectedPreviousHash,
    message: 'Cryptographic ledger chain is intact. All entries mathematically proven untampered.'
  };
}

module.exports = {
  GENESIS_HASH,
  computeEntryHash,
  getNextChainState,
  verifyLedgerChain
};
