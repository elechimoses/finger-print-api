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
    }

    const terminalId = body.terminalId || body.terminal_id || req.query?.terminalId || 'TERM-ESP32-01';
    const cardUid = body.cardUid || body.card_uid || body.cardId || body.uid || req.query?.cardUid || req.query?.uid || '';
    const rawSuccess = body.success !== undefined ? body.success : req.query?.success;
    const isSuccess = typeof rawSuccess === 'boolean'
      ? rawSuccess
      : (typeof rawSuccess === 'string' ? rawSuccess.toLowerCase() === 'true' : Boolean(rawSuccess));

    const reason = body.reason || req.query?.reason || (isSuccess ? 'Access Granted' : 'Access Denied');
    const fingerId = body.fingerId !== undefined ? body.fingerId : (body.finger_id !== undefined ? body.finger_id : req.query?.fingerId);
    const timestamp = body.timestamp || req.query?.timestamp || new Date().toISOString();

    let card = null;
    if (cardUid) {
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

    const eventType = isSuccess ? 'auth_success' : 'auth_fail';
    const finalFingerId = fingerId !== undefined && fingerId !== null ? Number(fingerId) : null;

    const newEvent = {
      id: `evt-${crypto.randomBytes(4).toString('hex')}`,
      timestamp,
      type: eventType,
      cardId: card ? card.id : null,
      holder: card ? card.holder : (cardUid ? `Terminal User (${cardUid})` : 'Terminal User'),
      details: `[${terminalId}] ${reason}${finalFingerId !== null ? ` (Finger ID: ${finalFingerId})` : ''}${cardUid ? ` [Match On Card: ${cardUid}]` : ''}`,
      rawMetrics: {
        terminalId,
        cardUid: cardUid || null,
        fingerId: finalFingerId,
        reason,
        success: isSuccess,
      },
      receipt: {
        action: isSuccess ? 'AUTHENTICATE_SUCCESS' : 'AUTHENTICATE_FAIL',
        terminalId,
        reason,
      },
      minutiaeMapPoints: [],
      padScore: isSuccess ? 0.98 : 0.15,
    };

    await db.addAuditLog(newEvent);

    // Broadcast live APDU telemetry event
    broadcastApdu({
      command: `00 20 00 00 (TERMINAL_ACCESS_LOG fingerId: ${finalFingerId ?? 'N/A'})`,
      response: isSuccess ? '90 00 (SW_SUCCESS)' : '6A 88 (SW_VERIFICATION_FAILED)',
      durationMs: Math.floor(25 + Math.random() * 20),
      terminalId,
    });

    return res.status(200).json({
      status: 'success',
      success: true,
      eventId: newEvent.id,
      message: 'Access log recorded successfully to database.',
      event: newEvent,
    });
  } catch (err) {
    next(err);
  }
});

export default router;


