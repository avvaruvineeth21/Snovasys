const express = require('express');
const cors = require('cors');
const path = require('node:path');
const config = require('./config');
const { getDatabase } = require('./db/database');
const { seedDatabase } = require('./db/seed');

const authRoutes = require('./routes/authRoutes');
const accountRoutes = require('./routes/accountRoutes');
const transactionRoutes = require('./routes/transactionRoutes');
const auditRoutes = require('./routes/auditRoutes');

function createServer() {
  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json());

  // Static UI files
  app.use(express.static(path.join(__dirname, 'public')));

  // API Routes
  app.use('/api/auth', authRoutes);
  app.use('/api/accounts', accountRoutes);
  app.use('/api/transactions', transactionRoutes);
  app.use('/api/audit', auditRoutes);

  // Health and System Info
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'UP',
      system: 'LedgerLine Integrity & Settlement Engine',
      version: '1.0.0',
      timestamp: new Date().toISOString()
    });
  });

  // Fallback for Single Page App
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api')) {
      return res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
    next();
  });

  // Global Error Handler
  app.use((err, req, res, next) => {
    console.error('Unhandled Server Error:', err);
    res.status(err.status || 500).json({
      error: err.message || 'Internal Server Error',
      details: err.details || null
    });
  });

  return app;
}

function startServer(port = config.port) {
  // Ensure database and initial seeds are ready
  const db = getDatabase();
  seedDatabase(db);

  const app = createServer();
  const server = app.listen(port, () => {
    console.log(`====================================================`);
    console.log(` LedgerLine Server running on http://localhost:${port}`);
    console.log(` Books balanced. Strict double-entry ledger active.`);
    console.log(`====================================================`);
  });

  return { app, server, db };
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createServer,
  startServer
};
