const path = require('node:path');

const config = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  dbPath: process.env.DB_PATH || (process.env.VERCEL ? path.join('/tmp', 'ledgerline.db') : path.join(__dirname, '..', 'ledgerline.db')),
  jwtSecret: process.env.JWT_SECRET || 'ledgerline-enterprise-grade-secret-key-2026',
  tokenExpiryHours: 24,
  currency: 'USD',
  // System clearing account IDs
  systemAccounts: {
    cashInflow: 'acc_system_cash_inflow',
    cashOutflow: 'acc_system_cash_outflow'
  }
};

module.exports = config;
