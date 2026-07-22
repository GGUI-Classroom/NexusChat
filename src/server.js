const express = require('express');
const http = require('http');
const compression = require('compression');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { createClient } = require('redis');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { BoardBase: ConnectFourBoard, BoardPiece: ConnectFourPiece } = require('@kenrick95/c4');
const { envFlag } = require('./config/env');
const { pool, initDb } = require('./models/db');
const { avatarUrl } = require('./utils/avatar');
const { requestIp, requestDeviceId, socketDeviceId } = require('./utils/ip');
const {
  SESSION_SECURITY_VERSION,
  requireCsrfToken,
  validateHttpDeviceSession,
  validateSocketDeviceSession,
  getUserSessionVersion,
  isGlobalAdmin
} = require('./utils/security');
const { enforceGlobalSafety, findConfiguredViolation } = require('./utils/globalSafety');
const { getCurrentTos, getUserTosState, requireCurrentTos } = require('./utils/tosPolicy');
const { getChannelAccess, canAccessChannel, getChannelAccessibleUserIds } = require('./utils/channelAccess');
const { safeMessageContent } = require('./utils/inputSafety');

const app = express();
const server = http.createServer(app);

const isProd = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER);
const SESSION_SECRET = process.env.SESSION_SECRET || 'nexus-dev-secret-change-in-prod';
const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const COOKIE_SECURE = envFlag('COOKIE_SECURE', isProd);
const REQUIRE_REDIS = envFlag('REQUIRE_REDIS', false);
const TRUST_PROXY = process.env.TRUST_PROXY || (isProd ? '1' : '');
const ALLOW_FILE_CLIENTS = envFlag('ALLOW_FILE_CLIENTS', false);
const ALLOW_CROSS_SITE_IFRAMES = envFlag('ALLOW_CROSS_SITE_IFRAMES', isProd);
const COOKIE_SAME_SITE = (
  ALLOW_CROSS_SITE_IFRAMES ? 'none' : (process.env.COOKIE_SAME_SITE || (ALLOW_FILE_CLIENTS ? 'none' : 'lax'))
).toLowerCase();
const PUBLIC_APP_ORIGINS = new Set(
  [process.env.PUBLIC_APP_ORIGIN, process.env.RENDER_EXTERNAL_URL]
    .filter(Boolean)
    .map(origin => String(origin).trim().replace(/\/$/, ''))
);
const TRUSTED_EXTERNAL_ORIGINS = new Set([
  'https://edu.palypro.com',
  'https://quizizz.com',
  'https://media.quizizz.com'
]);

// <img> requests cannot attach the device-token headers used by fetch/XHR.
// These are still protected by the signed same-origin session and their route
// handlers' requireAuth middleware; only the header-based device check is
// skipped so loading an avatar cannot invalidate the current user session.
function isBrowserMediaRequest(req) {
  if (!['GET', 'HEAD'].includes(req.method)) return false;
  const requestPath = req.path;
  return /^\/users\/(?:avatar|banner)\/[^/]+$/.test(requestPath)
    || /^\/servers\/[^/]+\/icon$/.test(requestPath)
    || /^\/servers\/[^/]+\/emojis\/[^/]+\/image$/.test(requestPath);
}
const STATIC_CLIENT_ORIGINS = new Set(
  (process.env.STATIC_CLIENT_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
);
const NEXUS_LINK_SHARED_SECRET = process.env.NEXUS_LINK_SHARED_SECRET || '';
const ACTIVITY_ONLY_EVENTS = new Set(['call_accept', 'join_call', 'webrtc_offer', 'webrtc_answer', 'webrtc_ice', 'call_end']);
const socketRateBuckets = new Map();
const apiRateBuckets = new Map();

if (!process.env.SESSION_SECRET && !envFlag('ALLOW_INSECURE_DEV_SECRET', false)) {
  throw new Error('SESSION_SECRET must be set. For throwaway local testing only, set ALLOW_INSECURE_DEV_SECRET=true.');
}
if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length < 32) {
  throw new Error('SESSION_SECRET must be at least 32 characters.');
}
if (isProd && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  throw new Error('SESSION_SECRET must be set to a random value of at least 32 characters in production.');
}
if (isProd && ALLOW_FILE_CLIENTS) {
  throw new Error('ALLOW_FILE_CLIENTS must be false in production. Serve the client from an explicit HTTPS origin instead.');
}
if (isProd && !COOKIE_SECURE) {
  throw new Error('COOKIE_SECURE must be true in production.');
}
if (!['lax', 'strict', 'none'].includes(COOKIE_SAME_SITE)) {
  throw new Error('COOKIE_SAME_SITE must be lax, strict, or none.');
}
if (COOKIE_SAME_SITE === 'none' && !COOKIE_SECURE) {
  throw new Error('COOKIE_SECURE must be true when cross-site iframe sessions are enabled.');
}
if (isProd && process.env.NEXUS_LINK_SHARED_SECRET && process.env.NEXUS_LINK_SHARED_SECRET.length < 32) {
  throw new Error('NEXUS_LINK_SHARED_SECRET must be at least 32 characters when configured in production.');
}
if (isProd && process.env.ADMIN_QR_CODE && process.env.ADMIN_QR_CODE.length < 16) {
  throw new Error('ADMIN_QR_CODE must be at least 16 characters when configured in production.');
}
if (isProd && process.env.LIMITED_ADMIN_NFC_CODE && process.env.LIMITED_ADMIN_NFC_CODE.length < 16) {
  throw new Error('LIMITED_ADMIN_NFC_CODE must be at least 16 characters when configured in production.');
}
if (isProd && process.env.LIMITED_ADMIN_ACCESS_CODE && process.env.LIMITED_ADMIN_ACCESS_CODE.length < 16) {
  throw new Error('LIMITED_ADMIN_ACCESS_CODE must be at least 16 characters when configured in production.');
}

function isAllowedClientOrigin(origin, req) {
  if (!origin) return true;
  if (origin === 'null') return ALLOW_FILE_CLIENTS;
  if (STATIC_CLIENT_ORIGINS.has(origin) || PUBLIC_APP_ORIGINS.has(origin) || TRUSTED_EXTERNAL_ORIGINS.has(origin)) return true;
  if (!req) return false;
  const protocol = req.protocol || (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = req.get ? req.get('host') : req.headers.host;
  return Boolean(host && origin === `${protocol}://${host}`);
}

function setSecurityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'self' https://quizizz.com https://media.quizizz.com",
    "form-action 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://quizizz.com https://media.quizizz.com",
    "media-src 'self' data: blob: https://quizizz.com https://media.quizizz.com",
    "connect-src 'self' https://quizizz.com https://media.quizizz.com",
    "frame-src 'self' https://quizizz.com https://media.quizizz.com",
    "worker-src 'self' blob:"
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), payment=(), usb=()');
  next();
}

function takeSocketRateToken(userId, event, limit, windowMs) {
  const now = Date.now();
  const key = `${userId}:${event}`;
  const active = (socketRateBuckets.get(key) || []).filter(time => now - time < windowMs);
  if (active.length >= limit) {
    socketRateBuckets.set(key, active);
    return false;
  }
  active.push(now);
  socketRateBuckets.set(key, active);
  return true;
}

function takeApiRateToken(req, limit, windowMs, scope = 'all') {
  const now = Date.now();
  const clientIp = requestIp(req) || req.ip || 'unknown';
  const normalizedPath = `${req.baseUrl || ''}${req.path || ''}`
    .replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/gi, ':id')
    .replace(/\/[A-Za-z0-9_-]{32,}(?=\/|$)/g, '/:id');
  const key = `${scope}:${clientIp}:${req.method}:${normalizedPath}`;
  if (apiRateBuckets.size > 5000) apiRateBuckets.clear();
  const active = (apiRateBuckets.get(key) || []).filter(time => now - time < windowMs);
  if (active.length >= limit) {
    apiRateBuckets.set(key, active);
    return false;
  }
  active.push(now);
  apiRateBuckets.set(key, active);
  return true;
}

function channelRoomId(serverId, channelId) {
  return `channel:${serverId}:${channelId}`;
}

function emitToChannel(serverId, channelId, event, payload) {
  io.to(channelRoomId(serverId, channelId)).emit(event, payload);
}

function leaveChannelRooms(socket) {
  for (const room of socket.rooms) {
    if (room.startsWith('channel:')) socket.leave(room);
  }
}

function verifyActivityCallToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string' || !NEXUS_LINK_SHARED_SECRET) return null;
  const [payloadPart, signature] = rawToken.split('.');
  if (!payloadPart || !signature) return null;
  const expected = crypto.createHmac('sha256', NEXUS_LINK_SHARED_SECRET).update(payloadPart).digest('base64url');
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    if (!payload?.nexusUserId || !payload?.roomId || !payload?.callerId || !payload?.exp) return null;
    if (Number(payload.exp) < Math.floor(Date.now() / 1000)) return null;
    return {
      nexusUserId: String(payload.nexusUserId),
      roomId: String(payload.roomId),
      callerId: String(payload.callerId),
      callType: payload.callType === 'video' ? 'video' : 'voice',
      exp: Number(payload.exp)
    };
  } catch (_error) {
    return null;
  }
}

async function resolveDirectMentions(content, allowedUserIds) {
  const matches = [...String(content || '').matchAll(/<@user:([a-f0-9-]+)>/g)];
  const allowed = new Set(allowedUserIds.filter(Boolean));
  const ids = [...new Set(matches.map(match => match[1]).filter(id => allowed.has(id)))];
  const mentionData = { users: {}, roles: {} };
  if (!ids.length) return mentionData;
  const result = await pool.query('SELECT id, username, display_name FROM users WHERE id = ANY($1)', [ids]);
  result.rows.forEach(user => {
    mentionData.users[user.id] = { username: user.username, displayName: user.display_name };
  });
  return mentionData;
}

async function resolveChannelMentions(content, serverId) {
  const userMentions = [...String(content || '').matchAll(/<@user:([a-f0-9-]+)>/g)];
  const roleMentions = [...String(content || '').matchAll(/<@role:([a-f0-9-]+)>/g)];
  const mentionData = { users: {}, roles: {} };
  if (userMentions.length) {
    const ids = [...new Set(userMentions.map(match => match[1]))];
    const result = await pool.query(
      `SELECT u.id, u.username, u.display_name
       FROM users u
       JOIN server_members sm ON sm.user_id=u.id AND sm.server_id=$2
       WHERE u.id = ANY($1)`,
      [ids, serverId]
    );
    result.rows.forEach(user => {
      mentionData.users[user.id] = { username: user.username, displayName: user.display_name };
    });
  }
  if (roleMentions.length) {
    const ids = [...new Set(roleMentions.map(match => match[1]))];
    const result = await pool.query('SELECT id, name, color FROM server_roles WHERE id = ANY($1) AND server_id = $2', [ids, serverId]);
    result.rows.forEach(role => {
      mentionData.roles[role.id] = { name: role.name, color: role.color };
    });
  }
  return mentionData;
}

const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      if (isAllowedClientOrigin(origin)) return callback(null, true);
      return callback(new Error('Origin not allowed'));
    },
    credentials: true
  }
});

if (TRUST_PROXY && !['0', 'false', 'no', 'off'].includes(TRUST_PROXY.toLowerCase())) {
  app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY);
}

const sessionMiddleware = session({
  store: new pgSession({ pool, createTableIfMissing: true }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'nexus.sid',
  cookie: {
    secure: COOKIE_SECURE,
    httpOnly: true,
    sameSite: COOKIE_SAME_SITE,
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
});

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedClientOrigin(origin, req)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Nexus-Device-Id, X-Nexus-Device-Token, X-CSRF-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(setSecurityHeaders);
app.use(compression({ threshold: 1024 }));
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);
app.use((req, res, next) => {
  if (!req.session?.userId || req.session.authVersion === SESSION_SECURITY_VERSION) return next();
  req.session.destroy(() => {
    res.clearCookie('nexus.sid');
    if (req.path.startsWith('/api')) return res.status(401).json({ error: 'Your session expired for a security update. Please sign in again.' });
    next();
  });
});
app.use('/api', requireCsrfToken);
app.use('/api', async (req, res, next) => {
  if (!req.session?.userId) return next();
  try {
    const currentVersion = await getUserSessionVersion(req.session.userId);
    if ((Number(req.session.userSessionVersion) || 0) !== currentVersion) {
      return req.session.destroy(() => {
        res.clearCookie('nexus.sid');
        res.status(401).json({ error: 'Your session was revoked. Please sign in again.' });
      });
    }
    if (!isBrowserMediaRequest(req) && !(await validateHttpDeviceSession(req))) {
      return req.session.destroy(() => {
        res.clearCookie('nexus.sid');
        res.status(401).json({ error: 'This device session expired. Please sign in again.' });
      });
    }
    next();
  } catch (error) {
    console.error('Session validation failed:', error.message);
    res.status(500).json({ error: 'Session validation failed' });
  }
});
app.use('/api', (req, res, next) => {
  if (req.method !== 'OPTIONS' && !takeApiRateToken(req, 240, 60 * 1000)) {
    return res.status(429).json({ error: 'Too many requests. Please slow down.' });
  }
  next();
});
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !takeApiRateToken(req, 90, 60 * 1000, 'write')) {
    return res.status(429).json({ error: 'Too many write requests. Please slow down.' });
  }
  next();
});
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin && !isAllowedClientOrigin(origin, req)) return res.status(403).json({ error: 'Blocked cross-origin request' });
  next();
});
app.use((req, res, next) => { req.io = io; req.userSockets = userSockets; next(); });
app.use(express.static(path.join(__dirname, '../public'), {
  etag: true,
  maxAge: isProd ? '1h' : 0,
  setHeaders(res, filePath) {
    const extension = path.extname(filePath).toLowerCase();
    if (extension === '.html') {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (extension === '.js') {
      // Security fixes must replace an old cached client immediately after deploy.
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

app.use(async (req, res, next) => {
  if (!req.path.startsWith('/api')) return next();
  if (req.path === '/api/auth/logout') return next();
  try {
    const deviceId = requestDeviceId(req);
    if (!deviceId) return next();
    const banned = await pool.query('SELECT reason FROM ip_bans WHERE device_id=$1 AND active=TRUE LIMIT 1', [deviceId]);
    if (banned.rows.length) {
      return res.status(403).json({ error: 'This device is banned from Nexus' });
    }
  } catch (error) {
    console.error('Device ban check failed:', error.message);
  }
  next();
});

// Expose io so routes can emit socket events
app.set('io', io);

app.use('/api/auth', require('./routes/auth'));
app.use('/api', requireCurrentTos);
app.use('/api/friends', require('./routes/friends'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/users', require('./routes/users'));
app.use('/api/servers/:id/economy', require('./routes/economy'));
app.use('/api/servers', require('./routes/servers'));
app.use('/api/shop', require('./routes/shop'));
app.use('/api/limited', require('./routes/limited'));
app.use('/api/achievements', require('./routes/achievements'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/colors', require('./routes/colors'));
app.use('/api/perks', require('./routes/perks'));
app.use('/api/ringtones', require('./routes/ringtones'));
const gamesRoutes = require('./routes/games');
app.use('/api/games', gamesRoutes);
app.use('/api/auction', require('./routes/auction'));
app.use('/api/nexus-link', require('./routes/nexus-link'));

function validNexusLinkRequest(req) {
  const secret = String(process.env.NEXUS_LINK_SHARED_SECRET || '');
  const provided = String(req.get('x-nexus-link-secret') || '');
  const expected = Buffer.from(secret);
  const actual = Buffer.from(provided);
  if (!secret || actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

// Receives a reply sent to Nexus LINK in Discord and creates the matching Nexus DM.
app.post('/api/nexus-link/inbound-dm', async (req, res) => {
  if (!validNexusLinkRequest(req)) return res.status(401).json({ error: 'Unauthorized Nexus LINK relay' });
  const fromId = String(req.body.nexusUserId || '');
  const toId = String(req.body.nexusPeerId || '');
  let content;
  try {
    content = safeMessageContent(req.body.content, { field: 'Message' });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  if (!fromId || !toId) return res.status(400).json({ error: 'A sender and recipient are required' });
  const globalMute = await getGlobalMuteState(fromId);
  if (globalMute) return res.status(403).json({ error: 'Your Nexus account is globally muted' });
  const friendship = await pool.query(
    `SELECT id FROM friendships WHERE (user1_id=$1 AND user2_id=$2) OR (user1_id=$2 AND user2_id=$1) LIMIT 1`,
    [fromId, toId]
  );
  if (!friendship.rows.length) return res.status(403).json({ error: 'Nexus users must be friends to relay direct messages' });
  const sender = await pool.query(
    `SELECT u.username, u.display_name, (u.avatar_data IS NOT NULL) AS has_avatar, u.active_decoration, u.active_nameplate, u.active_color, u.active_font,
      u.pro_expires_at, u.profile_gradient_start, u.profile_gradient_end, u.profile_name_effect,
      ats.id AS tag_server_id, ats.name AS tag_server_name, ats.invite_code AS tag_invite_code, ats.server_tag, ats.tag_background, ats.tag_private
     FROM users u LEFT JOIN servers ats ON ats.id=u.active_server_tag_id WHERE u.id=$1`,
    [fromId]
  );
  if (!sender.rows[0]) return res.status(404).json({ error: 'Nexus sender was not found' });
  const user = sender.rows[0];
  const msg = {
    id: uuidv4(), fromId, toId, content, createdAt: Math.floor(Date.now() / 1000),
    author: {
      username: user.username, displayName: user.display_name,
      avatarDataUrl: avatarUrl(fromId, !!user.has_avatar),
      activeDecoration: user.active_decoration || null, activeNameplate: user.active_nameplate || null, activeColor: user.active_color || null, activeFont: user.active_font || null,
      proActive: (user.pro_expires_at || 0) > Math.floor(Date.now() / 1000), proGradientStart: user.profile_gradient_start, proGradientEnd: user.profile_gradient_end, proNameEffect: user.profile_name_effect,
      activeServerTag: user.server_tag || null, activeServerTagBackground: user.tag_background || '#5865f2', activeServerTagServerId: user.tag_server_id || null, activeServerTagServerName: user.tag_private ? null : (user.tag_server_name || null), activeServerTagInviteCode: user.tag_private ? null : (user.tag_invite_code || null), activeServerTagPrivate: !!user.tag_private
    }
  };
  await pool.query('INSERT INTO messages (id, from_id, to_id, content, created_at) VALUES ($1,$2,$3,$4,$5)', [msg.id, fromId, toId, content, msg.createdAt]);
  io.to(`user:${fromId}`).emit('new_message', msg);
  io.to(`user:${toId}`).emit('new_message', msg);
  res.json({ success: true, nexusMessageId: msg.id });
});

// Explicit Discord /reply delivery. The Discord bot resolves a Nexus username,
// while Nexus remains the source of truth for friendship and message delivery.
app.post('/api/nexus-link/outbound-dm', async (req, res) => {
  if (!validNexusLinkRequest(req)) return res.status(401).json({ error: 'Unauthorized Nexus LINK relay' });
  const fromId = String(req.body.nexusUserId || '');
  const username = String(req.body.username || '').trim().replace(/^@/, '');
  let content;
  try {
    content = safeMessageContent(req.body.content, { field: 'Message' });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  if (!fromId || !username) return res.status(400).json({ error: 'A recipient is required' });
  const globalMute = await getGlobalMuteState(fromId);
  if (globalMute) return res.status(403).json({ error: 'Your Nexus account is globally muted' });

  const recipientResult = await pool.query(
    `SELECT id, username, display_name FROM users WHERE LOWER(username)=LOWER($1) LIMIT 1`,
    [username]
  );
  const recipient = recipientResult.rows[0];
  if (!recipient) return res.status(404).json({ error: 'No Nexus user has that username' });
  if (recipient.id === fromId) return res.status(400).json({ error: 'You cannot send a Nexus DM to yourself' });

  const senderResult = await pool.query(
    `SELECT u.username, u.display_name, (u.avatar_data IS NOT NULL) AS has_avatar, u.active_decoration, u.active_nameplate, u.active_color, u.active_font,
      u.pro_expires_at, u.profile_gradient_start, u.profile_gradient_end, u.profile_name_effect,
      ats.id AS tag_server_id, ats.name AS tag_server_name, ats.invite_code AS tag_invite_code, ats.server_tag, ats.tag_background, ats.tag_private,
      EXISTS(SELECT 1 FROM friendships f WHERE (f.user1_id=u.id AND f.user2_id=$2) OR (f.user1_id=$2 AND f.user2_id=u.id)) AS friends
     FROM users u LEFT JOIN servers ats ON ats.id=u.active_server_tag_id WHERE u.id=$1`,
    [fromId, recipient.id]
  );
  const sender = senderResult.rows[0];
  if (!sender) return res.status(404).json({ error: 'Linked Nexus user was not found' });
  if (!sender.friends) return res.status(403).json({ error: 'You can only use /reply with Nexus friends' });

  const now = Math.floor(Date.now() / 1000);
  const msg = {
    id: uuidv4(), fromId, toId: recipient.id, content, createdAt: now,
    author: {
      username: sender.username, displayName: sender.display_name,
      avatarDataUrl: avatarUrl(fromId, !!sender.has_avatar),
      activeDecoration: sender.active_decoration || null, activeNameplate: sender.active_nameplate || null, activeColor: sender.active_color || null, activeFont: sender.active_font || null,
      proActive: (sender.pro_expires_at || 0) > now, proGradientStart: sender.profile_gradient_start, proGradientEnd: sender.profile_gradient_end, proNameEffect: sender.profile_name_effect,
      activeServerTag: sender.server_tag || null, activeServerTagBackground: sender.tag_background || '#5865f2', activeServerTagServerId: sender.tag_server_id || null, activeServerTagServerName: sender.tag_private ? null : (sender.tag_server_name || null), activeServerTagInviteCode: sender.tag_private ? null : (sender.tag_invite_code || null), activeServerTagPrivate: !!sender.tag_private
    }
  };
  await pool.query('INSERT INTO messages (id, from_id, to_id, content, created_at) VALUES ($1,$2,$3,$4,$5)', [msg.id, fromId, recipient.id, content, now]);
  io.to(`user:${fromId}`).emit('new_message', msg);
  io.to(`user:${recipient.id}`).emit('new_message', msg);
  relayNexusDirectMessage({
    nexusRecipientId: recipient.id,
    nexusMessageId: msg.id,
    sender: { id: fromId, username: sender.username, displayName: sender.display_name, avatarDataUrl: msg.author.avatarDataUrl, activeServerTag: sender.server_tag || null },
    content
  }).catch(error => console.error('Nexus LINK explicit DM relay error:', error));
  res.json({ success: true, nexusMessageId: msg.id, recipient: { id: recipient.id, username: recipient.username, displayName: recipient.display_name } });
});

app.post('/api/nexus-link/inbound-channel', async (req, res) => {
  if (!validNexusLinkRequest(req)) return res.status(401).json({ error: 'Unauthorized Nexus LINK relay' });
  const userId = String(req.body.nexusUserId || '');
  const serverId = String(req.body.serverId || '');
  const channelId = String(req.body.channelId || '');
  let content;
  try {
    content = safeMessageContent(req.body.content, { field: 'Message' });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  if (!userId || !serverId || !channelId) return res.status(400).json({ error: 'A mapped Nexus channel is required' });
  const globalMute = await getGlobalMuteState(userId);
  if (globalMute) return res.status(403).json({ error: 'Your Nexus account is globally muted' });
  const serverMute = await getMuteState(serverId, userId);
  if (serverMute) return res.status(403).json({ error: 'Your Nexus account is muted in this server' });
  const channelAccess = await getChannelAccess(pool, serverId, channelId, userId);
  if (!channelAccess || !['text', 'forum'].includes(channelAccess.channel_type || 'text')) {
    return res.status(403).json({ error: 'The linked Nexus account cannot post in that mapped channel' });
  }
  const result = await pool.query(
    `SELECT u.username, u.display_name, (u.avatar_data IS NOT NULL) AS has_avatar, u.active_decoration, u.active_nameplate,
      sm.role, sr.name AS role_name, sr.color AS role_color, sr.gradient_start, sr.gradient_end,
      ch.id AS valid_channel
     FROM server_members sm
     JOIN users u ON u.id=sm.user_id
     JOIN channels ch ON ch.id=$3 AND ch.server_id=$2 AND COALESCE(ch.channel_type, 'text') IN ('text','forum')
     LEFT JOIN server_roles sr ON sr.id=sm.role_id
     WHERE sm.server_id=$2 AND sm.user_id=$1`,
    [userId, serverId, channelId]
  );
  const row = result.rows[0];
  if (!row) return res.status(403).json({ error: 'The linked Nexus account cannot post in that mapped channel' });
  const now = Math.floor(Date.now() / 1000);
  const msg = {
    id: uuidv4(), serverId, channelId, fromId: userId, content, createdAt: now, isPinned: false,
    author: {
      username: row.username, displayName: row.display_name,
      avatarDataUrl: avatarUrl(userId, !!row.has_avatar),
      roleColor: row.role_color || null, roleName: row.role_name || null,
      roleGradientStart: row.gradient_start || null, roleGradientEnd: row.gradient_end || null,
      activeDecoration: row.active_decoration || null,
      activeNameplate: row.active_nameplate || null
    }
  };
  await pool.query('INSERT INTO channel_messages (id, channel_id, from_id, content, created_at) VALUES ($1,$2,$3,$4,$5)', [msg.id, channelId, userId, content, now]);
  emitToChannel(serverId, channelId, 'new_channel_message', msg);
  res.json({ success: true, nexusMessageId: msg.id });
});

app.post('/api/nexus-link/inbound-channel-reaction', async (req, res) => {
  if (!validNexusLinkRequest(req)) return res.status(401).json({ error: 'Unauthorized Nexus LINK relay' });
  const userId = String(req.body.nexusUserId || '');
  const messageId = String(req.body.nexusMessageId || '');
  const emoji = String(req.body.emoji || '').trim().slice(0, 16);
  if (!userId || !messageId || !emoji) return res.status(400).json({ error: 'A reaction is required' });
  const message = await pool.query(`SELECT cm.channel_id, ch.server_id FROM channel_messages cm JOIN channels ch ON ch.id=cm.channel_id JOIN server_members sm ON sm.server_id=ch.server_id AND sm.user_id=$2 WHERE cm.id=$1`, [messageId, userId]);
  if (!message.rows[0]) return res.status(403).json({ error: 'The linked account cannot react to that message' });
  if (!await canAccessChannel(pool, message.rows[0].server_id, message.rows[0].channel_id, userId)) {
    return res.status(403).json({ error: 'The linked account cannot access that channel' });
  }
  await pool.query(`INSERT INTO channel_message_reactions (id, message_id, user_id, emoji) VALUES ($1,$2,$3,$4) ON CONFLICT (message_id, user_id, emoji) DO NOTHING`, [uuidv4(), messageId, userId, emoji]);
  const aggregate = await pool.query(`SELECT emoji, COUNT(*)::int AS count, BOOL_OR(user_id=$2) AS reacted FROM channel_message_reactions WHERE message_id=$1 GROUP BY emoji ORDER BY count DESC, emoji ASC`, [messageId, userId]);
  emitToChannel(message.rows[0].server_id, message.rows[0].channel_id, 'channel_message_reaction_updated', { channelId: message.rows[0].channel_id, messageId, reactions: aggregate.rows.map(row => ({ emoji: row.emoji, count: parseInt(row.count, 10) || 0, reacted: !!row.reacted })) });
  res.json({ success: true });
});

app.post('/api/nexus-link/friend-requests/:requestId/respond', async (req, res) => {
  if (!validNexusLinkRequest(req)) return res.status(401).json({ error: 'Unauthorized Nexus LINK relay' });
  const userId = String(req.body.nexusUserId || '');
  const action = req.body.action;
  if (!userId || !['accept', 'decline'].includes(action)) return res.status(400).json({ error: 'Invalid friend-request response' });
  const result = await pool.query(
    `SELECT * FROM friend_requests WHERE id=$1 AND to_id=$2 AND status='pending'`,
    [req.params.requestId, userId]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Friend request was not found or was already handled' });
  const request = result.rows[0];
  if (action === 'accept') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE friend_requests SET status='accepted' WHERE id=$1`, [request.id]);
      await client.query(`INSERT INTO friendships (id, user1_id, user2_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [uuidv4(), request.from_id, request.to_id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  } else {
    await pool.query(`UPDATE friend_requests SET status='declined' WHERE id=$1`, [request.id]);
  }
  res.json({ success: true, action: action === 'accept' ? 'accepted' : 'declined' });
});

app.post('/api/nexus-link/calls/:roomId/decline', (req, res) => {
  if (!validNexusLinkRequest(req)) return res.status(401).json({ error: 'Unauthorized Nexus LINK relay' });
  const invite = directCallInvites.get(req.params.roomId);
  const userId = String(req.body.nexusUserId || '');
  if (!invite || invite.toId !== userId) return res.status(404).json({ error: 'Call invitation was not found' });
  directCallInvites.delete(req.params.roomId);
  callTypes.delete(req.params.roomId);
  io.to(`user:${invite.fromId}`).emit('call_declined', { roomId: req.params.roomId, byId: userId });
  res.json({ success: true });
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/limited', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, '../public/limited.html'));
});

app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

const userSockets = new Map();
const voiceRooms = new Map();
const callTypes = new Map();
const directCallInvites = new Map();
const userInCall = new Map();
const groupCallRooms = new Map(); // roomId -> Set<userId>
const userGroupCallRoom = new Map(); // userId -> roomId
const callGames = new Map(); // call/group room id -> shared card table
let redisClient = null;
const CALL_USER_KEY_PREFIX = 'nexus:call:user:';
const CALL_ROOM_KEY_PREFIX = 'nexus:call:room:';
const NEXUS_BOT_ID = '00000000-0000-0000-0000-000000000001';
const NEXUS_BOT_NAME = 'NexusGuard';
const NEXTBOT_ID = '00000000-0000-0000-0000-000000000002';
const NEXTBOT_NAME = 'NextBOT';
const NEXTBOT_AVATAR_DATA_URL = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5NiA5NiI+PGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSJuIiB4MT0iMCIgeTE9IjAiIHgyPSIxIiB5Mj0iMSI+PHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjMTMxYzQwIi8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjNzQ1Y2Y0Ii8+PC9saW5lYXJHcmFkaWVudD48bGluZWFyR3JhZGllbnQgaWQ9ImIiIHgxPSIwIiB5MT0iMCIgeDI9IjEiIHkyPSIxIj48c3RvcCBvZmZzZXQ9IjAiIHN0b3AtY29sb3I9IiNhYmI4ZmYiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiM2MTZlZjIiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz48Y2lyY2xlIGN4PSI0OCIgcj0iNDYiIGN5PSI0OCIgZmlsbD0idXJsKCNuKSIvPjxwYXRoIGQ9Ik0yNSA0NWg0NnYySDMxdjE2aDQwdjEwSDI1WiIgZmlsbD0iIzBiMTAyMCIgb3BhY2l0eT0iLjYiLz48cGF0aCBkPSJNMjggMzZoNDB2MjRIMjh6IiBmaWxsPSJ1cmwoI2IpIi8+PHBhdGggZD0iTTM5IDQ1aDR2NmgtNnYtMnptMTQgMGg0djZoLTZ2LTJ6bS0xNCAxNWgyMHY0SDM5eiIgZmlsbD0iI2ZmZiIvPjxwYXRoIGQ9Ik0yOCAyOGg4djZoLTh6bTMyIDBoOHY2aC04eiIgZmlsbD0iI2FiYjhmZiIvPjwvc3ZnPg==';
const NEXUS_BOT_AVATAR_DATA_URL = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5NiA5NiI+PGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSJnIiB4MT0iMCIgeTE9IjAiIHgyPSIxIiB5Mj0iMSI+PHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjMGYxNzJhIi8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjMWUyOTNiIi8+PC9saW5lYXJHcmFkaWVudD48bGluZWFyR3JhZGllbnQgaWQ9ImEiIHgxPSIwIiB5MT0iMCIgeDI9IjEiIHkyPSIxIj48c3RvcCBvZmZzZXQ9IjAiIHN0b3AtY29sb3I9IiNmNTllMGIiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiNmOTczMTYiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz48Y2lyY2xlIGN4PSI0OCIgY3k9IjQ4IiByPSI0NiIgZmlsbD0idXJsKCNnKSIvPjxwYXRoIGQ9Ik00OCAxNmwyNCA4djIyYzAgMTgtMTAgMzAtMjQgMzYtMTQtNi0yNC0xOC0yNC0zNlYyNHoiIGZpbGw9InVybCgjYSkiLz48cGF0aCBkPSJNNDggMjZsMTQgNXYxNWMwIDExLTYgMTktMTQgMjMtOC00LTE0LTEyLTE0LTIzVjMxeiIgZmlsbD0iIzExMTgyNyIgb3BhY2l0eT0iLjY1Ii8+PGNpcmNsZSBjeD0iNDgiIGN5PSI0NSIgcj0iNyIgZmlsbD0iI2ZkZTY4YSIvPjxwYXRoIGQ9Ik0zNiA1OWgyNHY1SDM2eiIgZmlsbD0iI2ZkZTY4YSIvPjwvc3ZnPg==';
const spamTracker = new Map();
const TABLE_TOKEN_NUMERATOR = 1000;
const TABLE_TOKEN_DENOMINATOR = 900;

function nexalsToTableTokens(nexals) {
  return Math.floor((Math.max(0, parseInt(nexals, 10) || 0) * TABLE_TOKEN_NUMERATOR) / TABLE_TOKEN_DENOMINATOR);
}

function tableTokensToNexals(tokens) {
  return Math.floor((Math.max(0, parseInt(tokens, 10) || 0) * TABLE_TOKEN_DENOMINATOR) / TABLE_TOKEN_NUMERATOR);
}

function gameDeck() {
  return ['A','2','3','4','5','6','7','8','9','10','J','Q','K'].flatMap(rank => ['S','H','D','C'].map(suit => ({ rank, suit })));
}
function shuffle(cards) { for (let i = cards.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [cards[i], cards[j]] = [cards[j], cards[i]]; } return cards; }
function blackjackScore(cards) { let total = cards.reduce((sum, c) => sum + (c.rank === 'A' ? 11 : ['J','Q','K'].includes(c.rank) ? 10 : Number(c.rank)), 0); let aces = cards.filter(c => c.rank === 'A').length; while (total > 21 && aces--) total -= 10; return total; }
function unoDeck() {
  const cards = [];
  const colors = ['red', 'yellow', 'green', 'blue'];
  const add = (color, value) => cards.push({ id: uuidv4(), color, value });
  for (const color of colors) {
    add(color, '0');
    for (let value = 1; value <= 9; value++) {
      add(color, String(value));
      add(color, String(value));
    }
    for (const action of ['skip', 'reverse', 'draw2']) {
      add(color, action);
      add(color, action);
    }
  }
  for (let count = 0; count < 4; count++) {
    add('wild', 'wild');
    add('wild', 'wild4');
  }
  return cards;
}
function unoCardPoints(card) {
  if (!card) return 0;
  if (['wild', 'wild4'].includes(card.value)) return 50;
  if (['skip', 'reverse', 'draw2'].includes(card.value)) return 20;
  return Number(card.value) || 0;
}
function refillUnoDeck(game) {
  if (game.deck.length || game.discard.length <= 1) return;
  const top = game.discard.pop();
  game.deck = shuffle(game.discard.map(card => ({ ...card, id: uuidv4() })));
  game.discard = [top];
}
function drawUnoCards(game, player, count) {
  for (let index = 0; index < count; index++) {
    refillUnoDeck(game);
    const card = game.deck.pop();
    if (card) player.hand.push(card);
  }
}
function advanceUnoTurn(game, steps = 1) {
  if (!game.players.length) return;
  let index = game.players.findIndex(player => player.id === game.turnId);
  if (index < 0) index = 0;
  for (let step = 0; step < steps; step++) {
    index = (index + game.direction + game.players.length) % game.players.length;
  }
  game.turnId = game.players[index].id;
}
function isPlayableUnoCard(game, card) {
  const top = game.discard[game.discard.length - 1];
  return card.color === 'wild' || card.color === game.currentColor || card.value === top?.value;
}
function gameStateFor(game, viewerId) {
  if (game.type === 'connect4') {
    return {
      type: game.type,
      phase: game.phase,
      hostId: game.hostId,
      turnId: game.turnId || null,
      board: game.connect4Board?.map || Array.from({ length: 6 }, () => Array(7).fill(ConnectFourPiece.EMPTY)),
      players: game.players.map((player, index) => ({
        id: player.id,
        displayName: player.displayName,
        piece: index === 0 ? ConnectFourPiece.PLAYER_1 : ConnectFourPiece.PLAYER_2
      })),
      winnerId: game.winnerId || null,
      message: game.message || ''
    };
  }
  if (game.type === 'uno') {
    return {
      type: game.type,
      phase: game.phase,
      hostId: game.hostId,
      roundsTotal: game.roundsTotal || 1,
      roundNumber: game.roundNumber || 0,
      turnId: game.turnId || null,
      currentColor: game.currentColor || null,
      direction: game.direction || 1,
      topCard: game.discard?.[game.discard.length - 1] || null,
      deckCount: game.deck?.length || 0,
      dealer: null,
      community: [],
      pot: 0,
      canPass: !!game.players.find(player => player.id === viewerId)?.drawnCardId,
      players: game.players.map(player => ({
        id: player.id,
        displayName: player.displayName,
        chips: 0,
        folded: false,
        score: player.score || 0,
        cardCount: player.hand.length,
        hand: player.id === viewerId || game.phase === 'complete'
          ? player.hand
          : player.hand.map(() => ({ hidden: true }))
      })),
      winnerId: game.winnerId || null,
      message: game.message || ''
    };
  }
  const blackjackStarted = game.type === 'blackjack' && game.phase !== 'lobby';
  const revealDealer = game.type !== 'blackjack' || game.phase === 'round_complete' || game.phase === 'complete';
  return { type: game.type, phase: game.phase, hostId: game.hostId, roundsTotal: game.roundsTotal || 1, roundNumber: game.roundNumber || 0, turnId: game.turnId || null, community: game.community || [], pot: game.pot || 0,
    dealer: game.type === 'blackjack' ? { hand: !blackjackStarted ? [] : (revealDealer ? game.dealer.hand : [game.dealer.hand[0], { hidden: true }]), score: revealDealer ? blackjackScore(game.dealer.hand) : null } : null,
    players: game.players.map(p => ({ id: p.id, displayName: p.displayName, chips: p.chips, buyIn: p.buyIn || 0, bet: p.bet || 0, folded: !!p.folded, standing: !!p.standing, hand: p.id === viewerId || game.phase === 'complete' ? p.hand : p.hand.map(() => ({ hidden: true })), score: game.type === 'blackjack' ? blackjackScore(p.hand) : null })), winnerId: game.winnerId || null, message: game.message || '' };
}
function beginCallGameRound(game) {
  if (game.type === 'connect4') {
    game.connect4Board = new ConnectFourBoard();
    game.phase = 'playing';
    game.winnerId = null;
    game.message = '';
    game.turnId = game.players[0].id;
    return;
  }
  if (game.type === 'uno') {
    game.deck = shuffle(unoDeck());
    game.discard = [];
    game.direction = 1;
    game.winnerId = null;
    game.phase = 'playing';
    game.message = '';
    game.players.forEach(player => {
      player.hand = [];
      player.drawnCardId = null;
      drawUnoCards(game, player, 7);
    });
    let first = game.deck.pop();
    while (first && ['wild4', 'draw2', 'skip', 'reverse'].includes(first.value)) {
      game.deck.unshift(first);
      game.deck = shuffle(game.deck);
      first = game.deck.pop();
    }
    if (!first) first = { id: uuidv4(), color: 'red', value: '0' };
    game.discard.push(first);
    const colors = ['red', 'yellow', 'green', 'blue'];
    game.currentColor = first.color === 'wild' ? colors[crypto.randomInt(colors.length)] : first.color;
    const startingIndex = (game.startingPlayerIndex || 0) % game.players.length;
    game.turnId = game.players[startingIndex].id;
    game.startingPlayerIndex = (startingIndex + 1) % game.players.length;
    return;
  }
  game.deck = shuffle(gameDeck());
  game.phase = 'playing';
  game.message = '';
  game.players.forEach(player => {
    player.hand = [game.deck.pop(), game.deck.pop()];
    player.standing = false;
    player.folded = false;
    if (game.type !== 'blackjack') player.bet = 0;
  });
  if (game.type === 'blackjack') {
    game.dealer.hand = [game.deck.pop(), game.deck.pop()];
  } else {
    game.community = [game.deck.pop(), game.deck.pop(), game.deck.pop()];
    game.pot = 0;
    game.turnId = game.players[0].id;
  }
}
function emitGame(roomId) { const game = callGames.get(roomId); if (!game) return; for (const player of game.players) io.to(`user:${player.id}`).emit('call_game_state', { roomId, game: gameStateFor(game, player.id) }); }
async function settleCallGame(roomId, reason = 'Activity ended') {
  const game = callGames.get(roomId);
  if (!game || game.settled) return [];
  game.settled = true;
  if (game.type === 'uno' || game.type === 'connect4') {
    game.message = reason;
    return [];
  }
  const payouts = [];
  for (const player of game.players || []) {
    const payout = tableTokensToNexals(player.chips || 0);
    payouts.push({ userId: player.id, displayName: player.displayName, payout });
    if (payout > 0) {
      const updated = await pool.query('UPDATE users SET nexals=nexals+$1 WHERE id=$2 RETURNING nexals', [payout, player.id]);
      io.to(`user:${player.id}`).emit('nexals_updated', { nexals: updated.rows[0]?.nexals || 0 });
    }
  }
  const summary = payouts.map(p => `${p.displayName}: ${p.payout.toLocaleString()} Nexals`).join(' | ');
  game.message = `${reason}. Table tokens settled: ${summary || 'no payouts'}.`;
  return payouts;
}
async function closeDirectCallRoom(roomId, reason = 'Call ended') {
  if (!roomId) return;
  if (callGames.has(roomId)) {
    await settleCallGame(roomId, reason);
    callGames.delete(roomId);
    io.to(`call:${roomId}`).emit('call_game_closed', { roomId, reason });
    io.to(`groupcall:${roomId}`).emit('call_game_closed', { roomId, reason });
  }
  const room = await getRoomParticipants(roomId);
  if (room && room.size) {
    for (const uid of room) {
      await clearUserCallRoom(uid);
      io.to(`user:${uid}`).emit('call_ended', { roomId });
    }
  }
  await clearRoomParticipants(roomId);
  callTypes.delete(roomId);
}
async function isInGameRoom(userId, roomId) {
  if (userGroupCallRoom.get(userId) === roomId || groupCallRooms.get(roomId)?.has(userId)) return true;
  return (await getUserCallRoom(userId)) === roomId;
}
async function buyCallTableTokens(userId, buyInNexals) {
  const buyIn = Math.min(100000, Math.max(0, parseInt(buyInNexals, 10) || 0));
  if (buyIn <= 0) throw new Error('Choose a Nexal buy-in first.');
  const tokens = nexalsToTableTokens(buyIn);
  if (tokens <= 0) throw new Error('Buy-in is too small for table tokens.');
  const updated = await pool.query(
    'UPDATE users SET nexals=nexals-$1 WHERE id=$2 AND nexals >= $1 RETURNING nexals',
    [buyIn, userId]
  );
  if (!updated.rows.length) throw new Error('Not enough Nexals for that buy-in.');
  return { buyIn, tokens, nexals: updated.rows[0].nexals };
}
const NEXUS_BOT_AUTHOR = {
  username: 'nexusguard',
  displayName: NEXUS_BOT_NAME,
  avatarDataUrl: NEXUS_BOT_AVATAR_DATA_URL,
  roleColor: '#f4b942',
  roleName: 'Bot',
  activeDecoration: null,
  activeColor: '#f4b942',
  activeFont: null
};
const NEXTBOT_AUTHOR = {
  username: 'nextbot',
  displayName: NEXTBOT_NAME,
  avatarDataUrl: NEXTBOT_AVATAR_DATA_URL,
  roleColor: '#aab8ff',
  roleName: 'App',
  isBot: true,
  activeDecoration: null,
  activeColor: '#7c8cff',
  activeFont: null
};

async function ensureNexusGuardExists() {
  await pool.query(
    `INSERT INTO users (id, username, display_name, password_hash, status, active_color, avatar_mime, avatar_data)
     VALUES ($1,'nexusguard','NexusGuard','nexusguard-local-only','online','#f4b942','image/svg+xml',$2)
     ON CONFLICT (id) DO UPDATE SET
       username='nexusguard',
       display_name='NexusGuard',
       status='online',
       active_color='#f4b942',
       avatar_mime='image/svg+xml',
       avatar_data=$2`,
    [NEXUS_BOT_ID, NEXUS_BOT_AVATAR_DATA_URL.replace(/^data:image\/svg\+xml;base64,/, '')]
  );
}

async function getServerBotConfig(serverId) {
  const blockedWordsRes = await pool.query(
    'SELECT word FROM server_blocked_words WHERE server_id=$1 ORDER BY word ASC',
    [serverId]
  );
  const blockedWords = blockedWordsRes.rows.map(r => String(r.word || '').trim().toLowerCase()).filter(Boolean);

  const r = await pool.query(
    `SELECT bot_prefix, bot_enabled, bot_auto_mod, bot_block_links,
            bot_caps_threshold, bot_spam_window
     FROM servers WHERE id=$1`,
    [serverId]
  );
  if (!r.rows.length) {
    return {
      botName: NEXUS_BOT_NAME,
      botPrefix: '/',
      botEnabled: true,
      botAutoMod: true,
      botBlockLinks: false,
      botCapsThreshold: 90,
      botSpamWindow: 6,
      blockedWords
    };
  }
  const row = r.rows[0];
  const prefix = (row.bot_prefix || '/').toString();
  return {
    botName: NEXUS_BOT_NAME,
    botPrefix: prefix.length ? prefix.slice(0, 2) : '/',
    botEnabled: row.bot_enabled !== false,
    botAutoMod: row.bot_auto_mod !== false,
    botBlockLinks: !!row.bot_block_links,
    botCapsThreshold: Math.min(100, Math.max(50, parseInt(row.bot_caps_threshold, 10) || 90)),
    botSpamWindow: Math.min(20, Math.max(3, parseInt(row.bot_spam_window, 10) || 6)),
    blockedWords
  };
}

async function setupRedisBackplane() {
  if (!REDIS_URL) {
    console.warn('REDIS_URL not set, running without cross-instance realtime sync.');
    return;
  }

  try {
    const pubClient = createClient({ url: REDIS_URL });
    const subClient = pubClient.duplicate();
    await Promise.all([pubClient.connect(), subClient.connect()]);
    io.adapter(createAdapter(pubClient, subClient));
    redisClient = pubClient;
    console.log('Redis backplane connected for Socket.IO.');
  } catch (err) {
    console.error('Redis backplane unavailable, continuing in single-instance mode:', err.message);
  }
}

function getCallUserKey(userId) {
  return `${CALL_USER_KEY_PREFIX}${userId}`;
}

function getCallRoomKey(roomId) {
  return `${CALL_ROOM_KEY_PREFIX}${roomId}`;
}

function getGroupCallRoomId(serverId, channelId) {
  return `${serverId}:${channelId || 'general'}`;
}

function mapUserForClient(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarDataUrl: avatarUrl(row.from_id || row.user_id || row.id, !!(row.has_avatar || row.avatar_data))
  };
}

async function getUserCallRoom(userId) {
  if (redisClient && redisClient.isOpen) {
    return redisClient.get(getCallUserKey(userId));
  }
  return userInCall.get(userId) || null;
}

async function setUserCallRoom(userId, roomId) {
  if (redisClient && redisClient.isOpen) {
    await redisClient.set(getCallUserKey(userId), roomId, { EX: 60 * 60 * 12 });
  }
  userInCall.set(userId, roomId);
}

async function clearUserCallRoom(userId) {
  if (redisClient && redisClient.isOpen) {
    await redisClient.del(getCallUserKey(userId));
  }
  userInCall.delete(userId);
}

async function setRoomParticipants(roomId, participants) {
  if (redisClient && redisClient.isOpen) {
    const roomKey = getCallRoomKey(roomId);
    await redisClient.del(roomKey);
    if (participants.length) {
      await redisClient.sAdd(roomKey, participants.map(String));
      await redisClient.expire(roomKey, 60 * 60 * 12);
    }
  }
  voiceRooms.set(roomId, new Set(participants));
}

async function getRoomParticipants(roomId) {
  if (redisClient && redisClient.isOpen) {
    const participants = await redisClient.sMembers(getCallRoomKey(roomId));
    return new Set(participants || []);
  }
  return voiceRooms.get(roomId) || new Set();
}

async function clearRoomParticipants(roomId) {
  if (redisClient && redisClient.isOpen) {
    await redisClient.del(getCallRoomKey(roomId));
  }
  voiceRooms.delete(roomId);
}

io.use(async (socket, next) => {
  const sess = socket.request.session;
  const activityToken = verifyActivityCallToken(socket.handshake.auth?.nexusLinkCallToken);
  const userId = String(sess?.userId || activityToken?.nexusUserId || '');
  if (!userId) return next(new Error('Unauthorized'));
  if (!takeSocketRateToken(userId, 'socket_connect', 12, 60 * 1000)) {
    return next(new Error('RATE_LIMITED'));
  }
  if (!activityToken && sess?.authVersion !== SESSION_SECURITY_VERSION) {
    return next(new Error('Session expired for a security update'));
  }
  try {
    if (activityToken) {
      socket.data.activityOnly = true;
      socket.data.activityCall = activityToken;
      socket.request.session = socket.request.session || {};
      socket.request.session.userId = userId;
    } else {
      const ip = requestIp(socket.request);
      const deviceId = socketDeviceId(socket);
      if (deviceId) {
        const banned = await pool.query('SELECT reason FROM ip_bans WHERE device_id=$1 AND active=TRUE LIMIT 1', [deviceId]);
        if (banned.rows.length) return next(new Error('This device is banned from Nexus'));
      }
      const currentVersion = await getUserSessionVersion(userId);
      if ((Number(sess.userSessionVersion) || 0) !== currentVersion) {
        return next(new Error('Session revoked'));
      }
      if (!(await validateSocketDeviceSession(socket))) {
        return next(new Error('Device session expired'));
      }
      await pool.query('UPDATE users SET last_ip=$1, last_device_id=$2 WHERE id=$3', [ip || null, deviceId || null, userId]);
      const tosState = await getUserTosState(userId);
      socket.data.tosAcceptedVersion = tosState.acceptedVersion;
    }
  } catch (error) {
    console.error('Socket device ban check failed:', error.message);
  }
  socket.userId = userId;
  next();
});

// ---- Achievement auto-tracker ----
async function trackAchievement(userId, fields) {
  try {
    // Just sync — the achievements route handles the logic
    // We do a lightweight check: count messages/etc and upsert progress
    const { ACHIEVEMENTS } = require('./routes/achievements');
    for (const field of fields) {
      const relevant = ACHIEVEMENTS.filter(a => a.field === field);
      if (!relevant.length) continue;

      let count = 0;
      if (field === 'messages_sent' || field === 'dms_sent') {
        const r = await pool.query('SELECT COUNT(*) FROM messages WHERE from_id=$1', [userId]);
        count = parseInt(r.rows[0].count);
      } else if (field === 'channel_msgs') {
        const r = await pool.query('SELECT COUNT(*) FROM channel_messages WHERE from_id=$1', [userId]);
        count = parseInt(r.rows[0].count);
      }

      for (const a of relevant) {
        const progress = Math.min(count, a.target);
        const completed = count >= a.target;
        const now = Math.floor(Date.now() / 1000);
        const { v4: uuidv4 } = require('uuid');
        await pool.query(`
          INSERT INTO user_achievements (id, user_id, achievement_id, progress, completed_at)
          VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (user_id, achievement_id) DO UPDATE
            SET progress = GREATEST(user_achievements.progress, $4),
                completed_at = CASE
                  WHEN user_achievements.completed_at IS NULL AND $6 THEN $5
                  ELSE user_achievements.completed_at END
        `, [uuidv4(), userId, a.id, progress, completed ? now : null, completed]);
      }
    }
  } catch(e) { console.error('Achievement track error:', e.message); }
}

function parseDurationToSeconds(raw) {
  const m = String(raw || '').trim().match(/^(\d+)([smhd])$/i);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  if (!n || n < 1) return 0;
  if (unit === 's') return n;
  if (unit === 'm') return n * 60;
  if (unit === 'h') return n * 60 * 60;
  return n * 60 * 60 * 24;
}

function humanDuration(seconds) {
  const s = Math.max(0, parseInt(seconds, 10) || 0);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.ceil(s / 60)}m`;
  if (s < 86400) return `${Math.ceil(s / 3600)}h`;
  return `${Math.ceil(s / 86400)}d`;
}

function giveawayMessageContent(giveawayId) {
  return `[[nextbot-giveaway:${giveawayId}]]`;
}

function giveawayForClient(row) {
  return {
    id: row.id,
    serverId: row.server_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    prize: row.prize,
    description: row.description || '',
    winnerCount: Math.max(1, parseInt(row.winner_count, 10) || 1),
    createdBy: row.created_by,
    createdAt: parseInt(row.created_at, 10) || 0,
    endsAt: parseInt(row.ends_at, 10) || 0,
    endedAt: row.ended_at ? parseInt(row.ended_at, 10) : null,
    status: row.status,
    entryCount: Math.max(0, parseInt(row.entry_count, 10) || 0),
    entered: !!row.entered,
    winners: Array.isArray(row.winners) ? row.winners : []
  };
}

async function getGiveawaySnapshot(giveawayId, viewerId = null) {
  const result = await pool.query(
    `SELECT g.*,
      COALESCE(entries.entry_count, 0)::int AS entry_count,
      COALESCE(winner_data.winners, '[]'::json) AS winners,
      CASE WHEN $2::text IS NULL THEN FALSE ELSE EXISTS (
        SELECT 1 FROM server_giveaway_entries self_entry
        WHERE self_entry.giveaway_id=g.id AND self_entry.user_id=$2
      ) END AS entered
     FROM server_giveaways g
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS entry_count
       FROM server_giveaway_entries entry_count
       WHERE entry_count.giveaway_id=g.id
     ) entries ON TRUE
     LEFT JOIN LATERAL (
       SELECT json_agg(json_build_object(
         'id', u.id,
         'displayName', u.display_name,
         'username', u.username,
         'position', w.position
       ) ORDER BY w.position ASC) AS winners
       FROM server_giveaway_winners w
       JOIN users u ON u.id=w.user_id
       WHERE w.giveaway_id=g.id
     ) winner_data ON TRUE
     WHERE g.id=$1`,
    [giveawayId, viewerId]
  );
  return result.rows[0] ? giveawayForClient(result.rows[0]) : null;
}

async function emitGiveawayUpdate(giveawayId, viewerId = null) {
  const giveaway = await getGiveawaySnapshot(giveawayId, viewerId);
  if (giveaway) {
    if (!viewerId) delete giveaway.entered;
  emitToChannel(giveaway.serverId, giveaway.channelId, 'giveaway_updated', giveaway);
  }
  return giveaway;
}

async function createServerGiveaway({ serverId, channelId, createdBy, prize, description = '', durationSeconds, winnerCount }) {
  await ensureNextBotExists();
  const now = Math.floor(Date.now() / 1000);
  const giveawayId = uuidv4();
  const messageId = uuidv4();
  const endsAt = now + durationSeconds;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO server_giveaways
       (id, server_id, channel_id, message_id, prize, description, winner_count, created_by, ends_at, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10)`,
      [giveawayId, serverId, channelId, messageId, prize, description || null, winnerCount, createdBy, endsAt, now]
    );
    await client.query(
      'INSERT INTO channel_messages (id, channel_id, from_id, content, created_at) VALUES ($1,$2,$3,$4,$5)',
      [messageId, channelId, NEXTBOT_ID, giveawayMessageContent(giveawayId), now]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const giveaway = await getGiveawaySnapshot(giveawayId, createdBy);
  const message = {
    id: messageId,
    serverId,
    channelId,
    fromId: NEXTBOT_ID,
    content: giveawayMessageContent(giveawayId),
    createdAt: now,
    giveaway,
    author: NEXTBOT_AUTHOR
  };
  emitToChannel(serverId, channelId, 'new_channel_message', message);
  return giveaway;
}

async function completeServerGiveaway(giveawayId, force = false) {
  const client = await pool.connect();
  let completed = null;
  try {
    await client.query('BEGIN');
    const giveawayResult = await client.query('SELECT * FROM server_giveaways WHERE id=$1 FOR UPDATE', [giveawayId]);
    const giveaway = giveawayResult.rows[0];
    if (!giveaway || giveaway.status !== 'active') {
      await client.query('ROLLBACK');
      return null;
    }
    const now = Math.floor(Date.now() / 1000);
    if (!force && Number(giveaway.ends_at) > now) {
      await client.query('ROLLBACK');
      return null;
    }
    const entries = await client.query(
      'SELECT user_id FROM server_giveaway_entries WHERE giveaway_id=$1 ORDER BY entered_at ASC, user_id ASC',
      [giveawayId]
    );
    const candidates = entries.rows.map(row => row.user_id);
    for (let index = candidates.length - 1; index > 0; index--) {
      const swapIndex = crypto.randomInt(index + 1);
      [candidates[index], candidates[swapIndex]] = [candidates[swapIndex], candidates[index]];
    }
    const winners = candidates.slice(0, Math.min(Number(giveaway.winner_count) || 1, candidates.length));
    for (let index = 0; index < winners.length; index++) {
      await client.query(
        'INSERT INTO server_giveaway_winners (giveaway_id, user_id, position) VALUES ($1,$2,$3)',
        [giveawayId, winners[index], index + 1]
      );
    }
    await client.query("UPDATE server_giveaways SET status='ended', ended_at=$2 WHERE id=$1", [giveawayId, now]);
    await client.query('COMMIT');
    completed = giveaway;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  if (!completed) return null;
  const giveaway = await emitGiveawayUpdate(giveawayId);
  (giveaway?.winners || []).forEach(winner => {
    io.to(`user:${winner.id}`).emit('giveaway_won', {
      giveawayId,
      prize: giveaway.prize,
      serverId: giveaway.serverId,
      channelId: giveaway.channelId
    });
  });
  return giveaway;
}

let giveawaySweepRunning = false;
async function settleDueGiveaways() {
  if (giveawaySweepRunning) return;
  giveawaySweepRunning = true;
  try {
    const due = await pool.query(
      "SELECT id FROM server_giveaways WHERE status='active' AND ends_at <= $1 ORDER BY ends_at ASC LIMIT 25",
      [Math.floor(Date.now() / 1000)]
    );
    for (const row of due.rows) {
      try { await completeServerGiveaway(row.id); }
      catch (error) { console.error('Giveaway completion failed:', error.message); }
    }
  } finally {
    giveawaySweepRunning = false;
  }
}

async function emitBotChannelMessage({ serverId, channelId, content, botName = null }) {
  let resolvedBotName = botName;
  if (!resolvedBotName) {
    const cfg = await getServerBotConfig(serverId);
    resolvedBotName = cfg.botName;
  }
  const now = Math.floor(Date.now() / 1000);
  const msg = {
    id: uuidv4(),
    serverId,
    channelId,
    fromId: NEXUS_BOT_ID,
    content,
    createdAt: now,
    author: {
      ...NEXUS_BOT_AUTHOR,
      displayName: resolvedBotName || NEXUS_BOT_NAME
    }
  };
  emitToChannel(serverId, channelId, 'new_channel_message', msg);
  pool.query(
    'INSERT INTO channel_messages (id, channel_id, from_id, content, created_at) VALUES ($1,$2,$3,$4,$5)',
    [msg.id, channelId, NEXUS_BOT_ID, content, now]
  ).catch(e => console.error('NexusBot msg insert error:', e));
}

async function sendBotDirectMessage({ toUserId, content }) {
  const trimmed = String(content || '').trim().slice(0, 4000);
  if (!trimmed || !toUserId) return;
  await ensureNexusGuardExists();
  const now = Math.floor(Date.now() / 1000);
  const msg = {
    id: uuidv4(),
    fromId: NEXUS_BOT_ID,
    toId: toUserId,
    content: trimmed,
    createdAt: now,
    author: {
      username: NEXUS_BOT_AUTHOR.username,
      displayName: NEXUS_BOT_NAME,
      avatarDataUrl: NEXUS_BOT_AVATAR_DATA_URL,
      activeDecoration: null,
      activeColor: '#f4b942',
      activeFont: null
    }
  };
  io.to(`user:${toUserId}`).emit('new_message', msg);
  await pool.query(
    'INSERT INTO messages (id, from_id, to_id, content, created_at) VALUES ($1,$2,$3,$4,$5)',
    [msg.id, NEXUS_BOT_ID, toUserId, trimmed, now]
  );
}

async function ensureNextBotExists() {
  await pool.query(
    `INSERT INTO users (id, username, display_name, password_hash, status, active_color, avatar_mime, avatar_data)
     VALUES ($1,'nextbot','NextBOT','nextbot-local-only','online','#7c8cff','image/svg+xml',$2)
     ON CONFLICT (id) DO UPDATE SET
       username='nextbot',
       display_name='NextBOT',
       status='online',
       active_color='#7c8cff',
       avatar_mime='image/svg+xml',
       avatar_data=$2`,
    [NEXTBOT_ID, NEXTBOT_AVATAR_DATA_URL.replace(/^data:image\/svg\+xml;base64,/, '')]
  );
}

async function relayNexusDirectMessage({ nexusRecipientId, nexusMessageId, sender, content }) {
  const linkUrl = String(process.env.NEXUS_LINK_URL || '').replace(/\/$/, '');
  const secret = process.env.NEXUS_LINK_SHARED_SECRET;
  if (!linkUrl || !secret) return;
  const response = await fetch(`${linkUrl}/relay/nexus-dm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nexus-link-secret': secret },
    body: JSON.stringify({ nexusRecipientId, nexusMessageId, sender, content, attachments: [] })
  });
  if (!response.ok) throw new Error(`Nexus LINK DM relay returned ${response.status}`);
}

async function relayNexusCallInvite({ nexusRecipientId, roomId, callType, caller }) {
  const linkUrl = String(process.env.NEXUS_LINK_URL || '').replace(/\/$/, '');
  const secret = process.env.NEXUS_LINK_SHARED_SECRET;
  if (!linkUrl || !secret) return;
  const response = await fetch(`${linkUrl}/relay/call-invite`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nexus-link-secret': secret },
    body: JSON.stringify({ nexusRecipientId, roomId, callType, caller })
  });
  if (!response.ok) throw new Error(`Nexus LINK call relay returned ${response.status}`);
}

async function relayNexusChannelMessage({ serverId, channelId, nexusMessageId, sender, content, replyTo }) {
  const linkUrl = String(process.env.NEXUS_LINK_URL || '').replace(/\/$/, '');
  const secret = process.env.NEXUS_LINK_SHARED_SECRET;
  if (!linkUrl || !secret) return;
  const response = await fetch(`${linkUrl}/relay/nexus-channel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nexus-link-secret': secret },
    body: JSON.stringify({ serverId, channelId, nexusMessageId, sender, content, replyTo })
  });
  if (!response.ok) throw new Error(`Nexus LINK channel relay returned ${response.status}`);
}

async function relayNexusChannelReaction({ nexusMessageId, emoji }) {
  const linkUrl = String(process.env.NEXUS_LINK_URL || '').replace(/\/$/, '');
  const secret = process.env.NEXUS_LINK_SHARED_SECRET;
  if (!linkUrl || !secret) return;
  const response = await fetch(`${linkUrl}/relay/nexus-channel-reaction`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nexus-link-secret': secret },
    body: JSON.stringify({ nexusMessageId, emoji })
  });
  if (!response.ok) throw new Error(`Nexus LINK reaction relay returned ${response.status}`);
}

async function logModerationAction({ serverId, channelId, action, actorUserId, targetUserId = null, details = null }) {
  const now = Math.floor(Date.now() / 1000);
  await pool.query(
    `INSERT INTO moderation_logs (id, server_id, channel_id, action, actor_user_id, target_user_id, details, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [uuidv4(), serverId, channelId || null, action, actorUserId, targetUserId, details, now]
  );
}

async function getServerActorPerms(serverId, actorUserId) {
  const r = await pool.query(
    `SELECT s.owner_id,
            sm.role as member_role,
            sm.role_id,
            sr.is_admin,
            sr.can_delete_messages,
            u.username,
            u.display_name
     FROM servers s
     LEFT JOIN server_members sm ON sm.server_id=s.id AND sm.user_id=$2
     LEFT JOIN server_roles sr ON sr.id=sm.role_id
     LEFT JOIN users u ON u.id=$2
     WHERE s.id=$1`,
    [serverId, actorUserId]
  );
  if (!r.rows.length || !r.rows[0].member_role) return null;
  const row = r.rows[0];
  const isOwner = row.owner_id === actorUserId;
  const isAdmin = isOwner || row.member_role === 'admin' || !!row.is_admin;
  const canModerate = isAdmin || !!row.can_delete_messages;
  return {
    row,
    isOwner,
    isAdmin,
    canModerate,
    actorName: row.display_name || row.username || 'Unknown'
  };
}

async function getMuteState(serverId, userId) {
  const r = await pool.query(
    'SELECT id, muted_until FROM server_mutes WHERE server_id=$1 AND user_id=$2',
    [serverId, userId]
  );
  if (!r.rows.length) return null;
  const mute = r.rows[0];
  const now = Math.floor(Date.now() / 1000);
  if (parseInt(mute.muted_until, 10) <= now) {
    await pool.query('DELETE FROM server_mutes WHERE id=$1', [mute.id]);
    return null;
  }
  return { id: mute.id, mutedUntil: parseInt(mute.muted_until, 10) };
}

async function getGlobalMuteState(userId) {
  const result = await pool.query(
    `SELECT id, muted_until FROM global_mutes
     WHERE user_id=$1 AND active=TRUE ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  if (!result.rows.length) return null;
  const mute = result.rows[0];
  const now = Math.floor(Date.now() / 1000);
  if (Number(mute.muted_until) <= now) {
    await pool.query('UPDATE global_mutes SET active=FALSE WHERE id=$1', [mute.id]);
    return null;
  }
  return { id: mute.id, mutedUntil: Number(mute.muted_until) };
}

async function runChannelCommand({ socket, serverId, channelId, actorUserId, actorDisplayName, input, botConfig }) {
  const raw = String(input || '').trim();
  const isGiveawaySlashCommand = /^\/giveaway(?:\s|$)/i.test(raw);
  const prefix = isGiveawaySlashCommand ? '/' : (botConfig?.botPrefix || '/').toString();
  if (!raw.startsWith(prefix)) return false;
  const cmdToken = raw.split(/\s+/)[0].toLowerCase();
  const cmd = cmdToken.slice(prefix.length);
  const perms = await getServerActorPerms(serverId, actorUserId);
  if (!perms) return true;

  const targetFromMention = raw.match(/<@user:([a-f0-9-]+)>/i)?.[1] || null;
  const serverMeta = await pool.query('SELECT owner_id, mod_log_channel_id FROM servers WHERE id=$1', [serverId]);
  const ownerId = serverMeta.rows[0]?.owner_id;
  const modLogChannelId = serverMeta.rows[0]?.mod_log_channel_id || null;

  if (cmd === 'help') {
    await emitBotChannelMessage({
      serverId,
      channelId,
      botName: botConfig?.botName,
      content: [
        `**${NEXUS_BOT_NAME} and ${NEXTBOT_NAME} Commands**`,
        `\`${prefix}help\` \`${prefix}serverstats\` \`${prefix}poll question | option1 | option2 ...\``,
        `\`${prefix}warn @user reason\` \`${prefix}mute @user 10m reason\` \`${prefix}unmute @user\``,
        `\`${prefix}kick @user reason\` \`${prefix}ban @user reason\` \`${prefix}unban @user\``,
        `\`${prefix}setmodlog\` (sets current channel as moderation log)`,
        `\`${prefix}modlog 10\` (show recent moderation actions)`,
        '`/giveaway` (admins: open a NextBOT giveaway creator)',
        `\`${prefix}botconfig show|prefix|enabled|automod|links|caps|spam|words\``
      ].join('\n')
    });
    return true;
  }

  if (cmd === 'serverstats') {
    const [memberCount, channelCount, banCount] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM server_members WHERE server_id=$1', [serverId]),
      pool.query('SELECT COUNT(*) FROM channels WHERE server_id=$1', [serverId]),
      pool.query('SELECT COUNT(*) FROM server_bans WHERE server_id=$1', [serverId])
    ]);
    await emitBotChannelMessage({
      serverId,
      channelId,
      botName: botConfig?.botName,
      content: `**Server Stats**\nMembers: ${memberCount.rows[0].count}\nChannels: ${channelCount.rows[0].count}\nBanned users: ${banCount.rows[0].count}`
    });
    return true;
  }

  if (cmd === 'giveaway') {
    if (!perms.isAdmin) {
      socket.emit('channel_error', { channelId, error: 'Only server owners and admins can create giveaways.' });
      return true;
    }
    const payload = raw.replace(/^\/giveaway\b/i, '').trim();
    if (!payload) {
      socket.emit('giveaway_composer_open', { serverId, channelId });
      return true;
    }
    const parts = payload.split('|').map(part => part.trim()).filter(Boolean);
    if (parts.length < 2) {
      socket.emit('channel_error', { channelId, error: 'Use /giveaway to open the creator, or /giveaway Prize | 1h | 1.' });
      return true;
    }
    const prize = parts[0].slice(0, 160);
    const durationSeconds = parseDurationToSeconds(parts[1]);
    const winnerCount = Math.min(20, Math.max(1, parseInt(parts[2], 10) || 1));
    if (!prize || durationSeconds < 60 || durationSeconds > 60 * 60 * 24 * 30) {
      socket.emit('channel_error', { channelId, error: 'Giveaways must last from 1 minute to 30 days. Example: /giveaway Pro | 2h | 1' });
      return true;
    }
    const channel = await pool.query('SELECT channel_type FROM channels WHERE id=$1 AND server_id=$2', [channelId, serverId]);
    if (!channel.rows.length || (channel.rows[0].channel_type || 'text') !== 'text') {
      socket.emit('channel_error', { channelId, error: 'Giveaways can only be created in text channels.' });
      return true;
    }
    try {
      const giveaway = await createServerGiveaway({ serverId, channelId, createdBy: actorUserId, prize, durationSeconds, winnerCount });
      await logModerationAction({ serverId, channelId, action: 'giveaway_create', actorUserId, details: `${prize} | ${humanDuration(durationSeconds)} | ${winnerCount} winner(s)` });
      socket.emit('giveaway_created', giveaway);
    } catch (error) {
      console.error('Giveaway command creation failed:', error.message);
      socket.emit('channel_error', { channelId, error: 'Could not create the giveaway. Try again.' });
    }
    return true;
  }

  if (cmd === 'poll') {
    const pollPayload = raw.replace(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}poll\\s+`, 'i'), '');
    const parts = pollPayload.split('|').map(p => p.trim()).filter(Boolean);
    if (parts.length < 3) {
      socket.emit('channel_error', { channelId, error: `Usage: ${prefix}poll Question | Option 1 | Option 2` });
      return true;
    }
    const question = parts[0];
    const options = parts.slice(1, 7);
    const lines = options.map((opt, i) => `${i + 1}. ${opt}`);
    await emitBotChannelMessage({
      serverId,
      channelId,
      botName: botConfig?.botName,
      content: `**Poll by ${perms.actorName || actorDisplayName || 'member'}**\n${question}\n${lines.join('\n')}`
    });
    return true;
  }

  if (cmd === 'setmodlog') {
    if (!perms.isAdmin) {
      socket.emit('channel_error', { channelId, error: 'Admins only' });
      return true;
    }
    await pool.query('UPDATE servers SET mod_log_channel_id=$1 WHERE id=$2', [channelId, serverId]);
    await emitBotChannelMessage({ serverId, channelId, botName: botConfig?.botName, content: 'Moderation log channel set to this channel.' });
    await logModerationAction({ serverId, channelId, action: 'set_mod_log', actorUserId, details: `channel:${channelId}` });
    return true;
  }

  if (cmd === 'botconfig') {
    if (!perms.isAdmin) {
      socket.emit('channel_error', { channelId, error: 'Admins only' });
      return true;
    }
    const tokens = raw.split(/\s+/).slice(1);
    const action = (tokens[0] || 'show').toLowerCase();
    const value = tokens.slice(1).join(' ').trim();

    if (action === 'show') {
      await emitBotChannelMessage({
        serverId,
        channelId,
        botName: botConfig?.botName,
        content: [
          '**Bot Config**',
          `Name: ${NEXUS_BOT_NAME} (locked)`,
          `Prefix: ${prefix}`,
          `Enabled: ${botConfig?.botEnabled ? 'on' : 'off'}`,
          `Automod: ${botConfig?.botAutoMod ? 'on' : 'off'}`,
          `Block links: ${botConfig?.botBlockLinks ? 'on' : 'off'}`,
          `Caps threshold: ${botConfig?.botCapsThreshold || 90}%`,
          `Spam window: ${botConfig?.botSpamWindow || 6} msgs/6s`,
          `Blocked words: ${(botConfig?.blockedWords || []).length}`
        ].join('\n')
      });
      return true;
    }

    if (action === 'name') {
      await emitBotChannelMessage({ serverId, channelId, botName: NEXUS_BOT_NAME, content: `Bot name is locked to ${NEXUS_BOT_NAME}.` });
      return true;
    }

    if (action === 'prefix') {
      const nextPrefix = (value || '/').trim().slice(0, 2);
      if (!nextPrefix) {
        socket.emit('channel_error', { channelId, error: `Usage: ${prefix}botconfig prefix !` });
        return true;
      }
      await pool.query('UPDATE servers SET bot_prefix=$1 WHERE id=$2', [nextPrefix, serverId]);
      await logModerationAction({ serverId, channelId, action: 'bot_config_prefix', actorUserId, details: nextPrefix });
      await emitBotChannelMessage({ serverId, channelId, botName: botConfig?.botName, content: `Bot prefix updated to ${nextPrefix}` });
      return true;
    }

    if (['enabled', 'automod', 'links'].includes(action)) {
      const on = ['on', 'true', '1', 'yes'].includes((tokens[1] || '').toLowerCase());
      const off = ['off', 'false', '0', 'no'].includes((tokens[1] || '').toLowerCase());
      if (!on && !off) {
        socket.emit('channel_error', { channelId, error: `Usage: ${prefix}botconfig ${action} on|off` });
        return true;
      }
      if (action === 'enabled') await pool.query('UPDATE servers SET bot_enabled=$1 WHERE id=$2', [on, serverId]);
      if (action === 'automod') await pool.query('UPDATE servers SET bot_auto_mod=$1 WHERE id=$2', [on, serverId]);
      if (action === 'links') await pool.query('UPDATE servers SET bot_block_links=$1 WHERE id=$2', [on, serverId]);
      await logModerationAction({ serverId, channelId, action: `bot_config_${action}`, actorUserId, details: on ? 'on' : 'off' });
      await emitBotChannelMessage({ serverId, channelId, botName: botConfig?.botName, content: `${action} is now ${on ? 'on' : 'off'}.` });
      return true;
    }

    if (action === 'caps') {
      const pct = parseInt(tokens[1], 10);
      if (!pct || pct < 50 || pct > 100) {
        socket.emit('channel_error', { channelId, error: `Usage: ${prefix}botconfig caps 50-100` });
        return true;
      }
      await pool.query('UPDATE servers SET bot_caps_threshold=$1 WHERE id=$2', [pct, serverId]);
      await logModerationAction({ serverId, channelId, action: 'bot_config_caps', actorUserId, details: String(pct) });
      await emitBotChannelMessage({ serverId, channelId, botName: botConfig?.botName, content: `Caps threshold set to ${pct}%` });
      return true;
    }

    if (action === 'spam') {
      const count = parseInt(tokens[1], 10);
      if (!count || count < 3 || count > 20) {
        socket.emit('channel_error', { channelId, error: `Usage: ${prefix}botconfig spam 3-20` });
        return true;
      }
      await pool.query('UPDATE servers SET bot_spam_window=$1 WHERE id=$2', [count, serverId]);
      await logModerationAction({ serverId, channelId, action: 'bot_config_spam', actorUserId, details: String(count) });
      await emitBotChannelMessage({ serverId, channelId, botName: botConfig?.botName, content: `Spam threshold set to ${count} messages/6s` });
      return true;
    }

    if (action === 'words') {
      const sub = (tokens[1] || '').toLowerCase();
      const word = (tokens[2] || '').trim().toLowerCase();
      if (sub === 'list') {
        const words = botConfig?.blockedWords || [];
        await emitBotChannelMessage({
          serverId,
          channelId,
          botName: NEXUS_BOT_NAME,
          content: words.length
            ? `**Blocked words**\n${words.map(w => `- ${w}`).join('\n')}`
            : 'No blocked words configured.'
        });
        return true;
      }
      if (sub === 'clear') {
        await pool.query('DELETE FROM server_blocked_words WHERE server_id=$1', [serverId]);
        await logModerationAction({ serverId, channelId, action: 'bot_config_words_clear', actorUserId });
        await emitBotChannelMessage({ serverId, channelId, botName: NEXUS_BOT_NAME, content: 'Blocked words list cleared.' });
        return true;
      }
      if ((sub === 'add' || sub === 'remove') && (!word || word.length < 2 || word.length > 40)) {
        socket.emit('channel_error', { channelId, error: `Usage: ${prefix}botconfig words add|remove <word>` });
        return true;
      }
      if (sub === 'add') {
        await pool.query(
          `INSERT INTO server_blocked_words (id, server_id, word, created_by)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (server_id, word) DO NOTHING`,
          [uuidv4(), serverId, word, actorUserId]
        );
        await logModerationAction({ serverId, channelId, action: 'bot_config_words_add', actorUserId, details: word });
        await emitBotChannelMessage({ serverId, channelId, botName: NEXUS_BOT_NAME, content: `Added blocked word: ${word}` });
        return true;
      }
      if (sub === 'remove') {
        await pool.query('DELETE FROM server_blocked_words WHERE server_id=$1 AND word=$2', [serverId, word]);
        await logModerationAction({ serverId, channelId, action: 'bot_config_words_remove', actorUserId, details: word });
        await emitBotChannelMessage({ serverId, channelId, botName: NEXUS_BOT_NAME, content: `Removed blocked word: ${word}` });
        return true;
      }
      socket.emit('channel_error', { channelId, error: `Usage: ${prefix}botconfig words add|remove|list|clear` });
      return true;
    }

    socket.emit('channel_error', { channelId, error: `Usage: ${prefix}botconfig show|prefix|enabled|automod|links|caps|spam|words` });
    return true;
  }

  if (cmd === 'modlog') {
    if (!perms.canModerate) {
      socket.emit('channel_error', { channelId, error: 'Moderators only' });
      return true;
    }
    const n = Math.min(20, Math.max(1, parseInt(raw.split(/\s+/)[1], 10) || 8));
    const r = await pool.query(
      `SELECT ml.action, ml.details, ml.created_at,
              au.display_name as actor_display, au.username as actor_username,
              tu.display_name as target_display, tu.username as target_username
       FROM moderation_logs ml
       LEFT JOIN users au ON au.id=ml.actor_user_id
       LEFT JOIN users tu ON tu.id=ml.target_user_id
       WHERE ml.server_id=$1
       ORDER BY ml.created_at DESC
       LIMIT $2`,
      [serverId, n]
    );
    if (!r.rows.length) {
      await emitBotChannelMessage({ serverId, channelId, botName: botConfig?.botName, content: 'No moderation logs yet.' });
      return true;
    }
    const lines = r.rows.map(l => {
      const actor = l.actor_display || l.actor_username || 'unknown';
      const target = l.target_display || l.target_username ? ` -> ${l.target_display || l.target_username}` : '';
      const details = l.details ? ` (${l.details})` : '';
      return `- ${l.action}${target} by ${actor}${details}`;
    });
    await emitBotChannelMessage({ serverId, channelId, botName: botConfig?.botName, content: `**Recent Mod Actions**\n${lines.join('\n')}` });
    return true;
  }

  if (['warn', 'mute', 'unmute', 'kick', 'ban', 'unban'].includes(cmd) && !perms.canModerate) {
    socket.emit('channel_error', { channelId, error: 'Moderators only' });
    return true;
  }

  if (['warn', 'mute', 'unmute', 'kick', 'ban', 'unban'].includes(cmd) && !targetFromMention) {
    socket.emit('channel_error', { channelId, error: 'Mention a user like <@user:...>' });
    return true;
  }

  if (targetFromMention && targetFromMention === ownerId && !perms.isOwner) {
    socket.emit('channel_error', { channelId, error: 'Only the owner can moderate the owner.' });
    return true;
  }

  if (cmd === 'warn') {
    const reason = raw.replace(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}warn\\s+<@user:[a-f0-9-]+>\\s*`, 'i'), '').trim() || 'No reason provided';
    await logModerationAction({ serverId, channelId, action: 'warn', actorUserId, targetUserId: targetFromMention, details: reason });
    await emitBotChannelMessage({ serverId, channelId, botName: botConfig?.botName, content: `Warned <@user:${targetFromMention}>. Reason: ${reason}` });
    await sendBotDirectMessage({
      toUserId: targetFromMention,
      content: `[${NEXUS_BOT_NAME}] You were warned in server ${serverId}. Reason: ${reason}`
    });
    if (modLogChannelId && modLogChannelId !== channelId) {
      await emitBotChannelMessage({ serverId, channelId: modLogChannelId, botName: botConfig?.botName, content: `[MOD LOG] ${perms.actorName} warned <@user:${targetFromMention}> (${reason})` });
    }
    return true;
  }

  if (cmd === 'mute') {
    const durationRaw = raw.match(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}mute\\s+<@user:[a-f0-9-]+>\\s+(\\S+)`, 'i'))?.[1];
    const durationSeconds = parseDurationToSeconds(durationRaw);
    if (!durationSeconds) {
      socket.emit('channel_error', { channelId, error: `Usage: ${prefix}mute <@user:id> 10m optional reason` });
      return true;
    }
    const reason = raw.replace(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}mute\\s+<@user:[a-f0-9-]+>\\s+\\S+\\s*`, 'i'), '').trim() || 'No reason provided';
    const mutedUntil = Math.floor(Date.now() / 1000) + durationSeconds;
    await pool.query(
      `INSERT INTO server_mutes (id, server_id, user_id, muted_by, reason, muted_until)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (server_id, user_id) DO UPDATE SET muted_by=$4, reason=$5, muted_until=$6`,
      [uuidv4(), serverId, targetFromMention, actorUserId, reason, mutedUntil]
    );
    await logModerationAction({ serverId, channelId, action: 'mute', actorUserId, targetUserId: targetFromMention, details: `${humanDuration(durationSeconds)} | ${reason}` });
    await emitBotChannelMessage({ serverId, channelId, botName: botConfig?.botName, content: `Muted <@user:${targetFromMention}> for ${humanDuration(durationSeconds)}. Reason: ${reason}` });
    await sendBotDirectMessage({
      toUserId: targetFromMention,
      content: `[${NEXUS_BOT_NAME}] You were muted in server ${serverId} for ${humanDuration(durationSeconds)}. Reason: ${reason}`
    });
    if (modLogChannelId && modLogChannelId !== channelId) {
      await emitBotChannelMessage({ serverId, channelId: modLogChannelId, botName: botConfig?.botName, content: `[MOD LOG] ${perms.actorName} muted <@user:${targetFromMention}> for ${humanDuration(durationSeconds)} (${reason})` });
    }
    return true;
  }

  if (cmd === 'unmute') {
    await pool.query('DELETE FROM server_mutes WHERE server_id=$1 AND user_id=$2', [serverId, targetFromMention]);
    await logModerationAction({ serverId, channelId, action: 'unmute', actorUserId, targetUserId: targetFromMention });
    await emitBotChannelMessage({ serverId, channelId, botName: botConfig?.botName, content: `Unmuted <@user:${targetFromMention}>.` });
    await sendBotDirectMessage({
      toUserId: targetFromMention,
      content: `[${NEXUS_BOT_NAME}] You were unmuted in server ${serverId}.`
    });
    if (modLogChannelId && modLogChannelId !== channelId) {
      await emitBotChannelMessage({ serverId, channelId: modLogChannelId, botName: botConfig?.botName, content: `[MOD LOG] ${perms.actorName} unmuted <@user:${targetFromMention}>` });
    }
    return true;
  }

  if (cmd === 'kick') {
    if (targetFromMention === actorUserId) {
      socket.emit('channel_error', { channelId, error: 'You cannot kick yourself.' });
      return true;
    }
    const reason = raw.replace(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}kick\\s+<@user:[a-f0-9-]+>\\s*`, 'i'), '').trim() || 'No reason provided';
    await pool.query('DELETE FROM server_members WHERE server_id=$1 AND user_id=$2', [serverId, targetFromMention]);
    io.to(`user:${targetFromMention}`).emit('kicked_from_server', { serverId });
    await logModerationAction({ serverId, channelId, action: 'kick', actorUserId, targetUserId: targetFromMention, details: reason });
    await emitBotChannelMessage({ serverId, channelId, botName: botConfig?.botName, content: `Kicked <@user:${targetFromMention}>. Reason: ${reason}` });
    await sendBotDirectMessage({
      toUserId: targetFromMention,
      content: `[${NEXUS_BOT_NAME}] You were kicked from server ${serverId}. Reason: ${reason}`
    });
    if (modLogChannelId && modLogChannelId !== channelId) {
      await emitBotChannelMessage({ serverId, channelId: modLogChannelId, botName: botConfig?.botName, content: `[MOD LOG] ${perms.actorName} kicked <@user:${targetFromMention}> (${reason})` });
    }
    return true;
  }

  if (cmd === 'ban') {
    if (targetFromMention === actorUserId) {
      socket.emit('channel_error', { channelId, error: 'You cannot ban yourself.' });
      return true;
    }
    const reason = raw.replace(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}ban\\s+<@user:[a-f0-9-]+>\\s*`, 'i'), '').trim() || 'No reason provided';
    await pool.query('DELETE FROM server_members WHERE server_id=$1 AND user_id=$2', [serverId, targetFromMention]);
    await pool.query(
      `INSERT INTO server_bans (id, server_id, user_id, banned_by, reason)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (server_id, user_id) DO UPDATE SET banned_by=$4, reason=$5`,
      [uuidv4(), serverId, targetFromMention, actorUserId, reason]
    );
    io.to(`user:${targetFromMention}`).emit('banned_from_server', { serverId });
    await logModerationAction({ serverId, channelId, action: 'ban', actorUserId, targetUserId: targetFromMention, details: reason });
    await emitBotChannelMessage({ serverId, channelId, botName: botConfig?.botName, content: `Banned <@user:${targetFromMention}>. Reason: ${reason}` });
    await sendBotDirectMessage({
      toUserId: targetFromMention,
      content: `[${NEXUS_BOT_NAME}] You were banned from server ${serverId}. Reason: ${reason}`
    });
    if (modLogChannelId && modLogChannelId !== channelId) {
      await emitBotChannelMessage({ serverId, channelId: modLogChannelId, botName: botConfig?.botName, content: `[MOD LOG] ${perms.actorName} banned <@user:${targetFromMention}> (${reason})` });
    }
    return true;
  }

  if (cmd === 'unban') {
    await pool.query('DELETE FROM server_bans WHERE server_id=$1 AND user_id=$2', [serverId, targetFromMention]);
    await logModerationAction({ serverId, channelId, action: 'unban', actorUserId, targetUserId: targetFromMention });
    await emitBotChannelMessage({ serverId, channelId, botName: botConfig?.botName, content: `Unbanned <@user:${targetFromMention}>.` });
    await sendBotDirectMessage({
      toUserId: targetFromMention,
      content: `[${NEXUS_BOT_NAME}] You were unbanned in server ${serverId}.`
    });
    if (modLogChannelId && modLogChannelId !== channelId) {
      await emitBotChannelMessage({ serverId, channelId: modLogChannelId, botName: botConfig?.botName, content: `[MOD LOG] ${perms.actorName} unbanned <@user:${targetFromMention}>` });
    }
    return true;
  }

  socket.emit('channel_error', { channelId, error: `Unknown command. Try ${prefix}help` });
  return true;
}

io.on('connection', (socket) => {
  const userId = socket.userId;
  socket.use(async ([event], next) => {
    const rateLimits = {
      send_message: [8, 5000],
      send_channel_message: [8, 5000],
      typing_start: [12, 5000],
      typing_stop: [12, 5000],
      channel_typing_start: [12, 5000],
      channel_typing_stop: [12, 5000],
      call_invite: [6, 30000],
      join_server_room: [12, 10000],
      join_channel_room: [16, 10000],
      toggle_channel_reaction: [20, 5000],
      channel_message_deleted: [6, 5000],
      join_group_call: [8, 30000],
      call_game_open: [6, 30000],
      call_game_join: [8, 30000],
      call_game_action: [20, 5000]
    };
    const limit = rateLimits[event];
    if (limit && !takeSocketRateToken(userId, event, limit[0], limit[1])) {
      return next(new Error('RATE_LIMITED'));
    }
    if (socket.data.activityOnly) {
      if (!ACTIVITY_ONLY_EVENTS.has(event)) return next(new Error('FORBIDDEN_EVENT'));
      return next();
    }
    if (event === 'tos_accepted') return next();
    try {
      const policy = await getCurrentTos();
      if ((parseInt(socket.data.tosAcceptedVersion, 10) || 0) < policy.version) {
        return next(new Error('TOS_REQUIRED'));
      }
      next();
    } catch (error) {
      next(new Error('TOS_UNAVAILABLE'));
    }
  });
  socket.on('tos_accepted', async ({ version } = {}) => {
    const state = await getUserTosState(userId);
    if (!state.required && parseInt(version, 10) === state.policy.version) {
      socket.data.tosAcceptedVersion = state.acceptedVersion;
      socket.emit('tos_acceptance_confirmed', { version: state.acceptedVersion });
    }
  });
  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId).add(socket.id);

  pool.query("UPDATE users SET status='online' WHERE id=$1", [userId])
    .then(() => broadcastStatusChange(userId, 'online'));

  socket.join(`user:${userId}`);

  socket.on('send_message', async ({ toId, content }) => {
    if (!toId || !content || typeof content !== 'string') return;
    let trimmed;
    try {
      trimmed = safeMessageContent(content, { field: 'Message' });
    } catch (error) {
      socket.emit('message_error', { error: error.message });
      return;
    }
    const globalMute = await getGlobalMuteState(userId);
    if (globalMute) {
      socket.emit('message_error', { error: `You are globally muted for ${humanDuration(globalMute.mutedUntil - Math.floor(Date.now() / 1000))} more.` });
      return;
    }
    const safetyViolation = await enforceGlobalSafety({
      userId,
      content: trimmed,
      messageType: 'dm'
    });
    if (safetyViolation) {
      socket.emit('message_error', { error: 'Message blocked by NexusGuard global safety policy. The attempt was automatically reported.' });
      return;
    }
    // Single query: check friendship AND get sender info at once
    const check = await pool.query(
      `SELECT u.username, u.display_name, (u.avatar_data IS NOT NULL) AS has_avatar, u.active_decoration, u.active_nameplate, u.active_color, u.active_font, u.pro_expires_at, u.profile_gradient_start, u.profile_gradient_end, u.profile_name_effect, ats.id AS tag_server_id, ats.name AS tag_server_name, ats.invite_code AS tag_invite_code, ats.server_tag, ats.tag_background, ats.tag_private,
        (SELECT id FROM friendships WHERE (user1_id=$1 AND user2_id=$2) OR (user1_id=$2 AND user2_id=$1) LIMIT 1) as friend_id
       FROM users u LEFT JOIN servers ats ON ats.id=u.active_server_tag_id WHERE u.id=$1`,
      [userId, toId]
    );
    if (!check.rows.length || !check.rows[0].friend_id) return;
    const s = check.rows[0];
    const msgId = uuidv4();
    const now = Math.floor(Date.now() / 1000);
    const mentions = await resolveDirectMentions(trimmed, [userId, toId]);
    // Build message object immediately — emit to sender first for instant feedback
    const msg = {
      id: msgId, fromId: userId, toId, content: trimmed, createdAt: now,
      mentions,
      author: {
        username: s.username, displayName: s.display_name,
        avatarDataUrl: avatarUrl(userId, !!s.has_avatar),
        activeDecoration: s.active_decoration || null,
        activeNameplate: s.active_nameplate || null,
        activeColor: s.active_color || null,
        activeFont: s.active_font || null, proActive: (s.pro_expires_at || 0) > Math.floor(Date.now() / 1000), proGradientStart: s.profile_gradient_start, proGradientEnd: s.profile_gradient_end, proNameEffect: s.profile_name_effect,
        activeServerTag: s.server_tag || null, activeServerTagBackground: s.tag_background || '#5865f2', activeServerTagServerId: s.tag_server_id || null, activeServerTagServerName: s.tag_private ? null : (s.tag_server_name || null), activeServerTagInviteCode: s.tag_private ? null : (s.tag_invite_code || null), activeServerTagPrivate: !!s.tag_private
      }
    };
    // Emit to sender immediately (no await before this)
    socket.emit('new_message', msg);
    // Emit to recipient
    io.to(`user:${toId}`).emit('new_message', msg);
    if (trimmed.includes(`<@user:${toId}>`)) {
      io.to(`user:${toId}`).emit('mentioned', {
        type: 'dm',
        fromUser: { displayName: s.display_name, username: s.username },
        preview: trimmed.replace(/<@user:[a-f0-9-]+>/g, '@...').slice(0, 80)
      });
    }
    // Emit to sender's other tabs
    socket.to(`user:${userId}`).emit('new_message', msg);
    // Persist to DB (non-blocking for perceived speed)
    pool.query('INSERT INTO messages (id, from_id, to_id, content, created_at) VALUES ($1,$2,$3,$4,$5)',
      [msgId, userId, toId, trimmed, now]).catch(e => console.error('DM insert error:', e));
    relayNexusDirectMessage({
      nexusRecipientId: toId,
      nexusMessageId: msgId,
      sender: {
        id: userId,
        username: s.username,
        displayName: s.display_name,
        avatarDataUrl: avatarUrl(userId, !!s.has_avatar),
        activeServerTag: s.server_tag || null
      },
      content: trimmed
    }).catch(error => console.error('Nexus LINK DM relay error:', error));

    // Achievement tracking — message count & DM
    trackAchievement(userId, ['messages_sent', 'dms_sent']);
  });

  socket.on('typing_start', async ({ toId } = {}) => {
    const friendship = await pool.query(
      'SELECT 1 FROM friendships WHERE (user1_id=$1 AND user2_id=$2) OR (user1_id=$2 AND user2_id=$1) LIMIT 1',
      [userId, String(toId || '')]
    );
    if (!friendship.rows.length) return;
    const u = await pool.query('SELECT username FROM users WHERE id=$1', [userId]);
    io.to(`user:${toId}`).emit('user_typing', { fromId: userId, username: u.rows[0]?.username });
  });

  socket.on('typing_stop', async ({ toId } = {}) => {
    const friendship = await pool.query(
      'SELECT 1 FROM friendships WHERE (user1_id=$1 AND user2_id=$2) OR (user1_id=$2 AND user2_id=$1) LIMIT 1',
      [userId, String(toId || '')]
    );
    if (!friendship.rows.length) return;
    io.to(`user:${toId}`).emit('user_stop_typing', { fromId: userId });
  });

  socket.on('join_server_room', async ({ serverId } = {}) => {
    const normalizedServerId = String(serverId || '');
    if (!normalizedServerId) return;
    const membership = await pool.query(
      'SELECT 1 FROM server_members WHERE server_id=$1 AND user_id=$2 LIMIT 1',
      [normalizedServerId, userId]
    );
    if (!membership.rows.length) {
      socket.emit('channel_error', { error: 'You are not a member of that server.' });
      return;
    }
    socket.data.activeServerId = normalizedServerId;
    leaveChannelRooms(socket);
  });

  socket.on('join_channel_room', async ({ serverId, channelId } = {}) => {
    const normalizedServerId = String(serverId || '');
    const normalizedChannelId = String(channelId || '');
    if (!normalizedServerId || !normalizedChannelId) return;
    const channel = await getChannelAccess(pool, normalizedServerId, normalizedChannelId, userId);
    if (!channel) {
      socket.emit('channel_error', { channelId: normalizedChannelId, error: 'You cannot view that channel.' });
      return;
    }
    socket.data.activeServerId = normalizedServerId;
    leaveChannelRooms(socket);
    socket.join(channelRoomId(normalizedServerId, normalizedChannelId));
  });

  socket.on('create_giveaway', async ({ serverId, channelId, prize, description, duration, winnerCount }, ack = () => {}) => {
    try {
      const perms = await getServerActorPerms(serverId, userId);
      if (!perms?.isAdmin) throw new Error('Only server owners and admins can create giveaways.');
      const safePrize = String(prize || '').trim().slice(0, 160);
      const safeDescription = String(description || '').trim().slice(0, 400);
      const durationSeconds = parseDurationToSeconds(duration);
      const safeWinnerCount = Math.min(20, Math.max(1, parseInt(winnerCount, 10) || 1));
      if (!safePrize) throw new Error('Giveaway prize is required.');
      if (durationSeconds < 60 || durationSeconds > 60 * 60 * 24 * 30) throw new Error('Choose a duration from 1 minute to 30 days.');
      const channel = await pool.query('SELECT channel_type FROM channels WHERE id=$1 AND server_id=$2', [channelId, serverId]);
      if (!channel.rows.length || (channel.rows[0].channel_type || 'text') !== 'text') throw new Error('Giveaways can only be created in text channels.');
      await ensureNextBotExists();
      const giveaway = await createServerGiveaway({
        serverId,
        channelId,
        createdBy: userId,
        prize: safePrize,
        description: safeDescription,
        durationSeconds,
        winnerCount: safeWinnerCount
      });
      await logModerationAction({ serverId, channelId, action: 'giveaway_create', actorUserId: userId, details: `${safePrize} | ${humanDuration(durationSeconds)} | ${safeWinnerCount} winner(s)` });
      ack({ giveaway });
    } catch (error) {
      ack({ error: error.message || 'Could not create the giveaway.' });
    }
  });

  socket.on('toggle_giveaway_entry', async ({ giveawayId }, ack = () => {}) => {
    const client = await pool.connect();
    let expiredGiveawayId = null;
    try {
      await client.query('BEGIN');
      const member = await client.query(
        `SELECT g.id, g.server_id, g.ends_at, g.status
         FROM server_giveaways g
         JOIN server_members sm ON sm.server_id=g.server_id AND sm.user_id=$2
         WHERE g.id=$1
         FOR UPDATE OF g`,
        [String(giveawayId || ''), userId]
      );
      const giveaway = member.rows[0];
      if (!giveaway) throw new Error('Giveaway not found or unavailable.');
      if (giveaway.status !== 'active') throw new Error('This giveaway has already ended.');
      if (Number(giveaway.ends_at) <= Math.floor(Date.now() / 1000)) {
        expiredGiveawayId = giveaway.id;
        await client.query('ROLLBACK');
        throw new Error('This giveaway just ended.');
      }
      const existing = await client.query(
        'SELECT 1 FROM server_giveaway_entries WHERE giveaway_id=$1 AND user_id=$2',
        [giveaway.id, userId]
      );
      const entered = !existing.rows.length;
      if (entered) {
        await client.query('INSERT INTO server_giveaway_entries (giveaway_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [giveaway.id, userId]);
      } else {
        await client.query('DELETE FROM server_giveaway_entries WHERE giveaway_id=$1 AND user_id=$2', [giveaway.id, userId]);
      }
      await client.query('COMMIT');
      const ownView = await getGiveawaySnapshot(giveaway.id, userId);
      const sharedView = await getGiveawaySnapshot(giveaway.id);
      delete sharedView.entered;
      emitToChannel(giveaway.server_id, giveaway.channel_id, 'giveaway_updated', sharedView);
      io.to(`user:${userId}`).emit('giveaway_updated', ownView);
      ack({ giveaway: ownView, entered });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      if (expiredGiveawayId) {
        try { await completeServerGiveaway(expiredGiveawayId); } catch (finishError) { console.error('Late giveaway completion failed:', finishError.message); }
      }
      ack({ error: error.message || 'Could not update giveaway entry.' });
    } finally {
      client.release();
    }
  });

  socket.on('end_giveaway', async ({ giveawayId }, ack = () => {}) => {
    try {
      const giveaway = await pool.query('SELECT server_id, channel_id, prize FROM server_giveaways WHERE id=$1', [String(giveawayId || '')]);
      const row = giveaway.rows[0];
      if (!row) throw new Error('Giveaway not found.');
      const perms = await getServerActorPerms(row.server_id, userId);
      if (!perms?.isAdmin) throw new Error('Only server owners and admins can end giveaways.');
      const completed = await completeServerGiveaway(String(giveawayId || ''), true);
      if (!completed) throw new Error('This giveaway has already ended.');
      await logModerationAction({ serverId: row.server_id, channelId: row.channel_id, action: 'giveaway_end', actorUserId: userId, details: row.prize });
      ack({ giveaway: completed });
    } catch (error) {
      ack({ error: error.message || 'Could not end the giveaway.' });
    }
  });

  socket.on('send_channel_message', async ({ serverId, channelId, content, replyToMessageId }) => {
    if (!content || typeof content !== 'string') return;
    let trimmed;
    try {
      trimmed = safeMessageContent(content, { field: 'Message' });
    } catch (error) {
      socket.emit('channel_error', { channelId, error: error.message });
      return;
    }
    const normalizedReplyId = typeof replyToMessageId === 'string' && replyToMessageId.trim() ? replyToMessageId.trim() : null;
    const channelAccess = await getChannelAccess(pool, serverId, channelId, userId);
    if (!channelAccess) {
      socket.emit('channel_error', { channelId, error: 'You cannot view or post in that channel.' });
      return;
    }
    const globalMute = await getGlobalMuteState(userId);
    if (globalMute) {
      socket.emit('channel_error', {
        channelId,
        error: `You are globally muted for ${humanDuration(globalMute.mutedUntil - Math.floor(Date.now() / 1000))} more.`
      });
      return;
    }

    const safetyViolation = await enforceGlobalSafety({
      userId,
      content: trimmed,
      messageType: 'channel',
      serverId,
      channelId
    });
    if (safetyViolation) {
      socket.emit('channel_error', {
        channelId,
        error: 'Message blocked by NexusGuard global safety policy. The attempt was automatically reported.'
      });
      return;
    }

    const botConfig = await getServerBotConfig(serverId);

    if (trimmed.startsWith(botConfig.botPrefix || '/') || /^\/giveaway(?:\s|$)/i.test(trimmed)) {
      const handled = await runChannelCommand({
        socket,
        serverId,
        channelId,
        actorUserId: userId,
        actorDisplayName: null,
        input: trimmed,
        botConfig
      });
      if (handled) return;
    }

    // Single query: get member info, role info, channel validity, and permission check
    const check = await pool.query(
      `SELECT sm.role_id, sm.role AS member_role, sr.name as role_name, sr.color as role_color, sr.gradient_start as role_gradient_start, sr.gradient_end as role_gradient_end,
        sr.is_admin, sr.can_delete_messages,
        EXISTS(
          SELECT 1 FROM server_member_roles smr2 JOIN server_roles sr2 ON sr2.id=smr2.role_id
          WHERE smr2.server_id=sm.server_id AND smr2.user_id=sm.user_id AND sr2.can_mention_everyone=TRUE
        ) AS can_mention_everyone,
        u.username, u.display_name, (u.avatar_data IS NOT NULL) AS has_avatar, u.active_decoration, u.active_nameplate, u.active_color, u.active_font, u.pro_expires_at, u.profile_gradient_start, u.profile_gradient_end, u.profile_name_effect, ats.id AS tag_server_id, ats.name AS tag_server_name, ats.invite_code AS tag_invite_code, ats.server_tag, ats.tag_background, ats.tag_private,
        ch.id as ch_id, ch.locked, ch.private as ch_private, ch.slowmode_seconds, ch.channel_type,
        (SELECT allow_send FROM channel_permissions cp
         WHERE cp.channel_id=$2 AND (cp.role_id=sm.role_id OR cp.role_id IS NULL)
         ORDER BY cp.role_id NULLS LAST LIMIT 1) as perm_allow
       FROM server_members sm
       JOIN users u ON u.id=sm.user_id
       JOIN channels ch ON ch.id=$2 AND ch.server_id=$1
       LEFT JOIN server_roles sr ON sr.id=sm.role_id
       LEFT JOIN servers ats ON ats.id=u.active_server_tag_id
       WHERE sm.server_id=$1 AND sm.user_id=$3`,
      [serverId, channelId, userId]
    );
    if (!check.rows.length) return; // not a member or channel doesn't belong to server
    const row = check.rows[0];

    if ((trimmed.includes('<@everyone>') || trimmed.includes('<@here>')) &&
        row.member_role !== 'admin' && !row.is_admin && !row.can_mention_everyone) {
      socket.emit('channel_error', { channelId, error: 'You do not have permission to mention everyone' });
      return;
    }

    if ((row.channel_type || 'text') === 'voice') {
      socket.emit('channel_error', { channelId, error: 'This is a voice channel. Join voice to communicate here.' });
      return;
    }

    // Check send permission (already fetched in initial query as perm_allow)
    if (row.locked && !row.is_admin && row.member_role !== 'admin' && !row.perm_allow) {
      socket.emit('channel_error', { channelId, error: 'You do not have permission to send messages in this channel' });
      return;
    }

    const slowmodeSeconds = Math.max(0, parseInt(row.slowmode_seconds, 10) || 0);
    const bypassSlowmode = row.is_admin || row.member_role === 'admin';
    if (slowmodeSeconds > 0 && !bypassSlowmode) {
      const lastMsg = await pool.query(
        `SELECT created_at FROM channel_messages
         WHERE channel_id=$1 AND from_id=$2
         ORDER BY created_at DESC
         LIMIT 1`,
        [channelId, userId]
      );
      if (lastMsg.rows.length) {
        const nowSec = Math.floor(Date.now() / 1000);
        const elapsed = nowSec - parseInt(lastMsg.rows[0].created_at, 10);
        if (elapsed < slowmodeSeconds) {
          socket.emit('channel_error', {
            channelId,
            error: `Slowmode is enabled. Wait ${slowmodeSeconds - elapsed}s before sending again.`
          });
          return;
        }
      }
    }

    const mute = await getMuteState(serverId, userId);
    if (mute) {
      const secondsLeft = Math.max(0, mute.mutedUntil - Math.floor(Date.now() / 1000));
      socket.emit('channel_error', {
        channelId,
        error: `You are muted in this server for ${humanDuration(secondsLeft)} more.`
      });
      return;
    }

    if (botConfig.botEnabled && botConfig.botAutoMod) {
      const blockedWord = findConfiguredViolation(trimmed, botConfig.blockedWords || []);
      if (blockedWord) {
        socket.emit('channel_error', { channelId, error: `Message blocked: contains blocked word "${blockedWord.term}".` });
        await sendBotDirectMessage({
          toUserId: userId,
          content: `[${NEXUS_BOT_NAME}] Your message in server ${serverId} was blocked for using a filtered word: ${blockedWord.term}`
        });
        return;
      }

      const linkHit = botConfig.botBlockLinks && /(https?:\/\/|www\.)/i.test(trimmed);
      if (linkHit) {
        socket.emit('channel_error', { channelId, error: 'Links are blocked by server automod.' });
        await emitBotChannelMessage({
          serverId,
          channelId,
          botName: botConfig.botName,
          content: `<@user:${userId}> message blocked: links are not allowed here.`
        });
        return;
      }

      const lettersOnly = trimmed.replace(/[^a-z]/gi, '');
      const upperOnly = trimmed.replace(/[^A-Z]/g, '');
      if (lettersOnly.length >= 12) {
        const capsPct = Math.round((upperOnly.length / lettersOnly.length) * 100);
        if (capsPct >= botConfig.botCapsThreshold) {
          socket.emit('channel_error', { channelId, error: `Message blocked: too much caps (${capsPct}%).` });
          return;
        }
      }

      const spamKey = `${serverId}:${userId}`;
      const nowMs = Date.now();
      const prev = spamTracker.get(spamKey) || [];
      const recent = prev.filter(ts => nowMs - ts < 6000);
      recent.push(nowMs);
      spamTracker.set(spamKey, recent);
      if (recent.length > botConfig.botSpamWindow) {
        socket.emit('channel_error', { channelId, error: 'Slow down. Automod detected message spam.' });
        return;
      }
    }

    let replyTo = null;
    if (normalizedReplyId) {
      const replyRes = await pool.query(
        `SELECT cm.id, cm.from_id, cm.content, u.display_name, u.username
         FROM channel_messages cm
         JOIN users u ON u.id=cm.from_id
         WHERE cm.id=$1 AND cm.channel_id=$2`,
        [normalizedReplyId, channelId]
      );
      if (!replyRes.rows.length) {
        socket.emit('channel_error', { channelId, error: 'Reply target was not found in this channel.' });
        return;
      }
      const r = replyRes.rows[0];
      replyTo = {
        id: r.id,
        fromId: r.from_id,
        displayName: r.display_name || r.username,
        content: String(r.content || '').slice(0, 160)
      };
    }

    const msgId = uuidv4();
    const now = Math.floor(Date.now() / 1000);
    const mentions = await resolveChannelMentions(trimmed, serverId);
    const msg = {
      id: msgId, channelId, serverId, fromId: userId,
      content: trimmed, createdAt: now,
      isPinned: false,
      replyTo,
      mentions,
      author: {
        username: row.username, displayName: row.display_name,
        avatarDataUrl: avatarUrl(userId, !!row.has_avatar),
        roleColor: row.role_color || null, roleName: row.role_name || null, roleGradientStart: row.role_gradient_start || null, roleGradientEnd: row.role_gradient_end || null,
        activeDecoration: row.active_decoration || null,
        activeNameplate: row.active_nameplate || null,
        activeColor: row.active_color || null,
        activeFont: row.active_font || null, proActive: (row.pro_expires_at || 0) > Math.floor(Date.now() / 1000), proGradientStart: row.profile_gradient_start, proGradientEnd: row.profile_gradient_end, proNameEffect: row.profile_name_effect,
        activeServerTag: row.server_tag || null, activeServerTagBackground: row.tag_background || '#5865f2', activeServerTagServerId: row.tag_server_id || null, activeServerTagServerName: row.tag_private ? null : (row.tag_server_name || null), activeServerTagInviteCode: row.tag_private ? null : (row.tag_invite_code || null), activeServerTagPrivate: !!row.tag_private
      }
    };
    // Resolve mentions for notification
    const mentionedUserIds = await getChannelAccessibleUserIds(pool, serverId, channelId, Object.keys(mentions.users || {}));
    const roleMentionMatches = [...trimmed.matchAll(/<@role:([a-f0-9-]+)>/g)];
    const specialMentionMatches = [...new Set([...trimmed.matchAll(/<@(everyone|here)>/g)].map(m => m[1]))];

    // Notify mentioned users
    mentionedUserIds.forEach(mentionedId => {
      if (mentionedId !== userId) {
        io.to(`user:${mentionedId}`).emit('mentioned', {
          type: 'channel', serverId, channelId,
          fromUser: { displayName: row.display_name, username: row.username },
          preview: trimmed.replace(/<@(user|role):[a-f0-9-]+>/g, '@...').slice(0, 80)
        });
      }
    });

    // Notify mentioned role members
    if (roleMentionMatches.length) {
      const roleIds = roleMentionMatches.map(m => m[1]);
      const roleMembers = await pool.query(
        `SELECT DISTINCT sm.user_id
         FROM server_members sm
         LEFT JOIN server_member_roles smr ON smr.server_id=sm.server_id AND smr.user_id=sm.user_id
         WHERE sm.server_id=$1 AND (sm.role_id = ANY($2) OR smr.role_id = ANY($2))`,
        [serverId, roleIds]
      );
      const visibleRoleMemberIds = await getChannelAccessibleUserIds(pool, serverId, channelId, roleMembers.rows.map(row => row.user_id));
      visibleRoleMemberIds.forEach(mentionedId => {
        if (mentionedId !== userId) {
          io.to(`user:${mentionedId}`).emit('mentioned', {
            type: 'channel', serverId, channelId,
            fromUser: { displayName: row.display_name, username: row.username },
            preview: trimmed.replace(/<@(user|role):[a-f0-9-]+>/g, '@...').slice(0, 80)
          });
        }
      });
    }

    if (specialMentionMatches.length) {
      socket.to(channelRoomId(serverId, channelId)).emit('mentioned', {
        type: 'channel', serverId, channelId,
        special: specialMentionMatches.includes('everyone') ? 'everyone' : 'here',
        fromUser: { displayName: row.display_name, username: row.username },
        preview: trimmed.replace(/<@(user|role):[a-f0-9-]+>/g, '@...').replace(/<@(everyone|here)>/g, '@$1').slice(0, 80)
      });
    }

    // Emit to the sender immediately, then sockets currently viewing this channel.
    socket.emit('new_channel_message', msg);
    socket.to(channelRoomId(serverId, channelId)).emit('new_channel_message', msg);
    // Persist non-blocking
    pool.query(
      'INSERT INTO channel_messages (id, channel_id, from_id, content, created_at, reply_to_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [msgId, channelId, userId, trimmed, now, normalizedReplyId]
    ).catch(e => console.error('Channel msg insert error:', e));
    relayNexusChannelMessage({
      serverId,
      channelId,
      nexusMessageId: msgId,
      sender: { id: userId, username: row.username, displayName: row.display_name, avatarDataUrl: avatarUrl(userId, !!row.has_avatar) },
      content: trimmed,
      replyTo
    }).catch(error => console.error('Nexus LINK channel relay error:', error));

    // Achievement tracking
    trackAchievement(userId, ['messages_sent', 'channel_msgs']);
  });

  socket.on('channel_typing_start', async ({ serverId, channelId } = {}) => {
    if (!await canAccessChannel(pool, serverId, channelId, userId)) return;
    pool.query('SELECT username FROM users WHERE id=$1', [userId]).then(r => {
      socket.to(channelRoomId(serverId, channelId)).emit('channel_user_typing', {
        channelId, userId, username: r.rows[0]?.username
      });
    });
  });

  socket.on('channel_typing_stop', async ({ serverId, channelId } = {}) => {
    if (!await canAccessChannel(pool, serverId, channelId, userId)) return;
    socket.to(channelRoomId(serverId, channelId)).emit('channel_user_stop_typing', { channelId, userId });
  });

  socket.on('channel_message_deleted', async ({ serverId, channelId, messageId } = {}) => {
    if (!await canAccessChannel(pool, serverId, channelId, userId)) return;
    const stillExists = await pool.query(
      `SELECT 1 FROM channel_messages cm
       JOIN channels ch ON ch.id=cm.channel_id
       WHERE cm.id=$1 AND cm.channel_id=$2 AND ch.server_id=$3 LIMIT 1`,
      [messageId, channelId, serverId]
    );
    if (stillExists.rows.length) return;
    emitToChannel(serverId, channelId, 'channel_message_deleted', { channelId, messageId });
  });

  socket.on('toggle_channel_reaction', async ({ serverId, channelId, messageId, emoji }) => {
    const normalizedEmoji = String(emoji || '').trim().slice(0, 16);
    if (!normalizedEmoji) return;
    if (!await canAccessChannel(pool, serverId, channelId, userId)) return;

    const msg = await pool.query(
      `SELECT cm.id
       FROM channel_messages cm
       JOIN channels ch ON ch.id=cm.channel_id
       WHERE cm.id=$1 AND cm.channel_id=$2 AND ch.server_id=$3`,
      [messageId, channelId, serverId]
    );
    if (!msg.rows.length) return;

    const existing = await pool.query(
      `SELECT id FROM channel_message_reactions
       WHERE message_id=$1 AND user_id=$2 AND emoji=$3
       LIMIT 1`,
      [messageId, userId, normalizedEmoji]
    );

    if (existing.rows.length) {
      await pool.query('DELETE FROM channel_message_reactions WHERE id=$1', [existing.rows[0].id]);
    } else {
      await pool.query(
        `INSERT INTO channel_message_reactions (id, message_id, user_id, emoji)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (message_id, user_id, emoji) DO NOTHING`,
        [uuidv4(), messageId, userId, normalizedEmoji]
      );
    }

    const agg = await pool.query(
      `SELECT emoji, COUNT(*)::int as count, BOOL_OR(user_id=$2) as reacted
       FROM channel_message_reactions
       WHERE message_id=$1
       GROUP BY emoji
       ORDER BY count DESC, emoji ASC`,
      [messageId, userId]
    );

    emitToChannel(serverId, channelId, 'channel_message_reaction_updated', {
      channelId,
      messageId,
      reactions: agg.rows.map(r => ({
        emoji: r.emoji,
        count: parseInt(r.count, 10) || 0,
        reacted: !!r.reacted
      }))
    });
    relayNexusChannelReaction({ nexusMessageId: messageId, emoji: normalizedEmoji })
      .catch(error => console.error('Nexus LINK reaction relay error:', error));
  });

  // Admin: force-suspend an active user
  socket.on('admin_suspend_user', async ({ targetUserId, suspendedUntil, reason }) => {
    if (!(await isGlobalAdmin(userId))) return;
    // Emit suspended event to all of that user's sockets
    io.to(`user:${targetUserId}`).emit('account_suspended', { suspendedUntil, reason: reason || null });
  });

  socket.on('call_invite', async ({ toId, callType } = {}) => {
    const friendship = await pool.query(
      'SELECT 1 FROM friendships WHERE (user1_id=$1 AND user2_id=$2) OR (user1_id=$2 AND user2_id=$1) LIMIT 1',
      [userId, String(toId || '')]
    );
    if (!friendship.rows.length) return socket.emit('call_error', { error: 'You can only call friends.' });
    const targetRoom = await getUserCallRoom(toId);
    if (targetRoom) { socket.emit('call_busy', { userId: toId }); return; }
    const roomId = uuidv4();
    const normalizedCallType = callType === 'video' ? 'video' : 'voice';
    callTypes.set(roomId, normalizedCallType);
    directCallInvites.set(roomId, { fromId: userId, toId, callType: normalizedCallType });
    const caller = await pool.query(
      `SELECT u.username, u.display_name, (u.avatar_data IS NOT NULL) AS has_avatar, ats.server_tag
       FROM users u LEFT JOIN servers ats ON ats.id=u.active_server_tag_id WHERE u.id=$1`, [userId]
    );
    const c = caller.rows[0];
    io.to(`user:${toId}`).emit('incoming_call', {
      roomId, fromId: userId,
      callType: normalizedCallType,
      caller: {
        username: c.username, displayName: c.display_name,
        avatarDataUrl: avatarUrl(userId, !!c.has_avatar)
      }
    });
    relayNexusCallInvite({
      nexusRecipientId: toId,
      roomId,
      callType: normalizedCallType,
      caller: {
        id: userId,
        username: c.username,
        displayName: c.display_name,
        avatarDataUrl: avatarUrl(userId, !!c.has_avatar),
        activeServerTag: c.server_tag || null
      }
    }).catch(error => console.error('Nexus LINK call relay error:', error));
    socket.emit('call_ringing', { roomId, toId, callType: normalizedCallType });
  });

  socket.on('call_accept', async ({ roomId, toId }, ack = () => {}) => {
    if (socket.data.activityOnly && socket.data.activityCall && (socket.data.activityCall.roomId !== roomId || socket.data.activityCall.callerId !== String(toId || ''))) return;
    const invite = directCallInvites.get(roomId);
    if (!invite || invite.fromId !== toId || invite.toId !== userId) return ack({ error: 'That call is no longer available.' });
    directCallInvites.delete(roomId);
    const callType = callTypes.get(roomId) || 'voice';
    await setRoomParticipants(roomId, [userId, toId]);
    await setUserCallRoom(userId, roomId);
    await setUserCallRoom(toId, roomId);
    socket.join(`call:${roomId}`);
    io.to(`user:${toId}`).emit('call_accepted', { roomId, byId: userId, callType });
    socket.emit('call_joined', { roomId, callType });
    ack({ success: true, callType });
  });

  socket.on('call_decline', ({ roomId, toId }) => {
    const invite = directCallInvites.get(roomId);
    if (!invite || invite.fromId !== toId || invite.toId !== userId) return;
    directCallInvites.delete(roomId);
    callTypes.delete(roomId);
    io.to(`user:${toId}`).emit('call_declined', { roomId, byId: userId });
  });

  socket.on('join_call', async ({ roomId } = {}) => {
    if (socket.data.activityOnly && socket.data.activityCall && socket.data.activityCall.roomId !== roomId) return;
    const participants = await getRoomParticipants(String(roomId || ''));
    if (!participants.has(userId)) return socket.emit('call_error', { error: 'You are not invited to this call.' });
    socket.data.callRoomId = roomId;
    socket.join(`call:${roomId}`);
    socket.to(`call:${roomId}`).emit('peer_joined', { userId });
  });

  socket.on('webrtc_offer', async ({ roomId, toId, offer } = {}) => {
    if (socket.data.activityOnly && socket.data.activityCall && (socket.data.activityCall.roomId !== roomId || socket.data.activityCall.callerId !== String(toId || ''))) return;
    const participants = await getRoomParticipants(String(roomId || ''));
    if (!participants.has(userId) || !participants.has(String(toId || ''))) return;
    io.to(`user:${toId}`).emit('webrtc_offer', { roomId, fromId: userId, offer });
  });
  socket.on('webrtc_answer', async ({ roomId, toId, answer } = {}) => {
    if (socket.data.activityOnly && socket.data.activityCall && (socket.data.activityCall.roomId !== roomId || socket.data.activityCall.callerId !== String(toId || ''))) return;
    const participants = await getRoomParticipants(String(roomId || ''));
    if (!participants.has(userId) || !participants.has(String(toId || ''))) return;
    io.to(`user:${toId}`).emit('webrtc_answer', { roomId, fromId: userId, answer });
  });
  socket.on('webrtc_ice', async ({ roomId, toId, candidate } = {}) => {
    if (socket.data.activityOnly && socket.data.activityCall && (socket.data.activityCall.roomId !== roomId || socket.data.activityCall.callerId !== String(toId || ''))) return;
    const participants = await getRoomParticipants(String(roomId || ''));
    if (!participants.has(userId) || !participants.has(String(toId || ''))) return;
    io.to(`user:${toId}`).emit('webrtc_ice', { roomId, fromId: userId, candidate });
  });

  socket.on('call_end', async ({ roomId } = {}) => {
    if (socket.data.activityOnly && socket.data.activityCall && socket.data.activityCall.roomId !== roomId) return;
    const participants = await getRoomParticipants(String(roomId || ''));
    if (!participants.has(userId)) return;
    await closeDirectCallRoom(roomId);
    socket.data.callRoomId = null;
    socket.leave(`call:${roomId}`);
  });

  socket.on('call_cancel', ({ toId, roomId } = {}) => {
    const invite = roomId ? directCallInvites.get(roomId) : null;
    if (!invite || invite.fromId !== userId || invite.toId !== toId) return;
    callTypes.delete(roomId); directCallInvites.delete(roomId);
    // Receiver will ignore if there is no pending call.
    io.to(`user:${toId}`).emit('call_cancelled', { fromId: userId });
  });

  socket.on('screenshare_started', async ({ roomId, toId } = {}) => {
    const participants = await getRoomParticipants(String(roomId || ''));
    if (!participants.has(userId) || !participants.has(String(toId || ''))) return;
    io.to(`user:${toId}`).emit('screenshare_started', { fromId: userId });
  });

  socket.on('screenshare_stopped', async ({ roomId, toId } = {}) => {
    const participants = await getRoomParticipants(String(roomId || ''));
    if (!participants.has(userId) || !participants.has(String(toId || ''))) return;
    io.to(`user:${toId}`).emit('screenshare_stopped', { fromId: userId });
  });

  socket.on('join_group_call', async ({ serverId, channelId }) => {
    if (!serverId || !channelId) return;
    const channel = await getChannelAccess(pool, serverId, channelId, userId);
    if (!channel || (channel.channel_type || 'text') !== 'voice') {
      return socket.emit('group_call_error', { error: 'You cannot join that voice channel.' });
    }

    const roomId = getGroupCallRoomId(serverId, channelId);
    const previousRoomId = userGroupCallRoom.get(userId);
    if (previousRoomId && previousRoomId !== roomId) {
      const prevRoom = groupCallRooms.get(previousRoomId);
      if (prevRoom) {
        prevRoom.delete(userId);
        io.to(`groupcall:${previousRoomId}`).emit('group_call_user_left', { roomId: previousRoomId, userId });
        if (!prevRoom.size) groupCallRooms.delete(previousRoomId);
      }
      userGroupCallRoom.delete(userId);
      socket.leave(`groupcall:${previousRoomId}`);
    }

    if (!groupCallRooms.has(roomId)) groupCallRooms.set(roomId, new Set());
    const roomSet = groupCallRooms.get(roomId);
    roomSet.add(userId);
    userGroupCallRoom.set(userId, roomId);
    socket.join(`groupcall:${roomId}`);

    const participantIds = [...roomSet];
    const users = await pool.query(
      `SELECT id, username, display_name, (avatar_data IS NOT NULL) AS has_avatar
       FROM users WHERE id = ANY($1)`,
      [participantIds]
    );
    const participantMap = new Map(users.rows.map(u => [u.id, mapUserForClient(u)]));
    const participants = participantIds.map(id => participantMap.get(id)).filter(Boolean);

    socket.emit('group_call_joined', {
      roomId,
      serverId,
      channelId,
      participants
    });

    const joinedUser = participantMap.get(userId);
    if (joinedUser) {
      socket.to(`groupcall:${roomId}`).emit('group_call_user_joined', {
        roomId,
        user: joinedUser
      });
    }
  });

  socket.on('leave_group_call', () => {
    const roomId = userGroupCallRoom.get(userId);
    if (!roomId) return;

    const roomSet = groupCallRooms.get(roomId);
    if (roomSet) {
      roomSet.delete(userId);
      io.to(`groupcall:${roomId}`).emit('group_call_user_left', { roomId, userId });
      if (!roomSet.size) groupCallRooms.delete(roomId);
    }
    userGroupCallRoom.delete(userId);
    socket.leave(`groupcall:${roomId}`);
  });

  socket.on('group_webrtc_offer', ({ roomId, toId, offer }) => {
    const myRoom = userGroupCallRoom.get(userId);
    const peerRoom = userGroupCallRoom.get(toId);
    if (!roomId || myRoom !== roomId || peerRoom !== roomId) return;
    io.to(`user:${toId}`).emit('group_webrtc_offer', { roomId, fromId: userId, offer });
  });

  socket.on('group_webrtc_answer', ({ roomId, toId, answer }) => {
    const myRoom = userGroupCallRoom.get(userId);
    const peerRoom = userGroupCallRoom.get(toId);
    if (!roomId || myRoom !== roomId || peerRoom !== roomId) return;
    io.to(`user:${toId}`).emit('group_webrtc_answer', { roomId, fromId: userId, answer });
  });

  socket.on('group_webrtc_ice', ({ roomId, toId, candidate }) => {
    const myRoom = userGroupCallRoom.get(userId);
    const peerRoom = userGroupCallRoom.get(toId);
    if (!roomId || myRoom !== roomId || peerRoom !== roomId) return;
    io.to(`user:${toId}`).emit('group_webrtc_ice', { roomId, fromId: userId, candidate });
  });

  socket.on('call_game_open', async ({ roomId, type, buyIn, bet }, ack = () => {}) => {
    if (!roomId || !['blackjack', 'poker', 'uno', 'connect4'].includes(type)) return ack({ error: 'Choose a valid game.' });
    if (!await isInGameRoom(userId, roomId)) return ack({ error: 'Join the call before starting a game.' });
    let game = callGames.get(roomId);
    if (!game || game.phase === 'complete') {
      const me = await pool.query('SELECT display_name FROM users WHERE id=$1', [userId]);
      let purchase = { buyIn: 0, tokens: 0, nexals: null };
      if (!['uno', 'connect4'].includes(type)) {
        try { purchase = await buyCallTableTokens(userId, buyIn); }
        catch (error) { return ack({ error: error.message }); }
      }
      const openingBet = Math.min(1000000, Math.max(0, parseInt(bet, 10) || 0));
      game = { type, phase: 'lobby', hostId: userId, roundsTotal: 3, roundNumber: 0, players: [{ id: userId, displayName: me.rows[0]?.display_name || 'Player', chips: purchase.tokens, buyIn: purchase.buyIn, bet: openingBet, score: 0, hand: [] }], dealer: { hand: [] }, deck: [], discard: [], community: [], pot: 0 };
      callGames.set(roomId, game);
      if (purchase.nexals !== null) socket.emit('nexals_updated', { nexals: purchase.nexals });
      const host = { id: userId, displayName: me.rows[0]?.display_name || 'Player' };
      socket.to(`call:${roomId}`).emit('call_game_invite', { roomId, type, host });
      socket.to(`groupcall:${roomId}`).emit('call_game_invite', { roomId, type, host });
    }
    const hostName = game.players.find(player => player.id === game.hostId)?.displayName || 'A caller';
    io.to(`call:${roomId}`).emit('call_game_available', { roomId, type: game.type, hostName });
    io.to(`groupcall:${roomId}`).emit('call_game_available', { roomId, type: game.type, hostName });
    socket.emit('call_game_state', { roomId, game: gameStateFor(game, userId) });
    emitGame(roomId);
    ack({ success: true });
  });

  socket.on('call_game_browse', async ({ roomId, type }, ack = () => {}) => {
    if (!roomId || !['uno', 'connect4'].includes(type) || !await isInGameRoom(userId, roomId)) {
      return ack({ error: 'Join the call before browsing activities.' });
    }
    const game = callGames.get(roomId);
    if (!game || game.type !== type || game.phase !== 'lobby') {
      return ack({ room: null });
    }
    if (game.players.some(player => player.id === userId)) {
      socket.emit('call_game_state', { roomId, game: gameStateFor(game, userId) });
    }
    const host = game.players.find(player => player.id === game.hostId);
    ack({
      room: {
        type,
        hostName: host?.displayName || 'A caller',
        playerCount: game.players.length,
        joined: game.players.some(player => player.id === userId)
      }
    });
  });

  socket.on('call_game_join', async ({ roomId, buyIn, bet }, ack = () => {}) => {
    const game = callGames.get(roomId);
    const maxPlayers = game?.type === 'connect4' ? 2 : 6;
    if (!game) return ack({ error: 'That activity is no longer open.' });
    if (game.phase !== 'lobby') return ack({ error: 'That match has already started.' });
    if (!await isInGameRoom(userId, roomId)) return ack({ error: 'Join the call before joining the activity.' });
    if (game.players.some(p => p.id === userId)) {
      socket.emit('call_game_state', { roomId, game: gameStateFor(game, userId) });
      return ack({ success: true, alreadyJoined: true });
    }
    if (game.players.length >= maxPlayers) return ack({ error: 'That activity is full.' });
    const me = await pool.query('SELECT display_name FROM users WHERE id=$1', [userId]);
    let purchase = { buyIn: 0, tokens: 0, nexals: null };
    if (!['uno', 'connect4'].includes(game.type)) {
      try { purchase = await buyCallTableTokens(userId, buyIn); }
      catch (error) { socket.emit('call_game_error', { message: error.message }); return ack({ error: error.message }); }
    }
    const openingBet = Math.min(1000000, Math.max(0, parseInt(bet, 10) || 0));
    if (!['uno', 'connect4'].includes(game.type) && (!openingBet || openingBet > purchase.tokens)) {
      if (purchase.buyIn) {
        await pool.query('UPDATE users SET nexals=nexals+$1 WHERE id=$2', [purchase.buyIn, userId]);
      }
      return ack({ error: 'Choose a token bet that fits within your table balance.' });
    }
    game.players.push({ id: userId, displayName: me.rows[0]?.display_name || 'Player', chips: purchase.tokens, buyIn: purchase.buyIn, bet: openingBet, score: 0, hand: [] });
    if (purchase.nexals !== null) socket.emit('nexals_updated', { nexals: purchase.nexals });
    emitGame(roomId);
    ack({ success: true });
  });

  socket.on('call_game_start', async ({ roomId, rounds }) => {
    const game = callGames.get(roomId);
    if (!game || game.hostId !== userId || game.phase !== 'lobby' || !await isInGameRoom(userId, roomId)) return;
    if (game.players.length < 2) {
      socket.emit('call_game_error', { message: 'A call game needs the other person to join first.' });
      return;
    }
    game.roundsTotal = ['uno', 'connect4'].includes(game.type) ? 1 : Math.max(1, Math.min(15, parseInt(rounds, 10) || game.roundsTotal || 3));
    game.roundNumber = 1;
    if (game.type === 'blackjack') {
      const invalid = game.players.find(p => !p.bet || p.bet <= 0 || p.bet > p.chips);
      if (invalid) {
        socket.emit('call_game_error', { message: `${invalid.displayName} needs a valid token bet before starting.` });
        return;
      }
    }
    beginCallGameRound(game);
    emitGame(roomId);
  });

  socket.on('call_game_close', async ({ roomId }) => {
    const game = callGames.get(roomId);
    if (!game || game.hostId !== userId || !await isInGameRoom(userId, roomId)) return;
    await settleCallGame(roomId, 'Activity ended');
    callGames.delete(roomId);
    io.to(`call:${roomId}`).emit('call_game_closed', { roomId });
    io.to(`groupcall:${roomId}`).emit('call_game_closed', { roomId });
  });

  socket.on('call_game_leave', async ({ roomId }) => {
    const game = callGames.get(roomId);
    if (!game || !game.players.some(player => player.id === userId) || !await isInGameRoom(userId, roomId)) return;
    await settleCallGame(roomId, 'A participant left the activity');
    callGames.delete(roomId);
    io.to(`call:${roomId}`).emit('call_game_closed', { roomId, reason: 'A participant left the activity.' });
    io.to(`groupcall:${roomId}`).emit('call_game_closed', { roomId, reason: 'A participant left the activity.' });
  });

  socket.on('call_game_next_round', async ({ roomId }) => {
    const game = callGames.get(roomId);
    if (!game || game.hostId !== userId || game.phase !== 'round_complete' || !await isInGameRoom(userId, roomId)) return;
    if (game.type === 'blackjack') {
      const invalid = game.players.find(p => !p.bet || p.bet <= 0 || p.bet > p.chips);
      if (invalid) {
        socket.emit('call_game_error', { message: `${invalid.displayName} needs enough tokens for the next bet.` });
        return;
      }
    }
    game.roundNumber += 1;
    beginCallGameRound(game);
    emitGame(roomId);
  });

  socket.on('call_game_action', async ({ roomId, action, cardId, color, column }) => {
    const game = callGames.get(roomId);
    if (!game || game.phase !== 'playing' || !await isInGameRoom(userId, roomId)) return;
    const player = game.players.find(p => p.id === userId);
    if (!player) return;
    if (game.type === 'connect4') {
      if (game.turnId !== userId || action !== 'drop' || game.actionPending) return;
      const targetColumn = Number.parseInt(column, 10);
      if (!Number.isInteger(targetColumn) || targetColumn < 0 || targetColumn > 6) return;
      const playerIndex = game.players.findIndex(item => item.id === userId);
      const boardPiece = playerIndex === 0 ? ConnectFourPiece.PLAYER_1 : ConnectFourPiece.PLAYER_2;
      game.actionPending = true;
      let applied;
      try {
        applied = await game.connect4Board.applyPlayerAction({ boardPiece }, targetColumn);
      } finally {
        game.actionPending = false;
      }
      if (!applied) {
        socket.emit('call_game_error', { message: 'That column is full.' });
        return;
      }
      const winnerPiece = game.connect4Board.getWinner();
      if (winnerPiece === boardPiece) {
        game.phase = 'complete';
        game.winnerId = userId;
        game.message = `${player.displayName} connected four and wins!`;
        await settleCallGame(roomId, game.message);
      } else if (winnerPiece === ConnectFourPiece.DRAW) {
        game.phase = 'complete';
        game.message = 'The board is full. The game is a draw.';
        await settleCallGame(roomId, game.message);
      } else {
        const nextPlayer = game.players[(playerIndex + 1) % game.players.length];
        game.turnId = nextPlayer.id;
        game.message = `${nextPlayer.displayName}'s turn.`;
      }
    } else if (game.type === 'uno') {
      if (game.turnId !== userId) return;
      if (action === 'draw') {
        if (player.drawnCardId) return;
        drawUnoCards(game, player, 1);
        const drawn = player.hand[player.hand.length - 1];
        if (drawn && isPlayableUnoCard(game, drawn)) {
          player.drawnCardId = drawn.id;
          game.message = `${player.displayName} drew a playable card.`;
        } else {
          game.message = `${player.displayName} drew a card.`;
          advanceUnoTurn(game);
        }
      } else if (action === 'pass') {
        if (!player.drawnCardId) return;
        player.drawnCardId = null;
        game.message = `${player.displayName} kept the drawn card.`;
        advanceUnoTurn(game);
      } else if (action === 'play') {
        const cardIndex = player.hand.findIndex(card => card.id === cardId);
        if (cardIndex < 0) return;
        const card = player.hand[cardIndex];
        if (player.drawnCardId && player.drawnCardId !== card.id) {
          socket.emit('call_game_error', { message: 'After drawing, you may only play the card you just drew.' });
          return;
        }
        if (!isPlayableUnoCard(game, card)) {
          socket.emit('call_game_error', { message: 'That card does not match the current color or symbol.' });
          return;
        }
        if (card.value === 'wild4' && player.hand.some((held, index) => index !== cardIndex && held.color === game.currentColor)) {
          socket.emit('call_game_error', { message: 'Wild Draw Four is only legal when you have no card matching the current color.' });
          return;
        }
        const chosenColor = String(color || '').toLowerCase();
        if (card.color === 'wild' && !['red', 'yellow', 'green', 'blue'].includes(chosenColor)) {
          socket.emit('call_game_error', { message: 'Choose a color for the wild card.' });
          return;
        }
        player.hand.splice(cardIndex, 1);
        player.drawnCardId = null;
        game.discard.push(card);
        game.currentColor = card.color === 'wild' ? chosenColor : card.color;
        game.message = player.hand.length === 1 ? `${player.displayName} calls UNO!` : `${player.displayName} played a card.`;

        if (player.hand.length === 0) {
          const points = game.players
            .filter(other => other.id !== player.id)
            .flatMap(other => other.hand)
            .reduce((sum, remainingCard) => sum + unoCardPoints(remainingCard), 0);
          player.score = (player.score || 0) + points;
          game.winnerId = player.id;
          game.phase = 'complete';
          game.message = `${player.displayName} wins UNO with ${points} points from the remaining hands.`;
          await settleCallGame(roomId, game.message);
        } else if (card.value === 'reverse') {
          game.direction *= -1;
          advanceUnoTurn(game, game.players.length === 2 ? 2 : 1);
        } else if (card.value === 'skip') {
          advanceUnoTurn(game, 2);
        } else if (card.value === 'draw2' || card.value === 'wild4') {
          advanceUnoTurn(game);
          const target = game.players.find(other => other.id === game.turnId);
          drawUnoCards(game, target, card.value === 'draw2' ? 2 : 4);
          game.message = `${target.displayName} draws ${card.value === 'draw2' ? 2 : 4} cards and loses their turn.`;
          advanceUnoTurn(game);
        } else {
          advanceUnoTurn(game);
        }
      } else {
        return;
      }
    } else if (game.type === 'blackjack') {
      if (player.standing) return;
      if (action === 'hit') { player.hand.push(game.deck.pop()); if (blackjackScore(player.hand) >= 21) player.standing = true; }
      if (action === 'stand') player.standing = true;
      if (!['hit','stand'].includes(action)) return;
      if (game.players.every(p => p.standing || blackjackScore(p.hand) > 21)) {
        while (blackjackScore(game.dealer.hand) < 17) game.dealer.hand.push(game.deck.pop());
        const dealerScore = blackjackScore(game.dealer.hand);
        const results = [];
        game.players.forEach(p => {
          const score = blackjackScore(p.hand);
          const wager = Math.max(0, p.bet || 0);
          if (score > 21) {
            p.chips = Math.max(0, p.chips - wager);
            results.push(`${p.displayName} bust -${wager.toLocaleString()}`);
          } else if (score === 21 && p.hand.length === 2 && !(dealerScore === 21 && game.dealer.hand.length === 2)) {
            const win = Math.floor(wager * 1.5);
            p.chips += win;
            results.push(`${p.displayName} blackjack +${win.toLocaleString()}`);
          } else if (dealerScore > 21 || score > dealerScore) {
            p.chips += wager;
            results.push(`${p.displayName} wins +${wager.toLocaleString()}`);
          } else if (score === dealerScore) {
            results.push(`${p.displayName} pushes`);
          } else {
            p.chips = Math.max(0, p.chips - wager);
            results.push(`${p.displayName} loses -${wager.toLocaleString()}`);
          }
        });
        if (game.roundNumber >= game.roundsTotal) {
          game.phase = 'complete';
          game.message = `Match complete. ${results.join(' | ')}`;
          await settleCallGame(roomId, game.message);
        } else {
          game.phase = 'round_complete';
          game.message = `Round ${game.roundNumber} complete. ${results.join(' | ')}. ${game.roundsTotal - game.roundNumber} round${game.roundsTotal - game.roundNumber === 1 ? '' : 's'} remaining.`;
        }
      }
    } else {
      if (game.turnId !== userId || !['check','call','fold'].includes(action)) return;
      if (action === 'fold') player.folded = true; else { player.bet += 20; player.chips -= 20; game.pot += 20; }
      const active = game.players.filter(p => !p.folded);
      const index = active.findIndex(p => p.id === userId);
      if (active.length === 1) { game.winnerId = active[0].id; active[0].chips += game.pot; game.phase = game.roundNumber >= game.roundsTotal ? 'complete' : 'round_complete'; game.message = game.phase === 'complete' ? 'Match complete: everyone else folded.' : `Round ${game.roundNumber} complete. Host can start the next round.`; if (game.phase === 'complete') await settleCallGame(roomId, game.message); }
      else if (index === active.length - 1) { game.community.push(game.deck.pop(), game.deck.pop()); const winner = active[crypto.randomInt(active.length)]; winner.chips += game.pot; game.winnerId = winner.id; game.phase = game.roundNumber >= game.roundsTotal ? 'complete' : 'round_complete'; game.message = game.phase === 'complete' ? 'Match complete: showdown complete.' : `Round ${game.roundNumber} complete. Host can start the next round.`; if (game.phase === 'complete') await settleCallGame(roomId, game.message); }
      else game.turnId = active[index + 1].id;
    }
    emitGame(roomId);
  });

  socket.on('disconnect', async () => {
    const disconnectedCallRoom = socket.data.callRoomId;
    if (disconnectedCallRoom) {
      await closeDirectCallRoom(disconnectedCallRoom, 'A participant left the call');
      socket.data.callRoomId = null;
    }
    const sockets = userSockets.get(userId);
    if (sockets) {
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        userSockets.delete(userId);
        await pool.query("UPDATE users SET status='offline' WHERE id=$1", [userId]);
        broadcastStatusChange(userId, 'offline');
        try {
          const blackjackSettle = await gamesRoutes.settleBlackjackForUser(userId);
          if (blackjackSettle?.settled && typeof blackjackSettle.nexals === 'number') io.to(`user:${userId}`).emit('nexals_updated', { nexals: blackjackSettle.nexals });
        } catch (error) {
          console.error('Blackjack auto-cashout error:', error);
        }
        const roomId = await getUserCallRoom(userId);
        if (roomId) {
          await closeDirectCallRoom(roomId, 'A participant disconnected');
        }

        const gRoomId = userGroupCallRoom.get(userId);
        if (gRoomId) {
          const gRoom = groupCallRooms.get(gRoomId);
          if (gRoom) {
            gRoom.delete(userId);
            io.to(`groupcall:${gRoomId}`).emit('group_call_user_left', { roomId: gRoomId, userId });
            if (!gRoom.size) groupCallRooms.delete(gRoomId);
          }
          userGroupCallRoom.delete(userId);
        }
      }
    }
  });
});

async function broadcastStatusChange(userId, status) {
  const friends = await pool.query(
    `SELECT CASE WHEN user1_id=$1 THEN user2_id ELSE user1_id END as fid
     FROM friendships WHERE user1_id=$1 OR user2_id=$1`,
    [userId]
  );
  friends.rows.forEach(({ fid }) => io.to(`user:${fid}`).emit('status_change', { userId, status }));
}

const PORT = process.env.PORT || 3000;

async function start() {
  const missing = [];
  if (!DATABASE_URL) missing.push('DATABASE_URL');
  if (REQUIRE_REDIS && !REDIS_URL) missing.push('REDIS_URL');
  if (missing.length) {
    console.error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
      'Configure these values in .env or your host secrets.'
    );
    process.exit(1);
  }

  await initDb();
  await ensureNextBotExists();
  await settleDueGiveaways();
  setInterval(() => {
    settleDueGiveaways().catch(error => console.error('Giveaway sweep failed:', error.message));
  }, 30 * 1000).unref();
  await setupRedisBackplane();
  server.listen(PORT, () => console.log(`Nexus running on port ${PORT}`));
}

start().catch(err => {
  console.error('Failed to initialize server:', err);
  process.exit(1);
});
