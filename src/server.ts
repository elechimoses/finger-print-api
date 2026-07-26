import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Security & CORS Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
    credentials: true,
  })
);

// Cookie Parser Middleware
app.use(cookieParser());

// Dual Payload Limiters & Body Parsers: Handles form-urlencoded & JSON safely
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// Health Check
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Centralized Error Handler Middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('[Unhandled Error]:', err);
  res.status(500).json({
    status: 'error',
    message: err.message || 'Internal Server Error',
  });
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

export default app;
