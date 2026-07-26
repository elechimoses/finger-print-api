import { db } from '../store/mockDb.js';

/**
 * Middleware to protect private routes by ensuring the site has been unlocked.
 * Checks the session_token cookie and verifies it against the active session store.
 */
export const requireSession = async (req, res, next) => {
  const token =
    req.cookies?.session_token ||
    req.headers['x-session-token'] ||
    req.headers.authorization?.replace(/^Bearer\s+/i, '');

  if (!token) {
    return res.status(401).json({
      status: 'error',
      unlocked: false,
      message: 'Unauthorized: Access denied. The site is locked.'
    });
  }

  try {
    const session = await db.getSession(token);

    if (!session) {
      return res.status(401).json({
        status: 'error',
        unlocked: false,
        message: 'Unauthorized: Session invalid or expired. Please unlock the site again.'
      });
    }

    // Check expiration
    if (new Date() > new Date(session.expiresAt)) {
      await db.deleteSession(token); // Clean up expired session
      res.clearCookie('session_token');
      return res.status(401).json({
        status: 'error',
        unlocked: false,
        message: 'Unauthorized: Session expired. Please unlock the site again.'
      });
    }

    // Extend session expiry on activity (optional, but good UX)
    const nextExpiry = new Date(Date.now() + 1000 * 60 * 60 * 2).toISOString(); // Slide 2 hours
    await db.setSession(token, nextExpiry);

    next();
  } catch (err) {
    next(err);
  }
};

