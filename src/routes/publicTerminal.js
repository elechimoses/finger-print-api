import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../store/mockDb.js';
import { requireHmac } from '../middleware/hmacAuth.js';
import { broadcastApdu } from './apduStream.js';

const router = Router();

// Apply HMAC verification middleware globally to all public terminal callback endpoints
router.use(requireHmac);

/**
 * @route   POST /api/public/terminal/heartbeat
 * @desc    Terminal liveness ping + firmware verification
 * @access  Public (Signed with HMAC)
 */
router.post('/heartbeat', async (req, res, next) => {
  const { terminalId, firmwareVersion, status } = req.body;

  if (!terminalId || !status) {
    return res.status(400).json({
      status: 'error',
      message: 'terminalId and status are required.',
    });
  }

  try {
    const statusVal = status === 'online' ? 'ok' : 'warning';
    const metricVal = `FW: ${firmwareVersion || 'v2.1.4'} - Active (Heartbeat received)`;

    await db.updateSystemLayer('Physical', statusVal, metricVal);

    return res.status(200).json({
      status: 'success',
      ack: true,
      terminalId,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @route   POST /api/public/terminal/auth-event
 * @desc    Reports card authentication attempt (success, fail, or spoof attack)
 * @access  Public (Signed with HMAC)
 */
router.post('/auth-event', async (req, res, next) => {
  const { cardId, success, decision, padScore, livenessScore, details, rawMetrics, receipt, minutiaeMapPoints } = req.body;

  const isSuccess = success !== undefined ? Boolean(success) : (decision === 'grant' || decision === 'authenticate');
  const finalPadScore = parseFloat(padScore || livenessScore || (isSuccess ? 0.98 : 0.15));

  if (!cardId && cardId !== '') {
    return res.status(400).json({
      status: 'error',
      message: 'cardId parameter is required.',
    });
  }

  try {
    const card = await db.getCardById(cardId) || await db.getCardBySerial(cardId);

    if (card) {
      const updates = { lastSeen: new Date().toISOString() };
      if (isSuccess && card.syncStatus === 'failed') {
        updates.syncStatus = 'synced';
      }
      await db.updateCard(card.id, updates);
    }

    let eventType = 'auth_fail';
    if (isSuccess) {
      eventType = 'auth_success';
    } else if (finalPadScore < 0.3) {
      eventType = 'spoof';
    }

    const newEvent = {
      id: `evt-${crypto.randomBytes(4).toString('hex')}`,
      timestamp: new Date().toISOString(),
      type: eventType,
      cardId: card ? card.id : cardId,
      holder: card ? card.holder : 'Terminal User',
      details: details || (isSuccess
        ? `Authentication granted via terminal. Liveness Score: ${Math.round(finalPadScore * 100)}%`
        : `Authentication failed via terminal (Liveness Score: ${Math.round(finalPadScore * 100)}%)`),
      rawMetrics: rawMetrics || { padConfidence: finalPadScore, livenessScore: finalPadScore },
      receipt: receipt || { action: isSuccess ? 'AUTHENTICATE_SUCCESS' : 'AUTHENTICATE_FAIL' },
      minutiaeMapPoints: minutiaeMapPoints || [],
      padScore: finalPadScore,
    };

    await db.addAuditLog(newEvent);

    // Broadcast live APDU telemetry event
    broadcastApdu({
      command: `00 20 00 00 (VERIFY_AUTHENTICATION_EVENT)`,
      response: isSuccess ? '90 00 (SW_SUCCESS)' : '6A 88 (SW_VERIFICATION_FAILED)',
      durationMs: Math.floor(30 + Math.random() * 25),
      terminalId: req.body.terminalId || 'TERM-ESP32-01',
    });

    return res.status(200).json({
      status: 'success',
      eventId: newEvent.id,
      message: 'Authentication event logged successfully to database.',
      event: newEvent,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @route   POST /api/public/terminal/apdu-log
 * @desc    Batched APDU traces for the live stream
 * @access  Public (Signed with HMAC)
 */
router.post('/apdu-log', (req, res) => {
  const { terminalId, cardId, commandApdu, responseApdu, command, response, status, durationMs } = req.body;

  const cmd = commandApdu || command;
  const resp = responseApdu || response;

  if (!cmd || !resp) {
    return res.status(400).json({
      status: 'error',
      message: 'commandApdu/command and responseApdu/response are required.',
    });
  }

  const broadcastedPayload = broadcastApdu({
    terminalId: terminalId || 'TERM-ESP32-01',
    cardId: cardId || 'CARD-01',
    command: cmd,
    response: resp,
    durationMs: durationMs || 25,
    status: status || (resp.includes('90 00') || resp === '90 00' ? 'success' : 'error'),
  });

  return res.status(200).json({
    status: 'success',
    streamed: true,
    apdu: broadcastedPayload,
  });
});

/**
 * @route   POST /api/public/terminal/access-log
 * @route   POST /public/terminal/access-log
 * @desc    Records hardware terminal access log payload to audit log database
 * @access  Public (Signed with HMAC)
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
        const { cards = [] } = await db.getCards({ pageSize: 1000 });
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

    // Determine smart event type based on reason & success
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
      const { events: recentLogs = [] } = await db.getAuditLogs({ limit: 10 });
      const nowMs = Date.now();
      targetEvent = recentLogs.find((l) => {
        if (!l.timestamp) return false;
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

    // Create fresh log if no matching verify event was found
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
