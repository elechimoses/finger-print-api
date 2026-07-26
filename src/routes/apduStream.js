import { Router } from 'express';
import { apduEventEmitter } from '../store/mockDb.js';

const router = Router();

/**
 * Helper to broadcast live APDU packets to all connected SSE browser clients
 */
export function broadcastApdu(apduData) {
  const responseStr = apduData.response || apduData.responseApdu || '90 00 (Success)';
  const isSuccess = responseStr.includes('90 00') || responseStr === '90 00';

  const payload = {
    id: `apdu-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    timestamp: apduData.timestamp || new Date().toISOString(),
    command: apduData.command || apduData.commandApdu || '00 20 00 00 (VERIFY FINGERPRINT/RFID)',
    response: responseStr,
    durationMs: apduData.durationMs || Math.floor(25 + Math.random() * 30),
    terminalId: apduData.terminalId || 'TERM-ESP32-01',
    status: isSuccess ? 'success' : 'error',
  };

  apduEventEmitter.emit('apdu-log', payload);
  return payload;
}

/**
 * GET /api/apdu/stream
 * Live APDU command stream (Server-Sent Events)
 */
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write(`event: connected\ndata: ${JSON.stringify({ message: 'APDU stream connected successfully' })}\n\n`);

  const handleApduLog = (apduLog) => {
    res.write(`event: apdu\ndata: ${JSON.stringify(apduLog)}\n\n`);
  };

  apduEventEmitter.on('apdu-log', handleApduLog);

  const keepAlive = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(keepAlive);
    apduEventEmitter.off('apdu-log', handleApduLog);
  });
});

export default router;
export { router as apduStreamRouter };
