import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../store/mockDb.js';

const router = Router();

/**
 * @route   POST /api/v1/auth/unlock
 * @desc    Verify admin password, set session cookie
 * @access  Public
 */
router.post('/unlock', async (req, res, next) => {
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({
      status: 'error',
      unlocked: false,
      message: 'Password is required.'
    });
  }

  try {
    const sitePassword = await db.getSitePassword();

    if (password !== sitePassword) {
      // Log failed login attempt
      await db.addAuditLog({
        id: `evt-${crypto.randomBytes(4).toString('hex')}`,
        timestamp: new Date().toISOString(),
        type: 'admin',
        cardId: null,
        holder: null,
        details: 'Failed site unlock attempt: Incorrect password.',
        rawMetrics: {},
        receipt: { ip: req.ip },
        minutiaeMapPoints: [],
        padScore: 0
      });

      return res.status(401).json({
        status: 'error',
        unlocked: false,
        message: 'Invalid password.'
      });
    }

    // Password correct, generate secure session token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 2).toISOString(); // 2 hours

    await db.setSession(token, expiresAt);

    // Set secure HTTP-only cookie
    res.cookie('session_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 2 * 60 * 60 * 1000 // 2 hours
    });

    // Write success log
    await db.addAuditLog({
      id: `evt-${crypto.randomBytes(4).toString('hex')}`,
      timestamp: new Date().toISOString(),
      type: 'admin',
      cardId: null,
      holder: null,
      details: 'Site successfully unlocked.',
      rawMetrics: {},
      receipt: { ip: req.ip },
      minutiaeMapPoints: [],
      padScore: 1.0
    });

    return res.status(200).json({
      status: 'success',
      unlocked: true,
      message: 'Site unlocked successfully.'
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @route   GET /api/v1/auth/status
 * @desc    Check session status (used by route guards)
 * @access  Public
 */
router.get('/status', async (req, res, next) => {
  const token = req.cookies?.session_token;

  if (!token) {
    return res.status(200).json({ unlocked: false });
  }

  try {
    const session = await db.getSession(token);

    if (!session || new Date() > new Date(session.expiresAt)) {
      if (session) {
        await db.deleteSession(token);
      }
      return res.status(200).json({ unlocked: false });
    }

    return res.status(200).json({ unlocked: true });
  } catch (err) {
    next(err);
  }
});

/**
 * @route   POST /api/v1/auth/lock
 * @desc    Clear session (sign out)
 * @access  Public
 */
router.post('/lock', async (req, res, next) => {
  const token = req.cookies?.session_token;

  try {
    if (token) {
      await db.deleteSession(token);
    }

    res.clearCookie('session_token');

    return res.status(200).json({
      status: 'success',
      unlocked: false,
      message: 'Site locked successfully.'
    });
  } catch (err) {
    next(err);
  }
});

export default router;
