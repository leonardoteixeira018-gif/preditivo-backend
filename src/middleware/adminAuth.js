const jwt = require('jsonwebtoken');

module.exports = (req, res, next) => {
  // Apenas JWT Bearer token para acesso admin
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

  // Nenhuma credencial válida
  console.warn(`[SECURITY] Admin access attempt without credentials from ${req.ip}`);
  return res.status(401).json({ error: 'Bearer token de admin obrigatório' });
};
