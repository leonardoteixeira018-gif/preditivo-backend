const logger = require('../lib/logger');
const { v4: uuidv4 } = require('uuid');

// Campos sensíveis para mascarar em logs
const SENSITIVE_FIELDS = [
  'password', 'token', 'secret', 'authorization',
  'x-admin-secret', 'x-api-key', 'credit_card',
  'cvv', 'ssn', 'pix_key', 'api_key', 'pin',
  'x-infinitepay-signature', 'x-signature', 'signature'
];

/**
 * Mascarar dados sensíveis em objetos
 */
function maskSensitiveData(obj) {
  if (!obj || typeof obj !== 'object') return obj;

  const masked = Array.isArray(obj) ? [...obj] : { ...obj };

  for (const field of SENSITIVE_FIELDS) {
    for (const [key, value] of Object.entries(masked)) {
      if (key.toLowerCase().includes(field.toLowerCase()) && value) {
        masked[key] = '***MASKED***';
      }
    }
  }

  return masked;
}

module.exports = (req, res, next) => {
  // Gerar correlation ID único para esta requisição
  req.id = uuidv4();

  const start = Date.now();
  let responseBody = '';

  // Interceptar response para capturar body
  const originalSend = res.send;
  res.send = function(data) {
    if (data) {
      responseBody = typeof data === 'string' ? data : JSON.stringify(data);
    }
    return originalSend.call(this, data);
  };

  res.on('finish', () => {
    const duration = Date.now() - start;

    const logData = {
      correlationId: req.id,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: duration,
      ip: req.ip,
      user_id: req.user?.id || null,
      query: maskSensitiveData(req.query),
      headers: maskSensitiveData({
        'content-type': req.headers['content-type'],
        'user-agent': req.headers['user-agent'],
        'authorization': req.headers['authorization']
      })
    };

    // Determinar nível de log baseado em status e duration
    if (res.statusCode >= 500) {
      logger.error('Request failed', {
        ...logData,
        responseBody: responseBody.substring(0, 500)
      });
    } else if (res.statusCode >= 400) {
      logger.warn('Request client error', logData);
    } else if (duration > 1000) {
      logger.warn('Slow request', {
        ...logData,
        reason: `duration_${duration}ms_exceeded_1s`
      });
    } else {
      logger.info('Request', logData);
    }
  });

  next();
};
