import express from 'express';
import crypto from 'crypto';
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
    let body = req.body || {};
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch (e) {
        body = {};
      }
    } else if ((!body || Object.keys(body).length === 0) && req.rawBody && req.rawBody.length > 0) {
      try {
        body = JSON.parse(req.rawBody.toString('utf8'));
      } catch (e) {
        body = {};
      }
    }

    const uid = body.uid || body.cardUid || body.card_uid || body.rfid_uid || body.cardId || req.query?.uid || req.query?.cardUid;

    if (!uid) {
      return res.status(200).json({ status: false, success: false, message: 'Missing RFID UID parameter.', livenessScore: 0 });
    }

    let card = await db.getCardBySerial(uid);
    if (!card) {
      card = await db.getCardById(uid);
    }
    if (!card) {
      const { cards = [] } = (await db.getCards({ pageSize: 1000 })) || {};
      card = cards.find(
        (c) => c.serial === uid || c.id === uid || c.serial?.toLowerCase() === String(uid).toLowerCase()
      );
    }


    if (card && card.status === 'active') {
      const livenessScore = Number(body.livenessScore || body.padScore || req.body?.livenessScore || 0.98);

      const updates = { lastSeen: new Date().toISOString() };
      if (card.syncStatus === 'failed') {
        updates.syncStatus = 'synced';
      }
      await db.updateCard(card.id, updates);

      await db.addAuditLog({
        id: `evt-${crypto.randomBytes(4).toString('hex')}`,
        timestamp: new Date().toISOString(),
        type: 'auth_success',
        cardId: card.id,
        holder: card.holder,
        details: `Access granted for RFID UID: ${uid} (Fingerprint Liveness Score: ${Math.round(livenessScore * 100)}%)`,
        padScore: livenessScore,
        rawMetrics: { livenessScore, rfidUid: uid, fingerId: card.fingerId },
        receipt: { action: 'AUTHENTICATE_SUCCESS' }
      });

      broadcastApdu({
        command: `00 20 00 00 08 (VERIFY FINGERPRINT ID #${card.fingerId || 1})`,
        response: '90 00 (SW_SUCCESS)',
        durationMs: Math.floor(25 + Math.random() * 20),
      });

      return res.status(200).json({
        status: true,
        success: true,
        fingerId: card.fingerId || card.id,
        fingerprint_id: card.fingerId || card.id,
        cardId: card.id,
        user_id: card.id,
        holder: card.holder,
        name: card.holder,
        livenessScore,
      });
    }

    const failureLiveness = Number(body.livenessScore || body.padScore || req.body?.livenessScore || 0.15);

    await db.addAuditLog({
      id: `evt-${crypto.randomBytes(4).toString('hex')}`,
      timestamp: new Date().toISOString(),
      type: 'auth_fail',
      cardId: card ? card.id : null,
      holder: card ? card.holder : `Unknown User (${uid})`,
      details: card
        ? `Access denied (Status: ${card.status}) for RFID UID: ${uid}`
        : `Access denied (Unknown Card / Fingerprint mismatch for UID: ${uid})`,
      padScore: failureLiveness,
      rawMetrics: { livenessScore: failureLiveness, rfidUid: uid },
      receipt: { action: 'AUTHENTICATE_FAIL' }
    });

    broadcastApdu({
      command: `00 20 00 00 08 (VERIFY FINGERPRINT/RFID)`,
      response: '6A 88 (SW_VERIFICATION_FAILED)',
      durationMs: Math.floor(40 + Math.random() * 25),
    });

    return res.status(200).json({
      status: false,
      success: false,
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
/**
 * 5. POST /access-log
 * Hardware Access Log callback endpoint (called directly by ESP32 hardware)
 * Payload format from hardware:
 * {
 *   "terminalId": "TERM-01",
 *   "cardUid": "...",
 *   "verifyId": "evt-...",
 *   "success": true | false | "true" | "false",
 *   "reason": "...",
 *   "fingerId": 1,
 *   "timestamp": "2026-07-27T21:05:25Z"
 * }
 */
router.post('/access-log', async (req, res, next) => {
  try {
    let body = req.body || {};
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch (e) {
        body = {};
      }
    } else if ((!body || Object.keys(body).length === 0) && req.rawBody && req.rawBody.length > 0) {
      try {
        body = JSON.parse(req.rawBody.toString('utf8'));
      } catch (e) {
        body = {};
      }
    }

    const terminalId = body.terminalId || body.terminal_id || req.query?.terminalId || 'TERM-ESP32-01';
    const cardUid = body.cardUid || body.card_uid || body.cardId || body.uid || req.query?.cardUid || req.query?.uid || '';
    const rawSuccess = body.success !== undefined ? body.success : (body.status !== undefined ? body.status : req.query?.success);
    
    let isSuccess = false;
    if (typeof rawSuccess === 'boolean') {
      isSuccess = rawSuccess;
    } else if (typeof rawSuccess === 'number') {
      isSuccess = rawSuccess === 1;
    } else if (typeof rawSuccess === 'string') {
      const lower = rawSuccess.trim().toLowerCase();
      isSuccess = lower === 'true' || lower === '1' || lower === 'success' || lower === 'grant';
    } else {
      isSuccess = Boolean(rawSuccess);
    }

    const reason = body.reason || req.query?.reason || (isSuccess ? 'Access Granted' : 'Access Denied');
    const fingerId = body.fingerId !== undefined ? body.fingerId : (body.finger_id !== undefined ? body.finger_id : req.query?.fingerId);
    const timestamp = body.timestamp || req.query?.timestamp || new Date().toISOString();

    let card = null;
    if (cardUid && cardUid !== 'UNKNOWN') {
      card = await db.getCardBySerial(cardUid) || await db.getCardById(cardUid);
      if (!card) {
        const { cards = [] } = (await db.getCards({ pageSize: 1000 })) || {};
        card = cards.find(
          (c) => c.serial === cardUid || c.id === cardUid || c.serial?.toLowerCase() === String(cardUid).toLowerCase()
        );
      }
    }

    if (card) {
      const updates = { lastSeen: new Date().toISOString() };
      if (isSuccess && card.syncStatus === 'failed') {
        updates.syncStatus = 'synced';
      }
      await db.updateCard(card.id, updates);
    }

    let eventType = isSuccess ? 'auth_success' : 'auth_fail';
    const reasonLower = (reason || '').toLowerCase();
    if (!isSuccess) {
      if (reasonLower.includes('enroll')) {
        eventType = 'enrollment';
      } else if (reasonLower.includes('spoof') || reasonLower.includes('tamper') || reasonLower.includes('fake') || reasonLower.includes('liveness')) {
        eventType = 'spoof';
      } else {
        eventType = 'auth_fail';
      }
    } else {
      if (reasonLower.includes('enroll')) {
        eventType = 'enrollment';
      }
    }

    const finalFingerId = fingerId !== undefined && fingerId !== null ? Number(fingerId) : null;
    const padScoreVal = isSuccess ? 0.98 : (eventType === 'spoof' ? 0.15 : 0.45);

    // --- Correlation Logic: Match log to recent /verify request ---
    const verifyId = body.verifyId || body.verify_id || body.logId || body.transactionId || body.transaction_id || req.query?.verifyId || req.query?.logId;

    let targetEvent = null;
    if (verifyId) {
      targetEvent = await db.getAuditLogById(verifyId);
    }

    if (!targetEvent && cardUid && cardUid !== 'UNKNOWN') {
      const { events: recentLogs = [] } = (await db.getAuditLogs({ limit: 10 })) || {};
      const nowMs = Date.now();
      targetEvent = recentLogs.find((l) => {
        if (!l || !l.timestamp) return false;
        const ageMs = nowMs - new Date(l.timestamp).getTime();
        const matchesCard = (l.cardId === (card ? card.id : null)) || (l.rawMetrics?.rfidUid === cardUid);
        return matchesCard && ageMs >= 0 && ageMs <= 30000;
      });
    }


    if (targetEvent) {
      // Update existing verify event with full hardware telemetry
      await db.updateAuditLog(targetEvent.id, {
        type: eventType,
        details: `[${terminalId}] ${reason}${finalFingerId !== null ? ` (Finger ID: ${finalFingerId})` : ''}${cardUid ? ` [Match On Card: ${cardUid}]` : ''}`,
        padScore: padScoreVal,
        rawMetrics: {
          ...(targetEvent.rawMetrics || {}),
          terminalId,
          cardUid: cardUid || null,
          fingerId: finalFingerId,
          reason,
          success: isSuccess,
          padConfidence: padScoreVal,
          hardwareTimestamp: timestamp,
          updatedAt: new Date().toISOString(),
        },
        receipt: {
          action: isSuccess ? 'AUTHENTICATE_SUCCESS' : (eventType === 'enrollment' ? 'ENROLLMENT_FAIL' : 'AUTHENTICATE_FAIL'),
          terminalId,
          reason,
        },
      });

      broadcastApdu({
        command: `00 20 00 00 (${eventType.toUpperCase()} fingerId: ${finalFingerId ?? 'N/A'})`,
        response: isSuccess ? '90 00 (SW_SUCCESS)' : (eventType === 'enrollment' ? '6F 00 (SW_ENROLL_ERR)' : '6A 88 (SW_VERIFICATION_FAILED)'),
        durationMs: Math.floor(25 + Math.random() * 20),
        terminalId,
      });

      return res.status(200).json({
        status: 'success',
        success: true,
        correlated: true,
        verifyId: targetEvent.id,
        eventId: targetEvent.id,
        message: 'Access log correlated and updated successfully in database.',
        event: targetEvent,
      });
    }

    const newEvent = {
      id: `evt-${crypto.randomBytes(4).toString('hex')}`,
      timestamp,
      type: eventType,
      cardId: card ? card.id : null,
      holder: card ? card.holder : (cardUid && cardUid !== 'UNKNOWN' ? `Terminal User (${cardUid})` : 'Terminal User'),
      details: `[${terminalId}] ${reason}${finalFingerId !== null ? ` (Finger ID: ${finalFingerId})` : ''}${cardUid ? ` [Match On Card: ${cardUid}]` : ''}`,
      rawMetrics: {
        terminalId,
        cardUid: cardUid || null,
        fingerId: finalFingerId,
        reason,
        success: isSuccess,
        padConfidence: padScoreVal,
      },
      receipt: {
        action: isSuccess ? 'AUTHENTICATE_SUCCESS' : (eventType === 'enrollment' ? 'ENROLLMENT_FAIL' : 'AUTHENTICATE_FAIL'),
        terminalId,
        reason,
      },
      minutiaeMapPoints: [],
      padScore: padScoreVal,
    };

    await db.addAuditLog(newEvent);

    broadcastApdu({
      command: `00 20 00 00 (${eventType.toUpperCase()} fingerId: ${finalFingerId ?? 'N/A'})`,
      response: isSuccess ? '90 00 (SW_SUCCESS)' : (eventType === 'enrollment' ? '6F 00 (SW_ENROLL_ERR)' : '6A 88 (SW_VERIFICATION_FAILED)'),
      durationMs: Math.floor(25 + Math.random() * 20),
      terminalId,
    });

    return res.status(200).json({
      status: 'success',
      success: true,
      correlated: false,
      eventId: newEvent.id,
      message: 'Access log recorded successfully to database.',
      event: newEvent,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
