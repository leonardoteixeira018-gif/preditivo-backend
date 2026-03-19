const crypto = require('crypto');
const jwt = require('jsonwebtoken');

module.exports = (req, res, next) => {
  // Opção 1: Header x-admin-secret (legado)
  const secretHeader = req.headers['x-admin-secret'];

  // Opção 2: JWT Bearer token (novo - recomendado)
  const authHeader = req.headers['authorization'];

  // Tentar validar JWT primeiro (novo sistema)
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.replace('Bearer ', '');
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      if (decoded.type !== 'admin') {
        console.warn(`[SECURITY] Non-admin token used for admin access from ${req.ip}`);
        return res.status(403).json({ error: 'Token não é admin' });
      }

      console.log(`[AUDIT] Admin action from ${req.ip} - ${req.method} ${req.path}`);
      next();
      return;
    } catch (err) {
      console.warn(`[SECURITY] Invalid admin token from ${req.ip}: ${err.message}`);
      return res.status(403).json({ error: 'Token inválido ou expirado' });
    }
  }

  // Fallback: validar secret direto (compatibilidade com frontend antigo)
  if (secretHeader) {
    const expectedSecret = process.env.ADMIN_SECRET;

    if (!expectedSecret) {
      console.error('[SECURITY] ADMIN_SECRET não configurado no .env');
      return res.status(500).json({ error: 'Erro de configuração do servidor' });
    }

    try {
      // Comparação segura contra timing attacks
      const valid = crypto.timingSafeEqual(
        Buffer.from(secretHeader),
        Buffer.from(expectedSecret)
      );

      if (!valid) {
        console.warn(`[SECURITY] Invalid admin secret attempt from ${req.ip}`);
        return res.status(403).json({ error: 'Admin secret inválida' });
      }
    } catch (err) {
      // Tamanhos diferentes
      console.warn(`[SECURITY] Admin secret length mismatch from ${req.ip}`);
      return res.status(403).json({ error: 'Admin secret inválida' });
    }

    console.log(`[AUDIT] Admin action (legacy) from ${req.ip} - ${req.method} ${req.path}`);
    next();
    return;
  }

  // Nenhuma credencial válida
  console.warn(`[SECURITY] Admin access attempt without credentials from ${req.ip}`);
  return res.status(401).json({ error: 'Credenciais de admin obrigatórias' });
};
