import dotenv from 'dotenv';
// Load environment variables at the absolute entry point
dotenv.config();

import app from './app.js';

const PORT = process.env.PORT || 5000;
const NODE_ENV = process.env.NODE_ENV || 'development';

const server = app.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(`  Server is running in [${NODE_ENV}] mode`);
  console.log(`  Listening on Port: ${PORT}`);
  console.log(`  Health Check URL: http://localhost:${PORT}/api/v1/health`);
  console.log(`===================================================`);
});

// 1. Uncaught Exception Handler
process.on('uncaughtException', (err) => {
  console.error('FATAL: Uncaught Exception! Shutting down gracefully...');
  console.error(err.stack || err);

  // Gracefully close the HTTP server, then terminate process
  server.close(() => {
    process.exit(1);
  });

  // Force exit after a short timeout if the server close hangs
  setTimeout(() => {
    process.exit(1);
  }, 3000);
});

// 2. Unhandled Promise Rejection Handler
process.on('unhandledRejection', (reason, promise) => {
  console.error('FATAL: Unhandled Promise Rejection! Shutting down gracefully...');
  console.error(reason);

  server.close(() => {
    process.exit(1);
  });

  setTimeout(() => {
    process.exit(1);
  }, 3000);
});

// 3. Graceful Shutdown on termination signals (SIGINT / SIGTERM)
const gracefulShutdown = (signal) => {
  console.log(`Received ${signal}. Starting graceful shutdown...`);
  server.close(() => {
    console.log('HTTP server closed. Exiting process.');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('Forcefully exiting as shutdown timed out.');
    process.exit(0);
  }, 5000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
