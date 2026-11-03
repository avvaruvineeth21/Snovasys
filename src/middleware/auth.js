const { verifyToken } = require('../services/authService');
const { getDatabase } = require('../db/database');
const { recordRefusal } = require('../services/ledgerService');

/**
 * Authenticate incoming request via Authorization: Bearer <token>
 */
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Authentication required. Please provide a valid Bearer token.'
    });
  }

  const token = authHeader.split(' ')[1];
  const payload = verifyToken(token);

  if (!payload) {
    return res.status(401).json({
      error: 'Invalid or expired authentication token.'
    });
  }

  req.user = {
    ...payload,
    id: payload.id || payload.sub
  };
  next();
}

/**
 * Restrict endpoint to specific roles.
 */
function requireRoles(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Forbidden: Role '${req.user.role}' is not authorized to perform this operation. Required: ${allowedRoles.join(', ')}.`
      });
    }

    next();
  };
}

/**
 * Verify that the authenticated user owns the account, or is an Administrator.
 * Auditors have read-only access to view; they cannot authorize money movement.
 */
function requireAccountEntitlement({ accountIdParam = 'id', isWriteOperation = false } = {}) {
  return (req, res, next) => {
    const accountId = req.params[accountIdParam] || req.body[accountIdParam] || req.body.sourceAccountId || req.body.accountId;
    if (!accountId) {
      return res.status(400).json({ error: 'Account identifier is required.' });
    }

    const db = getDatabase();
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);

    if (!account) {
      return res.status(404).json({ error: `Account '${accountId}' not found.` });
    }

    // Auditors are strictly read-only
    if (req.user.role === 'AUDITOR' && isWriteOperation) {
      return res.status(403).json({
        error: 'Forbidden: Auditors have read-only permissions and cannot authorize transactions.'
      });
    }

    // Administrators can inspect all accounts, but customer accounts can only be debited with entitlement
    if (req.user.role === 'ADMIN') {
      return next();
    }

    // Account Holder check: must match owner
    if (req.user.role === 'ACCOUNT_HOLDER') {
      if (account.user_id !== req.user.id) {
        // If money movement write was attempted, log refusal in the audit ledger
        if (isWriteOperation) {
          try {
            recordRefusal(db, {
              accountId,
              attemptedAmount: req.body.amount || 0,
              operationType: req.body.destinationAccountId ? 'TRANSFER' : (req.path.includes('withdraw') ? 'WITHDRAWAL' : 'DEPOSIT'),
              counterpartyAccountId: req.body.destinationAccountId || null,
              reason: 'UNAUTHORIZED_CROSS_ACCOUNT_ACCESS',
              runningBalance: account.balance,
              initiatedByUserId: req.user.id,
              idempotencyKey: req.headers['idempotency-key'] || req.body.idempotencyKey || null,
              metadata: {
                attemptedBy: req.user.username,
                actualOwner: account.user_id
              }
            });
          } catch (logErr) {
            console.error('Failed to record refusal:', logErr);
          }
        }

        return res.status(403).json({
          error: 'Forbidden: You are not authorized to view or move funds from this account.'
        });
      }
    }

    next();
  };
}

module.exports = {
  authenticate,
  requireRoles,
  requireAccountEntitlement
};
