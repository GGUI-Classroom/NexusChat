const crypto = require('crypto');
const { pool } = require('../models/db');
const { requestDeviceId, socketDeviceId } = require('./ip');

const SESSION_SECURITY_VERSION = 5;
const DEVICE_TOKEN_BYTES = 32;
const CSRF_TOKEN_BYTES = 32;

function csvSet(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
  );
}

const CORE_ADMIN_IDS = csvSet(process.env.CORE_ADMIN_IDS || process.env.ADMIN_USER_IDS || '');
const NON_REMOVABLE_ADMIN_IDS = csvSet(process.env.NON_REMOVABLE_ADMIN_IDS || process.env.CORE_ADMIN_IDS || process.env.ADMIN_USER_IDS || '');

if ((process.env.NODE_ENV === 'production' || process.env.RENDER) && CORE_ADMIN_IDS.size === 0) {
  throw new Error('CORE_ADMIN_IDS must be configured in production. Do not hardcode admin IDs in source.');
}

function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function makeDeviceToken() {
  return crypto.randomBytes(DEVICE_TOKEN_BYTES).toString('base64url');
}

function deviceTokenHash(rawToken) {
  return hashSecret(rawToken);
}

function ensureCsrfToken(req) {
  if (!req.session) return '';
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(CSRF_TOKEN_BYTES).toString('base64url');
  }
  return req.session.csrfToken;
}

function rotateCsrfToken(req) {
  if (!req.session) return '';
  req.session.csrfToken = crypto.randomBytes(CSRF_TOKEN_BYTES).toString('base64url');
  return req.session.csrfToken;
}

function csrfTokenFromRequest(req) {
  return String(req.get?.('x-csrf-token') || req.headers?.['x-csrf-token'] || '');
}

function requireCsrfToken(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path === '/auth/csrf') return next();
  const expected = String(req.session?.csrfToken || '');
  const actual = csrfTokenFromRequest(req);
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  if (!expected || actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    return res.status(403).json({
      error: 'Security token expired. Refreshing Nexus and retrying...',
      code: 'CSRF_TOKEN_INVALID'
    });
  }
  next();
}

async function createDeviceSession(req, userId) {
  const deviceId = requestDeviceId(req);
  if (!deviceId) return null;
  const rawToken = makeDeviceToken();
  const now = Math.floor(Date.now() / 1000);
  const id = crypto.randomUUID ? crypto.randomUUID() : require('uuid').v4();
  await pool.query(
    `INSERT INTO user_device_sessions
      (id, user_id, device_id, token_hash, session_id, user_agent, ip_address, created_at, last_seen_at, revoked_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,NULL)`,
    [
      id,
      userId,
      deviceId,
      deviceTokenHash(rawToken),
      req.sessionID || null,
      String(req.get?.('user-agent') || '').slice(0, 500) || null,
      req.ip || null,
      now
    ]
  );
  return { id, deviceId, token: rawToken, tokenHash: deviceTokenHash(rawToken) };
}

async function bindDeviceSessionToRequest(req, userId) {
  const session = await createDeviceSession(req, userId);
  if (!session || !req.session) return null;
  req.session.deviceSessionId = session.id;
  req.session.deviceId = session.deviceId;
  req.session.deviceTokenHash = session.tokenHash;
  return session;
}

async function revokeCurrentDeviceSession(req) {
  if (!req.session?.deviceSessionId) return;
  await pool.query(
    `UPDATE user_device_sessions
     SET revoked_at=EXTRACT(EPOCH FROM NOW())::BIGINT
     WHERE id=$1 AND revoked_at IS NULL`,
    [req.session.deviceSessionId]
  );
}

async function revokeDeviceSessionsForUser(userId) {
  await pool.query(
    `UPDATE user_device_sessions
     SET revoked_at=EXTRACT(EPOCH FROM NOW())::BIGINT
     WHERE user_id=$1 AND revoked_at IS NULL`,
    [userId]
  );
}

async function revokeDeviceSessionsForDevice(deviceId) {
  if (!deviceId) return;
  await pool.query(
    `UPDATE user_device_sessions
     SET revoked_at=EXTRACT(EPOCH FROM NOW())::BIGINT
     WHERE device_id=$1 AND revoked_at IS NULL`,
    [deviceId]
  );
}

function requestDeviceToken(req) {
  return String(req.get?.('x-nexus-device-token') || req.headers?.['x-nexus-device-token'] || '');
}

function socketDeviceToken(socket) {
  return String(socket?.handshake?.auth?.deviceToken || socket?.handshake?.headers?.['x-nexus-device-token'] || '');
}

async function validateDeviceSession({ userId, deviceId, rawToken, session }) {
  if (!userId || !deviceId || !rawToken || !session?.deviceSessionId || !session?.deviceTokenHash) return false;
  const tokenHash = deviceTokenHash(rawToken);
  if (tokenHash !== session.deviceTokenHash || deviceId !== session.deviceId) return false;
  const result = await pool.query(
    `UPDATE user_device_sessions
     SET last_seen_at=EXTRACT(EPOCH FROM NOW())::BIGINT
     WHERE id=$1 AND user_id=$2 AND device_id=$3 AND token_hash=$4 AND revoked_at IS NULL
     RETURNING id`,
    [session.deviceSessionId, userId, deviceId, tokenHash]
  );
  return result.rows.length > 0;
}

async function validateHttpDeviceSession(req) {
  return validateDeviceSession({
    userId: req.session?.userId,
    deviceId: requestDeviceId(req),
    rawToken: requestDeviceToken(req),
    session: req.session
  });
}

async function validateSocketDeviceSession(socket) {
  return validateDeviceSession({
    userId: socket.request?.session?.userId,
    deviceId: socketDeviceId(socket),
    rawToken: socketDeviceToken(socket),
    session: socket.request?.session
  });
}

async function getUserSessionVersion(userId) {
  const result = await pool.query('SELECT session_version FROM users WHERE id=$1', [userId]);
  return Number(result.rows[0]?.session_version) || 0;
}

async function bumpUserSessionVersion(userId) {
  await revokeDeviceSessionsForUser(userId);
  await pool.query('UPDATE users SET session_version=COALESCE(session_version,0)+1 WHERE id=$1', [userId]);
}

async function isGlobalAdmin(userId) {
  if (!userId) return false;
  if (CORE_ADMIN_IDS.has(userId)) return true;
  const result = await pool.query('SELECT id FROM admin_users WHERE user_id=$1', [userId]);
  return result.rows.length > 0;
}

function isCoreAdmin(userId) {
  return CORE_ADMIN_IDS.has(userId);
}

function isNonRemovableAdmin(userId) {
  return NON_REMOVABLE_ADMIN_IDS.has(userId) || CORE_ADMIN_IDS.has(userId);
}

module.exports = {
  SESSION_SECURITY_VERSION,
  CORE_ADMIN_IDS,
  ensureCsrfToken,
  rotateCsrfToken,
  requireCsrfToken,
  bindDeviceSessionToRequest,
  revokeCurrentDeviceSession,
  revokeDeviceSessionsForDevice,
  revokeDeviceSessionsForUser,
  validateHttpDeviceSession,
  validateSocketDeviceSession,
  getUserSessionVersion,
  bumpUserSessionVersion,
  isGlobalAdmin,
  isCoreAdmin,
  isNonRemovableAdmin,
  socketDeviceToken
};
