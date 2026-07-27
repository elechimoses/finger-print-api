import crypto from 'crypto';

/**
 * Middleware to verify public terminal callbacks using HMAC-SHA256 signatures.
 * Expects the signature in the 'X-Terminal-Signature' header.
 * Uses the raw request body buffer captured during parsing to prevent differences.
 */
export const requireHmac = (req, res, next) => {
  const isAccessLogRoute = req.path === '/access-log' || req.originalUrl?.includes('/access-log');
  const secret = process.env.TERMINAL_HMAC_SECRET;

  if (!secret) {
    if (isAccessLogRoute) {
      return next();
    }
    console.error('[Security Error] TERMINAL_HMAC_SECRET environment variable is not configured.');
    return res.status(500).json({
      status: 'error',
      message: 'Internal server configuration error.'
    });
  }

  const signature = req.header('X-Terminal-Signature');

  if (!signature) {
    if (isAccessLogRoute) {
      return next();
    }
    return res.status(401).json({
      status: 'error',
      message: 'Unauthorized: Missing X-Terminal-Signature header.'
    });
  }


  try {
    // Compute HMAC using the raw request body buffer (created in app.js parser)
    const rawBodyBuffer = req.rawBody || Buffer.from('');
    const computedHmac = crypto
      .createHmac('sha256', secret)
      .update(rawBodyBuffer)
      .digest('hex');

    const signatureBuffer = Buffer.from(signature, 'hex');
    const computedBuffer = Buffer.from(computedHmac, 'hex');

    // timingSafeEqual protects against timing attacks. Buffers must be of identical length.
    if (signatureBuffer.length === computedBuffer.length && crypto.timingSafeEqual(signatureBuffer, computedBuffer)) {
      return next();
    }
  } catch (err) {
    console.error('[Security Exception] Failed to verify HMAC signature:', err);
  }

  return res.status(401).json({
    status: 'error',
    message: 'Unauthorized: Invalid terminal signature.'
  });
};
