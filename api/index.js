const path = require('node:path');

// Ensure writable SQLite path on serverless platforms
if (process.env.VERCEL) {
  process.env.DB_PATH = path.join('/tmp', 'ledgerline.db');
}

const { createServer } = require('../src/server');
const { getDatabase } = require('../src/db/database');
const { seedDatabase } = require('../src/db/seed');

let appInstance = null;

function getApp() {
  if (!appInstance) {
    const db = getDatabase();
    seedDatabase(db);
    appInstance = createServer();
  }
  return appInstance;
}

module.exports = (req, res) => {
  const app = getApp();
  return app(req, res);
};
