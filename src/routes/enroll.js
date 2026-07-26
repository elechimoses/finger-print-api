import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../store/mockDb.js';

const router = Router();

/**
 * @route   POST /api/v1/enroll/start
 * @desc    startEnrollment: Initialize enrollment pipeline
 * @access  Private (session required)
 */
router.post('/start', async (req, res, next) => {
  const { holder, cardSerial } = req.body;

  if (!holder || !cardSerial) {
    return res.status(400).json({
      status: 'error',
      message: 'holder name and cardSerial are required.'
    });
  }

  // Generate unique enrollment ID
  const enrollmentId = `enroll-${crypto.randomBytes(4).toString('hex')}`;

  const session = {
    id: enrollmentId,
    holder,
    cardSerial,
    step: 1, // Step 1: Initialized / Awaiting Captures
    captures: [],
    minutiaeCount: null,
    templateHash: null,
    status: 'started',
    createdAt: new Date().toISOString()
  };

  try {
    await db.setEnrollmentSession(enrollmentId, session);

    return res.status(201).json({
      status: 'success',
      enrollmentId,
      message: 'Enrollment session started. Step 1: SE INIT + key derivation completed.'
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @route   POST /api/v1/enroll/capture
 * @desc    submitCapture: Submit fingerprint capture sample (one per scan, e.g. 3 scans needed)
 * @access  Private (session required)
 */
router.post('/capture', async (req, res, next) => {
  const { enrollmentId, sampleBlob, quality } = req.body;

  if (!enrollmentId || !quality) {
    return res.status(400).json({
      status: 'error',
      message: 'enrollmentId and quality score are required.'
    });
  }

  try {
    const session = await db.getEnrollmentSession(enrollmentId);

    if (!session) {
      return res.status(404).json({
        status: 'error',
        message: 'Enrollment session not found or expired.'
      });
    }

    if (session.step > 2) {
      return res.status(400).json({
        status: 'error',
        message: 'Cannot capture fingerprints. Pipeline has already progressed past capture phase.'
      });
    }

    // Quality check (standard threshold for minutiae extraction is >= 60)
    const qualityScore = parseInt(quality, 10);
    if (qualityScore < 60) {
      return res.status(400).json({
        status: 'error',
        message: `Quality score too low (${qualityScore}/100). Capture rejected. Minimum threshold is 60.`
      });
    }

    session.captures.push({
      index: session.captures.length + 1,
      sampleBlob: sampleBlob || `RAW_CAPTURE_DATA_${crypto.randomBytes(8).toString('hex')}`,
      quality: qualityScore,
      timestamp: new Date().toISOString()
    });

    session.step = 2; // Step 2: Fingerprint captures in progress

    await db.setEnrollmentSession(enrollmentId, session);

    return res.status(200).json({
      status: 'success',
      enrollmentId,
      capturesCount: session.captures.length,
      message: `Capture #${session.captures.length} recorded. Total captures: ${session.captures.length}.`
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @route   POST /api/v1/enroll/extract
 * @desc    extractTemplate: Run minutiae extraction on captured scans
 * @access  Private (session required)
 */
router.post('/extract', async (req, res, next) => {
  const { enrollmentId } = req.body;

  if (!enrollmentId) {
    return res.status(400).json({
      status: 'error',
      message: 'enrollmentId is required.'
    });
  }

  try {
    const session = await db.getEnrollmentSession(enrollmentId);

    if (!session) {
      return res.status(404).json({
        status: 'error',
        message: 'Enrollment session not found.'
      });
    }

    if (session.captures.length === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'Cannot extract template. No fingerprint captures have been submitted.'
      });
    }

    // Simulate minutiae extraction
    const minutiaeCount = Math.floor(Math.random() * 15) + 30; // Random 30 - 45
    const templateHash = crypto.createHash('sha256').update(session.captures[0].sampleBlob).digest('hex');

    session.minutiaeCount = minutiaeCount;
    session.templateHash = templateHash;
    session.step = 3; // Step 3: Template extracted

    await db.setEnrollmentSession(enrollmentId, session);

    return res.status(200).json({
      status: 'success',
      enrollmentId,
      minutiaeCount,
      templateHash,
      message: 'Minutiae points extracted. ISO 19794-2 template hash generated successfully.'
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @route   POST /api/v1/enroll/commit
 * @desc    commitEnrollment: Write final template to card secure storage and finalize
 * @access  Private (session required)
 */
router.post('/commit', async (req, res, next) => {
  const { enrollmentId } = req.body;

  if (!enrollmentId) {
    return res.status(400).json({
      status: 'error',
      message: 'enrollmentId is required.'
    });
  }

  try {
    const session = await db.getEnrollmentSession(enrollmentId);

    if (!session) {
      return res.status(404).json({
        status: 'error',
        message: 'Enrollment session not found.'
      });
    }

    if (session.step !== 3) {
      return res.status(400).json({
        status: 'error',
        message: 'Enrollment cannot be committed. Template extraction must be run first.'
      });
    }

    // Check if serial is already in use by active card
    const duplicate = await db.getCardBySerial(session.cardSerial);
    if (duplicate && duplicate.status === 'active') {
      return res.status(400).json({
        status: 'error',
        message: `Card serial ${session.cardSerial} is already assigned to active card holder ${duplicate.holder}.`
      });
    }

    // Add card to main card database
    const cardId = `card-${crypto.randomBytes(4).toString('hex')}`;
    const newCard = {
      id: cardId,
      holder: session.holder,
      serial: session.cardSerial,
      templateFormat: 'ISO 19794-2',
      minutiaeCount: session.minutiaeCount,
      syncStatus: 'synced',
      status: 'active',
      lastSeen: new Date().toISOString()
    };

    await db.addCard(newCard);

    // Add audit log event
    await db.addAuditLog({
      id: `evt-${crypto.randomBytes(4).toString('hex')}`,
      timestamp: new Date().toISOString(),
      type: 'enrollment',
      cardId: cardId,
      holder: session.holder,
      details: `New fingerprint credential successfully enrolled for ${session.holder}.`,
      rawMetrics: { minutiaeCount: session.minutiaeCount, scansCount: session.captures.length },
      receipt: { enrollmentId, cardSerial: session.cardSerial },
      minutiaeMapPoints: [],
      padScore: 1.0
    });

    // Remove enrollment session from cache
    await db.deleteEnrollmentSession(enrollmentId);

    return res.status(201).json({
      status: 'success',
      message: 'Card enrollment successfully committed to secure storage.',
      card: newCard
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @route   POST /api/v1/enroll/cancel
 * @desc    cancelEnrollment: Clean up and discard the current session
 * @access  Private (session required)
 */
router.post('/cancel', async (req, res, next) => {
  const { enrollmentId } = req.body;

  if (!enrollmentId) {
    return res.status(400).json({
      status: 'error',
      message: 'enrollmentId is required.'
    });
  }

  try {
    const session = await db.getEnrollmentSession(enrollmentId);

    if (!session) {
      return res.status(404).json({
        status: 'error',
        message: 'Enrollment session not found.'
      });
    }

    await db.deleteEnrollmentSession(enrollmentId);

    return res.status(200).json({
      status: 'success',
      message: 'Enrollment session cancelled and in-flight storage cleaned up.'
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @route   GET /api/v1/enroll/status/:enrollmentId
 * @desc    getEnrollmentStatus: Fetch session progress for polling
 * @access  Private (session required)
 */
router.get('/status/:enrollmentId', async (req, res, next) => {
  const { enrollmentId } = req.params;
  
  try {
    const session = await db.getEnrollmentSession(enrollmentId);

    if (!session) {
      return res.status(404).json({
        status: 'error',
        message: 'Enrollment session not found.'
      });
    }

    return res.status(200).json({
      status: 'success',
      enrollment: {
        id: session.id,
        holder: session.holder,
        cardSerial: session.cardSerial,
        step: session.step,
        capturesCount: session.captures.length,
        status: session.status,
        hasTemplate: !!session.templateHash
      }
    });
  } catch (err) {
    next(err);
  }
});

export default router;
