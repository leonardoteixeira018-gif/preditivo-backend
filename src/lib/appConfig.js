const APP_DOMAIN = process.env.APP_DOMAIN || 'futoro.com.br';
const APP_URL = process.env.APP_URL || `https://${APP_DOMAIN}`;
const APP_BRAND = process.env.APP_BRAND || 'Futoro.';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'suporte@futoro.com.br';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'l245602@dac.unicamp.br';

module.exports = {
  APP_DOMAIN,
  APP_URL,
  APP_BRAND,
  SUPPORT_EMAIL,
  ADMIN_EMAIL
};
