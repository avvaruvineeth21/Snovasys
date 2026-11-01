const { handleIdempotency, completeIdempotency, failIdempotency } = require('../services/idempotencyService');

function idempotencyMiddleware({ required = true } = {}) {
  return async (req, res, next) => {
    const key = req.headers['idempotency-key'] || req.headers['x-idempotency-key'] || req.body?.idempotencyKey;

    if (!key) {
      if (required) {
        return res.status(400).json({
          error: 'Missing required Idempotency-Key header for financial transaction.'
        });
      }
      return next();
    }

    req.idempotencyKey = key;
    const userId = req.user?.id || 'anonymous';

    try {
      const result = await handleIdempotency({
        key,
        userId,
        path: req.originalUrl || req.path,
        body: req.body
      });

      if (result.status === 'CACHED') {
        res.setHeader('X-Idempotency-Replay', 'true');
        res.setHeader('X-Duplicate-Count', result.duplicateCount);
        return res.status(result.code).json(result.body);
      }

      if (result.status === 'MISMATCH') {
        return res.status(422).json({
          error: 'Unprocessable Entity: Idempotency key reuse with mismatched parameters.',
          details: result.message
        });
      }

      if (result.status === 'IN_FLIGHT_TIMEOUT') {
        return res.status(409).json({
          error: 'Conflict: In-flight request pending.',
          details: result.message
        });
      }

      // Intercept res.json to capture response and complete idempotency
      const originalJson = res.json.bind(res);
      res.json = (body) => {
        // Complete idempotency record
        try {
          completeIdempotency({
            key,
            code: res.statusCode,
            body
          });
        } catch (saveErr) {
          console.error('Failed to save idempotency response:', saveErr);
        }
        return originalJson(body);
      };

      next();
    } catch (err) {
      failIdempotency({ key });
      next(err);
    }
  };
}

module.exports = {
  idempotencyMiddleware
};
