const express = require('express');
const { getDatabase } = require('../db/database');
const { authenticate, requireRoles } = require('../middleware/auth');
const { reconcileSystem } = require('../services/ledgerService');
const { verifyLedgerChain } = require('../db/ledgerChain');

const router = express.Router();

/**
 * GET /api/audit/reconciliation
 * Mathematical proof of money conservation and double-entry balance.
 * Accessible to ADMIN and AUDITOR.
 */
router.get('/reconciliation', authenticate, requireRoles('ADMIN', 'AUDITOR'), (req, res) => {
  try {
    const report = reconcileSystem();
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/audit/verify-chain
 * Cryptographically verifies every ledger row against its SHA-256 hash and previous entry link.
 * Accessible to ADMIN and AUDITOR.
 */
router.get('/verify-chain', authenticate, requireRoles('ADMIN', 'AUDITOR'), (req, res) => {
  try {
    const db = getDatabase();
    const result = verifyLedgerChain(db);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/audit/idempotency-log
 * Exposes all idempotency keys with duplicate counts to demonstrate replay prevention.
 * Accessible to ADMIN and AUDITOR.
 */
router.get('/idempotency-log', authenticate, requireRoles('ADMIN', 'AUDITOR'), (req, res) => {
  const db = getDatabase();
  const keys = db.prepare(`
    SELECT ik.*, u.username as initiator_username 
    FROM idempotency_keys ik
    JOIN users u ON ik.user_id = u.id
    ORDER BY ik.updated_at DESC
  `).all();

  const totalDuplicatesInterception = keys.reduce((sum, item) => sum + item.duplicate_count, 0);

  res.json({
    totalKeys: keys.length,
    totalDuplicatesIntercepted: totalDuplicatesInterception,
    keys
  });
});

/**
 * GET /api/audit/refused-log
 * Centralized audit log of all refused operations and attempts across the system.
 * Accessible to ADMIN and AUDITOR.
 */
router.get('/refused-log', authenticate, requireRoles('ADMIN', 'AUDITOR'), (req, res) => {
  const db = getDatabase();
  const refused = db.prepare(`
    SELECT r.*, u.username as initiator_username, u.role as initiator_role, a.account_number
    FROM refused_transactions r
    JOIN users u ON r.initiated_by_user_id = u.id
    LEFT JOIN accounts a ON r.account_id = a.id
    ORDER BY r.created_at DESC
  `).all();

  res.json({
    totalRefused: refused.length,
    refused
  });
});

/**
 * GET /api/audit/ledger-entries
 * Raw ledger stream with cryptographic hashes.
 * Accessible to ADMIN and AUDITOR.
 */
router.get('/ledger-entries', authenticate, requireRoles('ADMIN', 'AUDITOR'), (req, res) => {
  const db = getDatabase();
  const limit = parseInt(req.query.limit, 10) || 100;
  const offset = parseInt(req.query.offset, 10) || 0;

  const entries = db.prepare(`
    SELECT le.*, a.account_number, u.username as initiator_username 
    FROM ledger_entries le
    JOIN accounts a ON le.account_id = a.id
    JOIN users u ON le.initiated_by_user_id = u.id
    ORDER BY le.sequence_number DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);

  res.json({
    count: entries.length,
    entries
  });
});

module.exports = router;
