const express = require('express');
const { authenticate, requireRoles, requireAccountEntitlement } = require('../middleware/auth');
const { idempotencyMiddleware } = require('../middleware/idempotency');
const { executeDeposit, executeWithdrawal, executeTransfer } = require('../services/ledgerService');

const router = express.Router();

/**
 * POST /api/transactions/deposit
 * External cash deposit into an account.
 * Entitlement: Owner or Admin. Auditors forbidden.
 */
router.post(
  '/deposit',
  authenticate,
  requireRoles('ADMIN', 'ACCOUNT_HOLDER'),
  requireAccountEntitlement({ accountIdParam: 'accountId', isWriteOperation: true }),
  idempotencyMiddleware({ required: true }),
  async (req, res) => {
    try {
      const { accountId, amount, description } = req.body;
      const parsedAmount = parseInt(amount, 10);

      const result = await executeDeposit({
        accountId,
        amount: parsedAmount,
        description: description || 'External deposit',
        initiatedByUserId: req.user.id,
        idempotencyKey: req.idempotencyKey
      });

      res.status(200).json({
        success: true,
        message: 'Deposit executed successfully.',
        transaction: result
      });
    } catch (err) {
      res.status(err.statusCode || 500).json({
        success: false,
        error: err.message,
        details: err.details || null
      });
    }
  }
);

/**
 * POST /api/transactions/withdraw
 * External cash withdrawal from an account.
 * Entitlement: Owner or Admin. Auditors forbidden.
 */
router.post(
  '/withdraw',
  authenticate,
  requireRoles('ADMIN', 'ACCOUNT_HOLDER'),
  requireAccountEntitlement({ accountIdParam: 'accountId', isWriteOperation: true }),
  idempotencyMiddleware({ required: true }),
  async (req, res) => {
    try {
      const { accountId, amount, description } = req.body;
      const parsedAmount = parseInt(amount, 10);

      const result = await executeWithdrawal({
        accountId,
        amount: parsedAmount,
        description: description || 'External withdrawal',
        initiatedByUserId: req.user.id,
        idempotencyKey: req.idempotencyKey
      });

      res.status(200).json({
        success: true,
        message: 'Withdrawal executed successfully.',
        transaction: result
      });
    } catch (err) {
      res.status(err.statusCode || 500).json({
        success: false,
        error: err.message,
        details: err.details || null
      });
    }
  }
);

/**
 * POST /api/transactions/transfer
 * Internal transfer between two accounts.
 * Entitlement: Must own source account (or Admin). Auditors forbidden.
 */
router.post(
  '/transfer',
  authenticate,
  requireRoles('ADMIN', 'ACCOUNT_HOLDER'),
  requireAccountEntitlement({ accountIdParam: 'sourceAccountId', isWriteOperation: true }),
  idempotencyMiddleware({ required: true }),
  async (req, res) => {
    try {
      const { sourceAccountId, destinationAccountId, amount, description } = req.body;
      const parsedAmount = parseInt(amount, 10);

      const result = await executeTransfer({
        sourceAccountId,
        destinationAccountId,
        amount: parsedAmount,
        description: description || 'Internal transfer',
        initiatedByUserId: req.user.id,
        idempotencyKey: req.idempotencyKey
      });

      res.status(200).json({
        success: true,
        message: 'Transfer executed successfully.',
        transaction: result
      });
    } catch (err) {
      res.status(err.statusCode || 500).json({
        success: false,
        error: err.message,
        details: err.details || null
      });
    }
  }
);

module.exports = router;
