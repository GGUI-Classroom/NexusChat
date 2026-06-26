function normalizeIp(ip) {
  return String(ip || '')
    .trim()
    .replace(/^::ffff:/, '')
    .replace(/^::1$/, '127.0.0.1');
}

function requestIp(req) {
  return normalizeIp(req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || '');
}

function normalizeDeviceId(deviceId) {
  const value = String(deviceId || '').trim();
  return /^[a-f0-9-]{20,80}$/i.test(value) ? value.slice(0, 80) : '';
}

function requestDeviceId(req) {
  return normalizeDeviceId(req.get?.('x-nexus-device-id') || req.headers?.['x-nexus-device-id']);
}

function socketDeviceId(socket) {
  return normalizeDeviceId(socket?.handshake?.auth?.deviceId || socket?.handshake?.headers?.['x-nexus-device-id']);
}

module.exports = { normalizeIp, requestIp, normalizeDeviceId, requestDeviceId, socketDeviceId };
