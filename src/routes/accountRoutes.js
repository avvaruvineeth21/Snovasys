const express = require('express');
const crypto = require('node:crypto');
const { getDatabase } = require('../db/database');
const { authenticate, requireRoles, requireAccountEntitlement } = require('../middleware/auth');
const { getAccountStatement } = require('../services/ledgerService');

const router = express.Router();

/**
 * GET /api/accounts
 * List accounts.
 * Account holders see only their accounts; Admin and Auditor see all accounts.
 */
router.get('/', authenticate, (req, res) => {
  const db = getDatabase();
  const includeSystem = req.query.includeSystem === 'true';

  let query = `
    SELECT a.*, u.username as owner_username, u.name as owner_name 
    FROM accounts a
    LEFT JOIN users u ON a.user_id = u.id
  `;
  const params = [];

  if (req.user.role === 'ACCOUNT_HOLDER') {
    query += ' WHERE a.user_id = ?';
    params.push(req.user.id);
  } else if (!includeSystem) {
    query += " WHERE a.account_type = 'CUSTOMER'";
  }

  query += ' ORDER BY a.created_at ASC';

  const accounts = db.prepare(query).all(...params);
  res.json({ accounts });
});

/**
 * POST /api/accounts
 * Create a new account (Admin only).
 */
router.post('/', authenticate, requireRoles('ADMIN'), (req, res) => {
  const { userId, accountNumber, overdraftLimit = 0, currency = 'USD' } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'User ID is required to create a customer account.' });
  }

  const db = getDatabase();
  const targetUser = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(userId);
  if (!targetUser) {
    return res.status(404).json({ error: 'Target user does not exist.' });
  }

  const accId = `acc_${crypto.randomBytes(6).toString('hex')}`;
  const generatedAccNum = accountNumber || `ACT-${Math.floor(100000 + Math.random() * 900000)}`;
  const now = new Date().toISOString();

  try {
    db.prepare(`
      INSERT INTO accounts (id, account_number, user_id, account_type, balance, overdraft_limit, currency, status, created_at, updated_at)
      VALUES (?, ?, ?, 'CUSTOMER', 0, ?, ?, 'ACTIVE', ?, ?)
    `).run(accId, generatedAccNum, userId, Math.max(0, parseInt(overdraftLimit, 10) || 0), currency, now, now);

    const created = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accId);
    res.status(201).json({ account: created });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'Account number already exists.' });
    }
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/accounts/:id
 * Retrieve single account details.
 */
router.get('/:id', authenticate, requireAccountEntitlement({ accountIdParam: 'id', isWriteOperation: false }), (req, res) => {
  const db = getDatabase();
  const account = db.prepare(`
    SELECT a.*, u.username as owner_username, u.name as owner_name 
    FROM accounts a
    LEFT JOIN users u ON a.user_id = u.id
    WHERE a.id = ?
  `).get(req.params.id);

  if (!account) {
    return res.status(404).json({ error: 'Account not found.' });
  }

  res.json({ account });
});

/**
 * GET /api/accounts/:id/statement
 * Detailed statement including every debit, credit, and refused attempt.
 */
router.get('/:id/statement', authenticate, requireAccountEntitlement({ accountIdParam: 'id', isWriteOperation: false }), (req, res) => {
  try {
    const statementData = getAccountStatement(req.params.id);
    res.json(statementData);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * PATCH /api/accounts/:id/overdraft
 * Adjust authorized overdraft limit (Admin only).
 */
router.patch('/:id/overdraft', authenticate, requireRoles('ADMIN'), (req, res) => {
  const { overdraftLimit } = req.body;
  if (overdraftLimit === undefined || overdraftLimit < 0 || !Number.isInteger(overdraftLimit)) {
    return res.status(400).json({ error: 'Overdraft limit must be a non-negative integer in cents.' });
  }

  const db = getDatabase();
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) {
    return res.status(404).json({ error: 'Account not found.' });
  }

  // Ensure balance + newOverdraft >= 0
  if (account.balance + overdraftLimit < 0) {
    return res.status(400).json({
      error: `Cannot reduce overdraft limit below current negative deficit. Current balance is ${account.balance}.`
    });
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE accounts SET overdraft_limit = ?, updated_at = ? WHERE id = ?').run(
    overdraftLimit,
    now,
    req.params.id
  );

  const updated = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  res.json({
    message: 'Overdraft limit updated successfully.',
    account: updated
  });
});

/**
 * PATCH /api/accounts/:id/status
 * Freeze or unfreeze account (Admin only).
 */
router.patch('/:id/status', authenticate, requireRoles('ADMIN'), (req, res) => {
  const { status } = req.body;
  if (!['ACTIVE', 'FROZEN', 'CLOSED'].includes(status)) {
    return res.status(400).json({ error: 'Status must be one of: ACTIVE, FROZEN, CLOSED.' });
  }

  const db = getDatabase();
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) {
    return res.status(404).json({ error: 'Account not found.' });
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?').run(status, now, req.params.id);

  const updated = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  res.json({
    message: `Account status updated to ${status}.`,
    account: updated
  });
});

module.exports = router;
