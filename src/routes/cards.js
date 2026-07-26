import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../store/mockDb.js';

const router = Router();

/**
 * @route   GET /api/v1/cards
 * @desc    listEnrolledCards: Paginated list with searching and filtering
 * @access  Private (session required)
 */
router.get('/', async (req, res, next) => {
  const { q, syncStatus, page = 1, pageSize = 10 } = req.query;

  try {
    const { cards, total } = await db.getCards({
      q,
      syncStatus,
      page,
      pageSize
    });

    return res.status(200).json({
      status: 'success',
      total,
      page: parseInt(page, 10),
      pageSize: parseInt(pageSize, 10),
      cards
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @route   GET /api/v1/cards/:cardId
 * @desc    getCard: Get detailed card record
 * @access  Private (session required)
 */
router.get('/:cardId', async (req, res, next) => {
  const { cardId } = req.params;
  
  try {
    const card = await db.getCardById(cardId);

    if (!card) {
      return res.status(404).json({
        status: 'error',
        message: 'Card not found.'
      });
    }

    return res.status(200).json({
      status: 'success',
      card
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @route   POST /api/v1/cards/revoke
 * @desc    revokeCard: Revoke card and log audit entry
 * @access  Private (session required)
 */
router.post('/revoke', async (req, res, next) => {
  const { cardId, reason } = req.body;

  if (!cardId || !reason) {
    return res.status(400).json({
      status: 'error',
      message: 'cardId and reason are required.'
    });
  }

  try {
    const card = await db.getCardById(cardId);

    if (!card) {
      return res.status(404).json({
        status: 'error',
        message: 'Card not found.'
      });
    }

    if (card.status === 'revoked') {
      return res.status(400).json({
        status: 'error',
        message: 'Card is already revoked.'
      });
    }

    // Update status in db
    await db.updateCard(cardId, {
      status: 'revoked',
      revocationReason: reason
    });

    // Fetch the updated card to return it
    const updatedCard = await db.getCardById(cardId);

    // Log revocation in audit list
    await db.addAuditLog({
      id: `evt-${crypto.randomBytes(4).toString('hex')}`,
      timestamp: new Date().toISOString(),
      type: 'revocation',
      cardId: card.id,
      holder: card.holder,
      details: `Card credentials revoked: ${reason}`,
      rawMetrics: {},
      receipt: { action: 'REVOKE_CARD', operator: 'admin' },
      minutiaeMapPoints: [],
      padScore: 0
    });

    return res.status(200).json({
      status: 'success',
      message: `Card of ${card.holder} was revoked successfully.`,
      card: updatedCard
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @route   POST /api/v1/cards/resync
 * @desc    resyncCard: Trigger terminal re-sync
 * @access  Private (session required)
 */
router.post('/resync', async (req, res, next) => {
  const { cardId } = req.body;

  if (!cardId) {
    return res.status(400).json({
      status: 'error',
      message: 'cardId is required.'
    });
  }

  try {
    const card = await db.getCardById(cardId);

    if (!card) {
      return res.status(404).json({
        status: 'error',
        message: 'Card not found.'
      });
    }

    // Trigger re-sync simulation in DB
    await db.updateCard(cardId, { syncStatus: 'pending' });
    const pendingCard = await db.getCardById(cardId);

    // Log sync trigger
    await db.addAuditLog({
      id: `evt-${crypto.randomBytes(4).toString('hex')}`,
      timestamp: new Date().toISOString(),
      type: 'admin',
      cardId: card.id,
      holder: card.holder,
      details: `Card re-sync triggered for ${card.holder}.`,
      rawMetrics: {},
      receipt: { action: 'TRIGGER_RESYNC' },
      minutiaeMapPoints: [],
      padScore: 1.0
    });

    // Simulate completion after 5 seconds
    setTimeout(async () => {
      try {
        const updatedCard = await db.getCardById(cardId);
        if (updatedCard && updatedCard.syncStatus === 'pending') {
          await db.updateCard(cardId, { syncStatus: 'synced' });
          console.log(`[Sync Simulation] Card ${cardId} re-sync completed successfully.`);
        }
      } catch (err) {
        console.error('[Sync Simulation Error]', err);
      }
    }, 5000);

    return res.status(200).json({
      status: 'success',
      message: `Re-sync command triggered successfully for card ${cardId}. Status is now pending.`,
      card: pendingCard
    });
  } catch (err) {
    next(err);
  }
});

export default router;
