/**
 * Middleware to require a valid API key in the X-API-KEY request header.
 */
export const requireApiKey = (req, res, next) => {
  const apiKey = req.header('X-API-KEY');
  const configuredApiKey = process.env.API_KEY;

  // Fail-secure: If API key is not configured, or left as default in production, block access.
  if (!configuredApiKey) {
    console.error('[Security Error] API_KEY environment variable is not configured.');
    return res.status(500).json({
      status: 'error',
      message: 'Internal server configuration error.'
    });
  }

  if (process.env.NODE_ENV === 'production' && configuredApiKey === 'dev_secret_api_key_change_me_in_production') {
    console.error('[Security Warning] API key must be changed from the default value in production.');
    return res.status(500).json({
      status: 'error',
      message: 'Internal server configuration error.'
    });
  }

  if (!apiKey || apiKey !== configuredApiKey) {
    return res.status(401).json({
      status: 'error',
      message: 'Unauthorized: Invalid or missing API Key.'
    });
  }

  next();
};
