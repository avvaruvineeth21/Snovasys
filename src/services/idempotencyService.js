const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const { getDatabase } = require('../db/database');

const inFlightEvents = new EventEmitter();
inFlightEvents.setMaxListeners(100);

/**
 * Creates a deterministic SHA-256 hash of the request path and body.
 */
function hashRequest(path, body) {
  // Canonicalize body by sorting keys to ensure key order invariance
  const canonicalBody = body && typeof body === 'object'
    ? JSON.stringify(body, Object.keys(body).sort())
    : String(body || '');

  return crypto
    .createHash('sha256')
    .update(`${path}:${canonicalBody}`, 'utf8')
    .digest('hex');
}

/**
 * Validates, records or waits on an idempotency key.
 * 
 * Returns:
 * - { status: 'NEW' } -> Proceed with execution
 * - { status: 'CACHED', code, body, duplicateCount } -> Return cached response
 * - { status: 'MISMATCH', message } -> Payload does not match prior key usage
 */
async function handleIdempotency({ key, userId, path, body, db = getDatabase() }) {
  if (!key) {
    return { status: 'NEW' }; // No key provided (if optional), or handle as error if required
  }

  const reqHash = hashRequest(path, body);

  // Check database for existing record
  const existing = db.prepare(`
    SELECT * FROM idempotency_keys WHERE key = ?
  `).get(key);

  if (!existing) {
    // Attempt to register key as PROCESSING
    try {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO idempotency_keys (key, user_id, request_path, request_hash, status, duplicate_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'PROCESSING', 0, ?, ?)
      `).run(key, userId, path, reqHash, now, now);

      return { status: 'NEW' };
    } catch (err) {
      // If another concurrent thread inserted it at the exact same microsecond
      // fallback to reading it below
    }
  }

  // Reload existing in case of race
  const current = db.prepare('SELECT * FROM idempotency_keys WHERE key = ?').get(key);
  if (!current) {
    return { status: 'NEW' };
  }

  // 1. Check for Parameter Mismatch Attack
  if (current.request_hash !== reqHash) {
    return {
      status: 'MISMATCH',
      message: 'Idempotency key was previously used with different request parameters.'
    };
  }

  // 2. Check if already COMPLETED
  if (current.status === 'COMPLETED') {
    // Increment duplicate count to track replays
    db.prepare(`
      UPDATE idempotency_keys 
      SET duplicate_count = duplicate_count + 1, updated_at = ? 
      WHERE key = ?
    `).run(new Date().toISOString(), key);

    return {
      status: 'CACHED',
      code: current.response_code,
      body: JSON.parse(current.response_body),
      duplicateCount: current.duplicate_count + 1
    };
  }

  // 3. Request is still in flight (status === 'PROCESSING')
  // Wait for the primary request to finish
  return new Promise((resolve) => {
    const eventName = `completed:${key}`;
    const timeout = setTimeout(() => {
      inFlightEvents.removeAllListeners(eventName);
      // If the in-flight request timed out or hung
      resolve({
        status: 'IN_FLIGHT_TIMEOUT',
        message: 'A previous request with this idempotency key is still in progress. Please retry shortly.'
      });
    }, 10000);

    inFlightEvents.once(eventName, (result) => {
      clearTimeout(timeout);

      // Increment duplicate count
      db.prepare(`
        UPDATE idempotency_keys 
        SET duplicate_count = duplicate_count + 1, updated_at = ? 
        WHERE key = ?
      `).run(new Date().toISOString(), key);

      const updated = db.prepare('SELECT duplicate_count FROM idempotency_keys WHERE key = ?').get(key);

      resolve({
        status: 'CACHED',
        code: result.code,
        body: result.body,
        duplicateCount: updated ? updated.duplicate_count : 1
      });
    });
  });
}

/**
 * Marks an idempotency key as COMPLETED with its response.
 * Wakes up all waiting in-flight concurrent requests.
 */
function completeIdempotency({ key, code, body, db = getDatabase() }) {
  if (!key) return;

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE idempotency_keys 
    SET status = 'COMPLETED', response_code = ?, response_body = ?, updated_at = ? 
    WHERE key = ?
  `).run(code, JSON.stringify(body), now, key);

  inFlightEvents.emit(`completed:${key}`, { code, body });
}

/**
 * Marks an idempotency key as FAILED if an unrecoverable exception occurred.
 */
function failIdempotency({ key, db = getDatabase() }) {
  if (!key) return;

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE idempotency_keys 
    SET status = 'FAILED', updated_at = ? 
    WHERE key = ?
  `).run(now, key);

  inFlightEvents.emit(`completed:${key}`, {
    code: 500,
    body: { error: 'Transaction failed during processing.' }
  });
}

module.exports = {
  hashRequest,
  handleIdempotency,
  completeIdempotency,
  failIdempotency
};
