import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';

import { requireSession } from './middleware/sessionAuth.js';
import { errorHandler } from './middleware/errorHandler.js';

// Import Route Routers
import authRouter from './routes/auth.js';
import adminRouter from './routes/admin.js';
import dashboardRouter from './routes/dashboard.js';
import apduStreamRouter from './routes/apduStream.js';
import cardsRouter from './routes/cards.js';
import enrollRouter from './routes/enroll.js';
import auditRouter from './routes/audit.js';
import publicTerminalRouter from './routes/publicTerminal.js';
import firmwareRouter from './routes/firmware.js';
import adminFirmwareRouter from './routes/adminFirmware.js';

const app = express();

// 1. HTTP Security Headers
app.use(helmet({ contentSecurityPolicy: false }));

// 2. CORS Configuration
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:3000,http://localhost:5173,http://localhost:3001,http://127.0.0.1:3000,http://127.0.0.1:5173')
  .split(',')
  .map(origin => origin.trim());

const corsOptions = {
  origin: (origin, callback) => {
    // Allow non-browser requests (mobile apps, postman, curl, ESP32)
    if (!origin) return callback(null, true);

    // Allow wildcard '*', explicit CORS_ORIGIN list, or any localhost/127.0.0.1 origin in dev
    const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
    if (allowedOrigins.includes('*') || allowedOrigins.includes(origin) || isLocalhost) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

// 3. Cookie Parser (required for session cookies)
app.use(cookieParser());

// 4. Payload Limiters & Body Parsers: Handles form-urlencoded & JSON safely with rawBody capture
app.use(express.json({
  limit: '10kb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({
  extended: true,
  limit: '10kb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// 5. Rate Limiter to prevent DDoS / Brute Force
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 900000,
  max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 5000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    if (process.env.NODE_ENV === 'development') return true;
    const ip = req.ip || req.socket?.remoteAddress;
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  },
  message: {
    status: 'error',
    statusCode: 429,
    message: 'Too many requests from this IP, please try again later.'
  }
});
app.use(limiter);

// 6. ESP32 Firmware Endpoints (/verify, /add-card, /save-card)
app.use('/', firmwareRouter);

// 7. Admin Firmware REST API (/api/admin/enroll, /admin/start-enrollment, /api/admin/users, /api/admin/users/:id)
app.use('/api/admin', adminFirmwareRouter);
app.use('/admin', adminFirmwareRouter);

// 8. Public Signed Callbacks (Uses HMAC Signature Auth inside router)
app.use('/api/public/terminal', publicTerminalRouter);
app.use('/public/terminal', publicTerminalRouter);

// 9. Live SSE APDU stream (Public dashboard telemetry)
app.use('/api/apdu', apduStreamRouter);

// 10. Auth gate endpoints (Publicly accessible session management)
app.use('/api/v1/auth', authRouter);

// 11. Private Endpoints (Gated by Session Cookie authentication)
app.use('/api/v1/dashboard', requireSession, dashboardRouter);
app.use('/api/v1/cards', requireSession, cardsRouter);
app.use('/api/v1/enroll', requireSession, enrollRouter);
app.use('/api/v1/audit', requireSession, auditRouter);
app.use('/api/v1/admin', requireSession, adminRouter);

// 12. 404 Handler for undefined routes
app.use((req, res, next) => {
  res.status(404).json({
    status: 'error',
    statusCode: 404,
    message: `Cannot ${req.method} ${req.originalUrl}. Route not found.`
  });
});

// 13. Centralized Error Handler (must be last middleware)
app.use(errorHandler);

export default app;
