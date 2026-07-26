import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../store/mockDb.js';

const router = Router();

/**
 * @route   POST /api/v1/admin/rotate-password
 * @desc    Rotate SITE_PASSWORD
 * @access  Private (session required)
 */
router.post('/rotate-password', async (req, res, next) => {
  const { newPassword } = req.body;

  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({
      status: 'error',
      message: 'New password must be at least 6 characters long.'
    });
  }

  try {
    await db.rotatePassword(newPassword);

    // Log rotation event
    await db.addAuditLog({
      id: `evt-${crypto.randomBytes(4).toString('hex')}`,
      timestamp: new Date().toISOString(),
      type: 'admin',
      cardId: null,
      holder: null,
      details: 'Site password successfully rotated.',
      rawMetrics: {},
      receipt: { action: 'PASSWORD_ROTATION' },
      minutiaeMapPoints: [],
      padScore: 1.0
    });

    return res.status(200).json({
      status: 'success',
      message: 'Site password rotated successfully.'
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @route   GET /api/v1/admin/operators
 * @desc    List operators
 * @access  Private (session required)
 */
router.get('/operators', async (req, res, next) => {
  try {
    const operators = await db.getOperators();
    return res.status(200).json({
      status: 'success',
      operators
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @route   POST /api/v1/admin/operators
 * @desc    Add operator
 * @access  Private (session required)
 */
router.post('/operators', async (req, res, next) => {
  const { username, role } = req.body;

  if (!username || !role) {
    return res.status(400).json({
      status: 'error',
      message: 'Username and role are required.'
    });
  }

  try {
    const existing = await db.getOperatorByUsername(username);
    if (existing) {
      return res.status(400).json({
        status: 'error',
        message: 'Operator username already exists.'
      });
    }

    const newOperator = {
      id: `op-${crypto.randomBytes(4).toString('hex')}`,
      username,
      role,
      createdAt: new Date().toISOString()
    };

    await db.addOperator(newOperator);

    // Log operator creation
    await db.addAuditLog({
      id: `evt-${crypto.randomBytes(4).toString('hex')}`,
      timestamp: new Date().toISOString(),
      type: 'admin',
      cardId: null,
      holder: null,
      details: `Added new operator account: ${username} (${role}).`,
      rawMetrics: {},
      receipt: { targetOperator: username, role },
      minutiaeMapPoints: [],
      padScore: 1.0
    });

    return res.status(201).json({
      status: 'success',
      operator: newOperator
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @route   DELETE /api/v1/admin/operators/:operatorId
 * @desc    Remove operator
 * @access  Private (session required)
 */
router.delete('/operators/:operatorId', async (req, res, next) => {
  const { operatorId } = req.params;

  try {
    const operators = await db.getOperators();
    const removedOp = operators.find(op => op.id === operatorId);

    if (!removedOp) {
      return res.status(404).json({
        status: 'error',
        message: 'Operator not found.'
      });
    }

    // Protect admin from self-deletion
    if (removedOp.username === 'admin') {
      return res.status(400).json({
        status: 'error',
        message: 'Cannot delete the primary administrator account.'
      });
    }

    await db.deleteOperator(operatorId);

    // Log operator removal
    await db.addAuditLog({
      id: `evt-${crypto.randomBytes(4).toString('hex')}`,
      timestamp: new Date().toISOString(),
      type: 'admin',
      cardId: null,
      holder: null,
      details: `Removed operator account: ${removedOp.username}.`,
      rawMetrics: {},
      receipt: { targetOperator: removedOp.username },
      minutiaeMapPoints: [],
      padScore: 1.0
    });

    return res.status(200).json({
      status: 'success',
      message: `Operator ${removedOp.username} removed successfully.`
    });
  } catch (err) {
    next(err);
  }
});

export default router;
