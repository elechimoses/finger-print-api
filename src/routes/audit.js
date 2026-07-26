import { Router } from 'express';
import { db } from '../store/mockDb.js';

const router = Router();

/**
 * @route   GET /api/v1/audit
 * @desc    listAuditEvents: Retrieve filtered list of audit events
 * @access  Private (session required)
 */
router.get('/', async (req, res, next) => {
  const { limit = 20, cursor, from, to, type, cardId } = req.query;

  try {
    const limitNum = parseInt(limit, 10);
    const parsedCursor = cursor ? parseInt(cursor, 10) : 0;
    const startIndex = !isNaN(parsedCursor) ? parsedCursor : 0;

    const { events, total } = await db.getAuditLogs({
      from,
      to,
      type,
      cardId,
      limit: limitNum,
      cursor: startIndex
    });

    const nextCursor = startIndex + limitNum < total ? startIndex + limitNum : null;

    return res.status(200).json({
      status: 'success',
      total,
      events,
      nextCursor
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @route   GET /api/v1/audit/export
 * @desc    exportAudit: Export audit logs as CSV or JSON file attachment
 * @access  Private (session required)
 */
router.get('/export', async (req, res, next) => {
  const { format = 'json', from, to, type, cardId } = req.query;
  
  try {
    // Retrieve up to 100,000 logs for export
    const { events: filtered } = await db.getAuditLogs({
      from,
      to,
      type,
      cardId,
      limit: 100000
    });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    if (format.toLowerCase() === 'csv') {
      // Generate CSV format
      const csvHeaders = ['id', 'timestamp', 'type', 'cardId', 'holder', 'details', 'padScore'];
      const csvRows = [csvHeaders.join(',')];

      for (const log of filtered) {
        const escapedHolder = `"${(log.holder || '').replace(/"/g, '""')}"`;
        const escapedDetails = `"${(log.details || '').replace(/"/g, '""')}"`;
        
        csvRows.push([
          log.id,
          log.timestamp,
          log.type,
          log.cardId || '',
          escapedHolder,
          escapedDetails,
          log.padScore !== undefined ? log.padScore : ''
        ].join(','));
      }

      const csvContent = csvRows.join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="audit-export-${timestamp}.csv"`);
      return res.status(200).send(csvContent);
    } else {
      // Default to JSON format
      const jsonContent = JSON.stringify(filtered, null, 2);

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="audit-export-${timestamp}.json"`);
      return res.status(200).send(jsonContent);
    }
  } catch (err) {
    next(err);
  }
});

/**
 * @route   GET /api/v1/audit/:eventId
 * @desc    getAuditEvent: Retrieve full payload for a single event
 * @access  Private (session required)
 */
router.get('/:eventId', async (req, res, next) => {
  const { eventId } = req.params;

  try {
    const event = await db.getAuditLogById(eventId);

    if (!event) {
      return res.status(404).json({
        status: 'error',
        message: 'Audit event not found.'
      });
    }

    return res.status(200).json({
      status: 'success',
      event
    });
  } catch (err) {
    next(err);
  }
});

export default router;
