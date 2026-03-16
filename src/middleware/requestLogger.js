module.exports = (req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? 'ERROR' : res.statusCode >= 400 ? 'WARN' : 'INFO';
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: duration,
      ip: req.ip,
      uid: req.user?.id || null
    }));
  });

  next();
};
