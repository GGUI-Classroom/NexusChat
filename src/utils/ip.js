function normalizeIp(ip) {
  return String(ip || '')
    .trim()
    .replace(/^::ffff:/, '')
    .replace(/^::1$/, '127.0.0.1');
}

function requestIp(req) {
  return normalizeIp(req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || '');
}

module.exports = { normalizeIp, requestIp };
