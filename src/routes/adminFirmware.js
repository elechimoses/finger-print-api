import express from 'express';
import { db } from '../store/mockDb.js';

const router = express.Router();

/**
 * Helper to initiate an enrollment session with a strict 45-second timeout.
 */
async function startEnrollmentSession(req, res, next) {
  try {
    const userName = req.body.userName || req.body.name || req.body.username;
    let fingerId = req.body.fingerId || req.body.fingerprintId || req.body.fingerprint_id;

    if (!userName) {
      return res.status(400).json({
        status: 'error',
        message: 'userName (string) is required.',
      });
    }

    if (fingerId === undefined || fingerId === null) {
      const { cards = [] } = await db.getCards({ pageSize: 1000 });
      const maxFingerId = cards.reduce((max, c) => {
        const idNum = parseInt(c.fingerId, 10);
        return !isNaN(idNum) && idNum > max ? idNum : max;
      }, 0);
      fingerId = maxFingerId + 1;
    } else {
      fingerId = Number(fingerId);
    }

    const sessionData = {
      id: 'active_admin_session',
      fingerId,
      userName: String(userName).trim(),
      status: 'pending',
      scannedSerial: null,
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + 45000, // Strict 45-second timeout
    };

    await db.setEnrollmentSession('active_admin_session', sessionData);

    return res.status(200).json({
      status: 'success',
      message: `Enrollment session started for "${userName}" (fingerId: ${fingerId}). Auto-timeout in 45s.`,
      targetFingerId: fingerId,
      expiresIn: 45,
      session: sessionData,
    });
  } catch (err) {
    next(err);
  }
}

// Support both POST /api/admin/enroll and POST /admin/start-enrollment
router.post('/enroll', startEnrollmentSession);
router.post('/start-enrollment', startEnrollmentSession);

/**
 * GET /api/admin/enroll/status
 * Returns current active enrollment session state for polling.
 */
router.get('/enroll/status', async (req, res, next) => {
  try {
    const session = await db.getEnrollmentSession('active_admin_session');

    if (!session) {
      return res.status(200).json({ status: 'idle', session: null });
    }

    const isExpired = session.expiresAt <= Date.now();
    if (isExpired) {
      await db.deleteEnrollmentSession('active_admin_session');
      return res.status(200).json({ status: 'idle', session: null });
    }

    return res.status(200).json({
      status: session.status || 'pending',
      session,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/users
 * List all registered users with RFID UIDs, finger IDs, and access logs.
 */
router.get('/users', async (req, res, next) => {
  try {
    const { cards = [] } = await db.getCards({ pageSize: 1000 });
    const auditRes = await db.getAuditLogs({ limit: 1000 });
    const logs = Array.isArray(auditRes) ? auditRes : (auditRes.logs || []);

    const users = cards.map((c) => {
      const userLogs = logs.filter(
        (l) => l.cardId === c.id || l.cardId === c.serial || l.holder === c.holder
      );
      return {
        user_id: c.id,
        name: c.holder,
        rfid_uid: c.serial,
        fingerprint_id: c.fingerId || c.id,
        status: c.status,
        templateFormat: c.templateFormat,
        syncStatus: c.syncStatus,
        created_at: c.lastSeen,
        accessLogs: userLogs,
      };
    });

    return res.status(200).json({
      status: 'success',
      total: users.length,
      users,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/admin/users/:id or DELETE /api/admin/cards/:id
 * Revoke user access or permanently delete card (with ?permanent=true or ?action=delete).
 */
async function deleteOrRevokeUserCard(req, res, next) {
  try {
    const { id } = req.params;
    const isPermanent = req.query?.permanent === 'true' || req.query?.action === 'delete' || req.path.includes('/cards/');
    
    const { cards = [] } = await db.getCards({ pageSize: 1000 });
    const card = cards.find((c) => c.id === id || c.serial === id);

    if (!card) {
      return res.status(404).json({ status: 'error', message: `User card ${id} not found.` });
    }

    if (isPermanent) {
      await db.deleteCard(card.id);

      await db.addAuditLog({
        type: 'card_deletion',
        cardId: card.id,
        holder: card.holder,
        details: `User ${card.holder} (RFID UID: ${card.serial}) card deleted via Admin API.`,
        padScore: 0.0,
      });

      return res.status(200).json({
        status: 'success',
        message: `Card for ${card.holder} permanently deleted successfully.`,
        deletedCard: card,
      });
    }

    const updated = await db.updateCard(card.id, {
      status: 'revoked',
      revocationReason: 'Revoked via Admin API',
    });

    await db.addAuditLog({
      type: 'admin_revoke',
      cardId: card.id,
      holder: card.holder,
      details: `User ${card.holder} (RFID UID: ${card.serial}) access revoked via Admin API.`,
      padScore: 0.0,
    });

    return res.status(200).json({
      status: 'success',
      message: `User ${card.holder} access revoked successfully.`,
      user: updated,
    });
  } catch (err) {
    next(err);
  }
}

router.delete('/users/:id', deleteOrRevokeUserCard);
router.delete('/cards/:id', deleteOrRevokeUserCard);

export default router;
