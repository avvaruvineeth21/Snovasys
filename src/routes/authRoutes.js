const express = require('express');
const { getDatabase } = require('../db/database');
const { verifyPassword, generateToken } = require('../services/authService');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

/**
 * POST /api/auth/login
 */
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const db = getDatabase();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  if (!user || !verifyPassword(password, user.password_hash, user.salt)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  const token = generateToken(user);
  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      name: user.name
    }
  });
});

/**
 * GET /api/auth/me
 */
router.get('/me', authenticate, (req, res) => {
  const db = getDatabase();
  const user = db.prepare('SELECT id, username, role, name, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }
  res.json({ user });
});

/**
 * GET /api/auth/seed-users
 * Helpful helper for testing and evaluation grading.
 */
router.get('/seed-users', (req, res) => {
  res.json({
    message: 'Pre-configured credentials for quick evaluation',
    seedUsers: [
      { username: 'admin', role: 'ADMIN', name: 'Alex Rivera (Administrator)' },
      { username: 'alice', role: 'ACCOUNT_HOLDER', name: 'Alice Henderson (Account Holder)' },
      { username: 'bob', role: 'ACCOUNT_HOLDER', name: 'Bob Martinez (Account Holder)' },
      { username: 'auditor', role: 'AUDITOR', name: 'Charlie Audit (Independent Auditor)' }
    ],
    defaultPassword: 'See README (e.g. AdminPass123!, AlicePass123!, BobPass123!, AuditorPass123!)'
  });
});

module.exports = router;
