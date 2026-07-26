import express from 'express';
import { db } from '../store/mockDb.js';
import { broadcastApdu } from './apduStream.js';

const router = express.Router();

/**
 * 1. POST /verify
 * Request Body: uid=<string> (application/x-www-form-urlencoded or JSON)
 * Action: Look up user matching uid. Record audit log entry in Postgres (success vs failure with liveness score), broadcast APDU, and return result.
 */
router.post('/verify', async (req, res, next) => {
  try {
    const uid = req.body?.uid || req.query?.uid;

    if (!uid) {
      return res.status(200).json({ status: false, message: 'Missing RFID UID parameter.', livenessScore: 0 });
    }

    let card = await db.getCardBySerial(uid);
    if (!card) {
      card = await db.getCardById(uid);
    }
    if (!card) {
      const { cards = [] } = await db.getCards({ pageSize: 1000 });
      card = cards.find(
        (c) => c.serial === uid || c.id === uid || c.serial?.toLowerCase() === uid.toLowerCase()
      );
    }

    if (card && card.status === 'active') {
      const livenessScore = Number(req.body?.livenessScore || req.body?.padScore || 0.98);

      await db.addAuditLog({
        type: 'auth_success',
        cardId: card.id,
        holder: card.holder,
        details: `Access granted for RFID UID: ${uid} (Fingerprint Liveness Score: ${Math.round(livenessScore * 100)}%)`,
        padScore: livenessScore,
        rawMetrics: { livenessScore, rfidUid: uid, fingerId: card.fingerId },
      });

      broadcastApdu({
        command: `00 20 00 00 08 (VERIFY FINGERPRINT ID #${card.fingerId || 1})`,
        response: '90 00 (SW_SUCCESS)',
        durationMs: Math.floor(25 + Math.random() * 20),
      });

      return res.status(200).json({
        status: true,
        fingerId: card.fingerId || card.id,
        cardId: card.id,
        holder: card.holder,
        livenessScore,
      });
    }

    const failureLiveness = Number(req.body?.livenessScore || req.body?.padScore || 0.15);

    await db.addAuditLog({
      type: 'auth_fail',
      cardId: card ? card.id : uid,
      holder: card ? card.holder : 'Unknown User',
      details: card
        ? `Access denied (Status: ${card.status}) for RFID UID: ${uid}`
        : `Access denied (Unknown Card / Fingerprint mismatch for UID: ${uid})`,
      padScore: failureLiveness,
      rawMetrics: { livenessScore: failureLiveness, rfidUid: uid },
    });

    broadcastApdu({
      command: `00 20 00 00 08 (VERIFY FINGERPRINT/RFID)`,
      response: '6A 88 (SW_VERIFICATION_FAILED)',
      durationMs: Math.floor(40 + Math.random() * 25),
    });

    return res.status(200).json({
      status: false,
      message: card ? `Access denied (Card status: ${card.status})` : 'Access denied. Unknown card or liveness check failed.',
      livenessScore: failureLiveness,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * 2. GET /add-card
 * Logic: Polled every 4 seconds by ESP32.
 * - If active enrollment session exists (< 45s old): Return {"status": "pending", "fingerId": 5}
 * - If no session is active or older than 45 seconds: Return {"status": "idle"}
 */
router.get('/add-card', async (req, res, next) => {
  try {
    const session = await db.getEnrollmentSession('active_admin_session');

    if (session && session.expiresAt > Date.now()) {
      return res.status(200).json({
        status: 'pending',
        fingerId: session.fingerId || 5,
        userName: session.userName,
      });
    }

    if (session && session.expiresAt <= Date.now()) {
      await db.deleteEnrollmentSession('active_admin_session');
    }

    return res.status(200).json({ status: 'idle' });
  } catch (err) {
    next(err);
  }
});

/**
 * 3. POST /save-card
 * Content-Type: application/x-www-form-urlencoded or JSON
 * Request Body: uid=<string>
 * Action: Check if card is already enrolled. If duplicate, terminate enrollment and return error.
 */
router.post('/save-card', async (req, res, next) => {
  try {
    const uid = req.body?.uid || req.query?.uid;

    if (!uid) {
      return res.status(400).json({ success: false, message: 'Missing RFID UID parameter.' });
    }

    // Check if card with this UID already exists in database
    const existingCard = (await db.getCardBySerial(uid)) || (await db.getCardById(uid));
    if (existingCard) {
      await db.deleteEnrollmentSession('active_admin_session');

      await db.addAuditLog({
        type: 'auth_fail',
        cardId: existingCard.id,
        holder: existingCard.holder,
        details: `Duplicate enrollment rejected for RFID UID ${uid}. Card is already assigned to ${existingCard.holder}.`,
        padScore: 0.0,
      });

      return res.status(400).json({
        success: false,
        status: 'error',
        message: `This card (UID: ${uid}) has already been enrolled in the system for "${existingCard.holder}".`,
      });
    }

    const session = await db.getEnrollmentSession('active_admin_session');
    const fingerId = session?.fingerId || req.body?.fingerId || 5;
    const userName = session?.userName || req.body?.userName || 'Enrolled User';

    const newCard = {
      id: `card-${Math.floor(100 + Math.random() * 900)}`,
      holder: userName,
      serial: uid,
      templateFormat: 'ISO 19794-2',
      minutiaeCount: 42,
      fingerId,
      syncStatus: 'synced',
      status: 'active',
      lastSeen: new Date().toISOString(),
    };

    try {
      await db.addCard(newCard);
    } catch (err) {
      await db.deleteEnrollmentSession('active_admin_session');
      return res.status(400).json({
        success: false,
        status: 'error',
        message: err.message || `This card (UID: ${uid}) has already been enrolled.`,
      });
    }

    await db.addAuditLog({
      type: 'enrollment',
      cardId: newCard.id,
      holder: newCard.holder,
      details: `Card enrolled with RFID UID ${uid} and fingerId ${fingerId}`,
      padScore: 1.0,
    });

    broadcastApdu({
      command: `00 D6 00 00 10 (WRITE_CREDENTIAL_RECORD UID: ${uid})`,
      response: '90 00 (SW_SUCCESS)',
      durationMs: 45,
    });

    // Explicitly clear pending enrollment session
    await db.deleteEnrollmentSession('active_admin_session');

    return res.status(200).json({ success: true, card: newCard });
  } catch (err) {
    next(err);
  }
});

/**
 * 4. POST /complete-enrollment
 * Content-Type: application/x-www-form-urlencoded or JSON
 * Payload: fingerId=<int>&uid=<string>&userName=<string>
 */
router.post('/complete-enrollment', async (req, res, next) => {
  try {
    const uid = req.body?.uid || req.body?.rfid_uid || req.query?.uid;
    const fingerId = req.body?.fingerId || req.body?.fingerprint_id || req.body?.fingerprintId || 5;
    const userName = req.body?.userName || req.body?.name || req.body?.userName || 'Enrolled User';

    if (!uid) {
      return res.status(400).json({ success: false, message: 'Missing uid/rfid_uid parameter.' });
    }

    // Check if card with this UID already exists in database
    const existingCard = (await db.getCardBySerial(uid)) || (await db.getCardById(uid));
    if (existingCard) {
      await db.deleteEnrollmentSession('active_admin_session');
      return res.status(400).json({
        success: false,
        status: 'error',
        message: `This card (UID: ${uid}) has already been enrolled in the system for "${existingCard.holder}".`,
      });
    }

    const newCard = {
      id: `user-${Math.floor(1000 + Math.random() * 9000)}`,
      holder: String(userName).trim(),
      serial: String(uid).trim(),
      templateFormat: 'ISO 19794-2',
      minutiaeCount: 42,
      fingerId: Number(fingerId),
      syncStatus: 'synced',
      status: 'active',
      lastSeen: new Date().toISOString(),
    };

    try {
      await db.addCard(newCard);
    } catch (err) {
      await db.deleteEnrollmentSession('active_admin_session');
      return res.status(400).json({
        success: false,
        status: 'error',
        message: err.message || `This card (UID: ${uid}) has already been enrolled.`,
      });
    }

    await db.addAuditLog({
      type: 'enrollment',
      cardId: newCard.id,
      holder: newCard.holder,
      details: `Enrollment completed: user_id=${newCard.id}, rfid_uid=${newCard.serial}, fingerprint_id=${newCard.fingerId}`,
      padScore: 1.0,
    });

    broadcastApdu({
      command: `00 A4 04 00 0B (COMMIT_USER_PROFILE ID #${newCard.fingerId})`,
      response: '90 00 (SW_SUCCESS)',
      durationMs: 38,
    });

    await db.deleteEnrollmentSession('active_admin_session');

    return res.status(200).json({
      success: true,
      user_id: newCard.id,
      name: newCard.holder,
      rfid_uid: newCard.serial,
      fingerprint_id: newCard.fingerId,
      created_at: newCard.lastSeen,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
