/**
 * Centralized error handler middleware.
 * Ensures the client gets a JSON error response and does not leak stack traces in production.
 */
export const errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || err.status || 500;
  const isProduction = process.env.NODE_ENV === 'production';

  // Log the error internally (use a proper logging library like Winston or Pino in larger apps)
  console.error(`[Error] ${req.method} ${req.url} - Status ${statusCode}: ${err.message}`);
  if (!isProduction) {
    console.error(err.stack);
  }

  res.status(statusCode).json({
    status: 'error',
    statusCode,
    message: statusCode === 500 && isProduction
      ? 'An unexpected error occurred on the server.'
      : err.message || 'Internal Server Error',
    ...(isProduction ? {} : { stack: err.stack })
  });
};
