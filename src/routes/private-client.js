const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../models/db');
const { safeMessageContent, safeDisplayName } = require('../utils/inputSafety');
const { enforceGlobalSafety, findConfiguredViolation } = require('../utils/globalSafety');
const { getChannelAccess } = require('../utils/channelAccess');
const { safeStoredImageMime } = require('../utils/imageSafety');
const { getCurrentTos } = require('../utils/tosPolicy');
const { getUserSessionVersion } = require('../utils/security');

const router = express.Router();
const NEXUS_GUARD_ID = '00000000-0000-0000-0000-000000000001';
const DEFAULT_SERVER_INVITE_CODE = 'GPFA9B32';
const clientRateBuckets = new Map();
const clientSpamTracker = new Map();
const authAttemptBuckets = new Map();

function clientApiConfig() {
  return {
    clientId: String(process.env.NEXUS_CLIENT_API_CLIENT_ID || ''),
    clientSecret: String(process.env.NEXUS_CLIENT_API_CLIENT_SECRET || ''),
    tokenSecret: String(process.env.NEXUS_CLIENT_API_TOKEN_SECRET || ''),
    tokenLifetimeSeconds: Math.min(60 * 60 * 24 * 30, Math.max(15 * 60, parseInt(process.env.NEXUS_CLIENT_API_TOKEN_TTL_SECONDS, 10) || 60 * 60 * 24 * 7))
  };
}

function timingSafeTokenMatch(expected, received) {
  if (!expected || !received) return false;
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return expectedBuffer.length === receivedBuffer.length && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

function clientApplicationAuth(req, res, next) {
  const { clientId, clientSecret, tokenSecret } = clientApiConfig();
  if (!clientId || !clientSecret || !tokenSecret) return res.status(404).json({ error: 'Not found' });

  // Browser code never sees the client secret. A rebranded client calls this
  // API from its own backend, then keeps each user's Nexus token in a local
  // HttpOnly session cookie.
  if (req.get('origin')) return res.status(403).json({ error: 'Use a server-side Nexus client proxy for this API' });

  const suppliedId = String(req.get('x-nexus-client-id') || '');
  const suppliedSecret = String(req.get('x-nexus-client-secret') || '');
  if (!timingSafeTokenMatch(clientId, suppliedId) || !timingSafeTokenMatch(clientSecret, suppliedSecret)) {
    return res.status(401).json({ error: 'Unauthorized client application' });
  }

  req.nexusClientApp = { clientId };
  next();
}

function takePrivateRateToken(req, limit, windowMs, scope) {
  const now = Date.now();
  const authorization = String(req.get('authorization') || '');
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || '';
  const tokenClaims = token ? verifyUserAccessToken(token) : null;
  const identity = tokenClaims?.sub
    ? `user:${tokenClaims.sub}`
    : `unauth:${String(req.body?.username || req.ip || req.socket?.remoteAddress || 'unknown').toLowerCase().slice(0, 80)}`;
  const key = `${scope}:${req.nexusClientApp?.clientId || 'unknown'}:${identity}:${req.method}:${req.path}`;
  if (clientRateBuckets.size > 2000) clientRateBuckets.clear();
  const active = (clientRateBuckets.get(key) || []).filter(time => now - time < windowMs);
  if (active.length >= limit) {
    clientRateBuckets.set(key, active);
    return false;
  }
  active.push(now);
  clientRateBuckets.set(key, active);
  return true;
}

function encodeTokenPart(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signTokenPart(value, tokenSecret) {
  return crypto.createHmac('sha256', tokenSecret).update(value).digest('base64url');
}

function createUserAccessToken(userId, sessionVersion) {
  const { clientId, tokenSecret, tokenLifetimeSeconds } = clientApiConfig();
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: String(userId),
    clientId,
    sessionVersion: Number(sessionVersion || 0),
    iat: now,
    exp: now + tokenLifetimeSeconds,
    nonce: crypto.randomBytes(12).toString('base64url')
  };
  const encoded = encodeTokenPart(payload);
  return `${encoded}.${signTokenPart(encoded, tokenSecret)}`;
}

function verifyUserAccessToken(rawToken) {
  const { clientId, tokenSecret } = clientApiConfig();
  const [encoded, suppliedSignature, ...rest] = String(rawToken || '').split('.');
  if (!encoded || !suppliedSignature || rest.length) return null;
  const expectedSignature = signTokenPart(encoded, tokenSecret);
  if (!timingSafeTokenMatch(expectedSignature, suppliedSignature)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload || payload.clientId !== clientId || !payload.sub || !Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

async function requireClientUser(req, res, next) {
  const authorization = String(req.get('authorization') || '');
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || '';
  const claims = verifyUserAccessToken(token);
  if (!claims) return res.status(401).json({ error: 'Your Nexus client session expired. Sign in again.' });
  try {
    const user = await pool.query(
      `SELECT u.id, u.session_version, u.accepted_tos_version,
        EXISTS(
          SELECT 1 FROM suspensions
          WHERE user_id=u.id AND active=TRUE AND suspended_until>EXTRACT(EPOCH FROM NOW())::BIGINT
        ) AS suspended
       FROM users u WHERE u.id=$1`,
      [claims.sub]
    );
    const account = user.rows[0];
    if (!account || Number(account.session_version || 0) !== Number(claims.sessionVersion || 0)) {
      return res.status(401).json({ error: 'Your Nexus client session expired. Sign in again.' });
    }
    if (account.suspended) return res.status(403).json({ error: 'This Nexus account is suspended' });
    req.nexusClient = {
      clientId: req.nexusClientApp.clientId,
      userId: account.id,
      acceptedTosVersion: Number(account.accepted_tos_version || 0)
    };
    next();
  } catch (error) {
    next(error);
  }
}

function allowAuthAttempt(req, action, identifier) {
  const now = Date.now();
  const key = `${req.nexusClientApp.clientId}:${action}:${String(identifier || '').toLowerCase()}`;
  const active = (authAttemptBuckets.get(key) || []).filter(time => now - time < 15 * 60 * 1000);
  if (active.length >= 15) {
    authAttemptBuckets.set(key, active);
    return false;
  }
  active.push(now);
  authAttemptBuckets.set(key, active);
  return true;
}

function safeClientDeviceId(value) {
  const deviceId = String(value || '').trim();
  return /^[A-Za-z0-9_-]{8,128}$/.test(deviceId) ? deviceId : null;
}

async function assertDeviceNotBanned(deviceId) {
  if (!deviceId) return;
  const result = await pool.query('SELECT reason FROM ip_bans WHERE device_id=$1 AND active=TRUE LIMIT 1', [deviceId]);
  if (result.rows.length) {
    const error = new Error('This device is banned from Nexus');
    error.statusCode = 403;
    throw error;
  }
}

async function currentUserForAuth(username) {
  const result = await pool.query(
    `SELECT u.id, u.username, u.display_name, u.password_hash, u.bio, u.status, (u.avatar_data IS NOT NULL) AS has_avatar,
      u.active_decoration, u.active_nameplate, u.active_color, u.active_font, u.pro_expires_at,
      u.profile_gradient_start, u.profile_gradient_end, u.profile_name_effect, u.accepted_tos_version, u.session_version,
      EXISTS(
        SELECT 1 FROM suspensions
        WHERE user_id=u.id AND active=TRUE AND suspended_until>EXTRACT(EPOCH FROM NOW())::BIGINT
      ) AS suspended
     FROM users u WHERE LOWER(u.username)=LOWER($1)`,
    [username]
  );
  return result.rows[0] || null;
}

async function requireCurrentClientTos(req, res, next) {
  try {
    const policy = await getCurrentTos();
    if (req.nexusClient.acceptedTosVersion >= policy.version) return next();
    return res.status(428).json({
      error: 'Current Nexus Terms of Service must be accepted before using this client.',
      tosRequired: true,
      tos: policy
    });
  } catch (error) {
    next(error);
  }
}

router.use(clientApplicationAuth);
router.use((req, res, next) => {
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  const allowed = takePrivateRateToken(req, write ? 90 : 300, 60 * 1000, write ? 'write' : 'read');
  if (!allowed) return res.status(429).json({ error: 'Too many Nexus client API requests. Please slow down.' });
  next();
});

function avatarPath(userId, hasAvatar) {
  return hasAvatar ? `/media/users/${encodeURIComponent(userId)}/avatar` : null;
}

function serverIconPath(serverId, hasIcon) {
  return hasIcon ? `/media/servers/${encodeURIComponent(serverId)}/icon` : null;
}

function formatUser(row) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    bio: row.bio || '',
    status: row.status || 'offline',
    avatarPath: avatarPath(row.id, !!row.has_avatar),
    activeDecoration: row.active_decoration || null,
    activeNameplate: row.active_nameplate || null,
    activeColor: row.active_color || null,
    activeFont: row.active_font || null,
    proActive: Number(row.pro_expires_at || 0) > now,
    profileGradientStart: row.profile_gradient_start || null,
    profileGradientEnd: row.profile_gradient_end || null,
    profileNameEffect: row.profile_name_effect || null,
    activeServerTag: row.server_tag || null,
    activeServerTagBackground: row.tag_background || '#5865f2',
    activeServerTagServerId: row.tag_server_id || null,
    activeServerTagServerName: row.tag_private ? null : (row.tag_server_name || null),
    activeServerTagInviteCode: row.tag_private ? null : (row.tag_invite_code || null),
    activeServerTagPrivate: !!row.tag_private
  };
}

function formatAuthor(row) {
  return formatUser({
    ...row,
    id: row.from_id || row.id,
    has_avatar: row.has_avatar
  });
}

function formatServer(row) {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    inviteCode: row.invite_code,
    iconPath: serverIconPath(row.id, !!row.has_icon),
    createdAt: Number(row.created_at || 0),
    tag: row.server_tag || null,
    inviteDescription: row.invite_description || '',
    inviteTags: row.invite_tags || '',
    discoveryEnabled: !!row.discovery_enabled,
    discoveryExpiresAt: row.discovery_expires_at ? Number(row.discovery_expires_at) : null
  };
}

function pagination(req) {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 30));
  const before = Math.max(0, parseInt(req.query.before, 10) || 0);
  const after = Math.max(0, parseInt(req.query.after, 10) || 0);
  return { limit, before, after };
}

async function activeGlobalMute(userId) {
  const now = Math.floor(Date.now() / 1000);
  const result = await pool.query(
    `SELECT id, muted_until FROM global_mutes
     WHERE user_id=$1 AND active=TRUE ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  const mute = result.rows[0];
  if (!mute) return null;
  if (Number(mute.muted_until) <= now) {
    await pool.query('UPDATE global_mutes SET active=FALSE WHERE id=$1', [mute.id]);
    return null;
  }
  return Number(mute.muted_until);
}

async function resolveDirectMentions(content, allowedUserIds) {
  const allowed = new Set(allowedUserIds.filter(Boolean));
  const ids = [...new Set([...String(content || '').matchAll(/<@user:([a-f0-9-]+)>/g)]
    .map(match => match[1])
    .filter(id => allowed.has(id)))];
  if (!ids.length) return { users: {}, roles: {} };
  const users = await pool.query('SELECT id, username, display_name FROM users WHERE id = ANY($1)', [ids]);
  return {
    users: Object.fromEntries(users.rows.map(user => [user.id, { username: user.username, displayName: user.display_name }])),
    roles: {}
  };
}

async function resolveChannelMentions(content, serverId) {
  const userIds = [...new Set([...String(content || '').matchAll(/<@user:([a-f0-9-]+)>/g)].map(match => match[1]))];
  const roleIds = [...new Set([...String(content || '').matchAll(/<@role:([a-f0-9-]+)>/g)].map(match => match[1]))];
  const [users, roles] = await Promise.all([
    userIds.length
      ? pool.query(`SELECT u.id, u.username, u.display_name FROM users u
          JOIN server_members sm ON sm.user_id=u.id AND sm.server_id=$2
          WHERE u.id = ANY($1)`, [userIds, serverId])
      : { rows: [] },
    roleIds.length
      ? pool.query('SELECT id, name, color FROM server_roles WHERE id = ANY($1) AND server_id=$2', [roleIds, serverId])
      : { rows: [] }
  ]);
  return {
    users: Object.fromEntries(users.rows.map(user => [user.id, { username: user.username, displayName: user.display_name }])),
    roles: Object.fromEntries(roles.rows.map(role => [role.id, { name: role.name, color: role.color }]))
  };
}

async function ensureFriendship(userId, peerId) {
  const result = await pool.query(
    `SELECT id FROM friendships WHERE (user1_id=$1 AND user2_id=$2) OR (user1_id=$2 AND user2_id=$1) LIMIT 1`,
    [userId, peerId]
  );
  return !!result.rows.length;
}

async function userForMessage(userId) {
  const result = await pool.query(
    `SELECT u.id, u.username, u.display_name, u.bio, u.status, (u.avatar_data IS NOT NULL) AS has_avatar,
      u.active_decoration, u.active_nameplate, u.active_color, u.active_font, u.pro_expires_at,
      u.profile_gradient_start, u.profile_gradient_end, u.profile_name_effect,
      ats.id AS tag_server_id, ats.name AS tag_server_name, ats.invite_code AS tag_invite_code,
      ats.server_tag, ats.tag_background, ats.tag_private
     FROM users u
     LEFT JOIN servers ats ON ats.id=u.active_server_tag_id
     WHERE u.id=$1`,
    [userId]
  );
  return result.rows[0] || null;
}

router.get('/auth/terms', async (req, res, next) => {
  try {
    res.json({ tos: await getCurrentTos() });
  } catch (error) {
    next(error);
  }
});

router.post('/auth/register', async (req, res, next) => {
  const { username, displayName, password } = req.body || {};
  try {
    if (!allowAuthAttempt(req, 'register', username)) return res.status(429).json({ error: 'Too many registration attempts. Try again in a few minutes.' });
    if (typeof username !== 'string' || typeof displayName !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'All fields must be text' });
    }
    if (!username || !displayName || !password) return res.status(400).json({ error: 'All fields required' });
    if (username.length < 3 || username.length > 32) return res.status(400).json({ error: 'Username must be 3-32 characters' });
    if (!/^[a-zA-Z0-9_.-]+$/.test(username)) return res.status(400).json({ error: 'Username may only contain letters, numbers, _, ., -' });
    if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Password must be 8-128 characters' });
    let safeName;
    try {
      safeName = safeDisplayName(displayName);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const policy = await getCurrentTos();
    if (req.body?.acceptedTos !== true || Number(req.body?.acceptedTosVersion) !== policy.version) {
      return res.status(409).json({ error: 'You must accept the current Nexus Terms of Service.', tosRequired: true, tos: policy });
    }
    const deviceId = safeClientDeviceId(req.body?.deviceId);
    await assertDeviceNotBanned(deviceId);
    const normalizedUsername = username.toLowerCase();
    const passwordHash = await bcrypt.hash(password, 12);
    const id = uuidv4();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const exists = await client.query('SELECT id FROM users WHERE LOWER(username)=LOWER($1) FOR UPDATE', [normalizedUsername]);
      if (exists.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Username already taken' });
      }
      await client.query(
        `INSERT INTO users
          (id, username, display_name, password_hash, last_device_id, tutorial_completed, accepted_tos_version, accepted_tos_at)
         VALUES ($1,$2,$3,$4,$5,FALSE,$6,EXTRACT(EPOCH FROM NOW())::BIGINT)`,
        [id, normalizedUsername, safeName, passwordHash, deviceId, policy.version]
      );
      await client.query(
        `INSERT INTO tos_acceptances (id, user_id, version)
         VALUES ($1,$2,$3) ON CONFLICT (user_id, version) DO NOTHING`,
        [uuidv4(), id, policy.version]
      );
      const defaultServer = await client.query('SELECT id FROM servers WHERE UPPER(invite_code)=UPPER($1) LIMIT 1', [DEFAULT_SERVER_INVITE_CODE]);
      if (defaultServer.rows[0]) {
        await client.query(
          `INSERT INTO server_members (id, server_id, user_id)
           VALUES ($1,$2,$3) ON CONFLICT (server_id, user_id) DO NOTHING`,
          [uuidv4(), defaultServer.rows[0].id, id]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      if (error.code === '23505') return res.status(409).json({ error: 'Username already taken' });
      throw error;
    } finally {
      client.release();
    }
    const sessionVersion = await getUserSessionVersion(id);
    const user = {
      id,
      username: normalizedUsername,
      display_name: safeName,
      status: 'offline',
      has_avatar: false,
      active_decoration: null,
      active_nameplate: null,
      active_color: null,
      active_font: null,
      pro_expires_at: 0
    };
    res.status(201).json({
      success: true,
      accessToken: createUserAccessToken(id, sessionVersion),
      expiresIn: clientApiConfig().tokenLifetimeSeconds,
      tosRequired: false,
      user: formatUser(user)
    });
  } catch (error) {
    next(error);
  }
});

router.post('/auth/login', async (req, res, next) => {
  const { username, password } = req.body || {};
  try {
    if (!allowAuthAttempt(req, 'login', username)) return res.status(429).json({ error: 'Too many sign-in attempts. Try again in a few minutes.' });
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) return res.status(400).json({ error: 'Username and password are required' });
    if (username.length > 32 || password.length > 128) return res.status(401).json({ error: 'Invalid credentials' });
    const deviceId = safeClientDeviceId(req.body?.deviceId);
    await assertDeviceNotBanned(deviceId);
    const user = await currentUserForAuth(username);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.suspended) return res.status(403).json({ error: 'This Nexus account is suspended' });
    if (deviceId) await pool.query('UPDATE users SET last_device_id=$1 WHERE id=$2', [deviceId, user.id]);
    const policy = await getCurrentTos();
    const acceptedVersion = Number(user.accepted_tos_version || 0);
    res.json({
      success: true,
      accessToken: createUserAccessToken(user.id, await getUserSessionVersion(user.id)),
      expiresIn: clientApiConfig().tokenLifetimeSeconds,
      tosRequired: acceptedVersion < policy.version,
      tos: acceptedVersion < policy.version ? policy : null,
      user: formatUser(user)
    });
  } catch (error) {
    next(error);
  }
});

router.use(requireClientUser);

router.post('/auth/tos/accept', async (req, res, next) => {
  try {
    const policy = await getCurrentTos();
    if (req.body?.accepted !== true || Number(req.body?.version) !== policy.version) {
      return res.status(409).json({ error: 'The Terms of Service changed. Review the latest version.', tosRequired: true, tos: policy });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE users
         SET accepted_tos_version=$1, accepted_tos_at=EXTRACT(EPOCH FROM NOW())::BIGINT
         WHERE id=$2`,
        [policy.version, req.nexusClient.userId]
      );
      await client.query(
        `INSERT INTO tos_acceptances (id, user_id, version)
         VALUES ($1,$2,$3) ON CONFLICT (user_id, version) DO NOTHING`,
        [uuidv4(), req.nexusClient.userId, policy.version]
      );
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
    res.json({ success: true, acceptedVersion: policy.version });
  } catch (error) {
    next(error);
  }
});

router.post('/auth/logout', (req, res) => {
  // The white-label client clears its own HttpOnly session. Tokens are also
  // invalidated immediately by a Nexus password/session-version change.
  res.json({ success: true });
});

router.use(requireCurrentClientTos);

router.get('/session', async (req, res, next) => {
  try {
    const user = await userForMessage(req.nexusClient.userId);
    if (!user) return res.status(404).json({ error: 'Nexus account not found' });
    res.json({ apiVersion: '1', user: formatUser(user) });
  } catch (error) {
    next(error);
  }
});

router.get('/friends', async (req, res, next) => {
  try {
    const userId = req.nexusClient.userId;
    const result = await pool.query(
      `SELECT u.id, u.username, u.display_name, u.bio, u.status, (u.avatar_data IS NOT NULL) AS has_avatar,
        u.active_decoration, u.active_nameplate, u.active_color, u.active_font, u.pro_expires_at,
        u.profile_gradient_start, u.profile_gradient_end, u.profile_name_effect,
        ats.id AS tag_server_id, ats.name AS tag_server_name, ats.invite_code AS tag_invite_code,
        ats.server_tag, ats.tag_background, ats.tag_private
       FROM friendships f
       JOIN users u ON u.id=CASE WHEN f.user1_id=$1 THEN f.user2_id ELSE f.user1_id END
       LEFT JOIN servers ats ON ats.id=u.active_server_tag_id
       WHERE (f.user1_id=$1 OR f.user2_id=$1) AND u.id != $2
       ORDER BY LOWER(u.display_name), LOWER(u.username)`,
      [userId, NEXUS_GUARD_ID]
    );
    res.json({ friends: result.rows.map(formatUser) });
  } catch (error) {
    next(error);
  }
});

router.get('/servers', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.name, s.owner_id, s.invite_code, s.created_at, s.server_tag,
        s.invite_description, s.invite_tags, s.discovery_enabled, s.discovery_expires_at,
        (s.icon_data IS NOT NULL) AS has_icon
       FROM servers s
       JOIN server_members sm ON sm.server_id=s.id
       WHERE sm.user_id=$1
       ORDER BY sm.joined_at ASC`,
      [req.nexusClient.userId]
    );
    res.json({ servers: result.rows.map(formatServer) });
  } catch (error) {
    next(error);
  }
});

router.get('/servers/:serverId', async (req, res, next) => {
  try {
    const { serverId } = req.params;
    const userId = req.nexusClient.userId;
    const membership = await pool.query('SELECT 1 FROM server_members WHERE server_id=$1 AND user_id=$2', [serverId, userId]);
    if (!membership.rows.length) return res.status(403).json({ error: 'You are not a member of that server' });

    const [serverResult, channelsResult, membersResult] = await Promise.all([
      pool.query(
        `SELECT id, name, owner_id, invite_code, created_at, server_tag, invite_description,
          invite_tags, discovery_enabled, discovery_expires_at, (icon_data IS NOT NULL) AS has_icon
         FROM servers WHERE id=$1`,
        [serverId]
      ),
      pool.query(
        `SELECT c.id, c.name, c.position, c.channel_type, c.locked, c.private, c.topic, c.slowmode_seconds,
          CASE WHEN c.private=FALSE THEN TRUE
               WHEN sm.role='admin' OR EXISTS(SELECT 1 FROM server_roles sr WHERE sr.id=sm.role_id AND sr.is_admin=TRUE) THEN TRUE
               WHEN EXISTS(SELECT 1 FROM channel_permissions cp WHERE cp.channel_id=c.id AND cp.role_id=sm.role_id AND cp.allow_view=TRUE) THEN TRUE
               ELSE FALSE END AS can_view
         FROM channels c
         LEFT JOIN server_members sm ON sm.server_id=c.server_id AND sm.user_id=$2
         WHERE c.server_id=$1
         ORDER BY c.position ASC`,
        [serverId, userId]
      ),
      pool.query(
        `SELECT u.id, u.username, u.display_name, u.status, (u.avatar_data IS NOT NULL) AS has_avatar,
          u.active_decoration, u.active_nameplate, u.active_color, u.active_font, u.pro_expires_at,
          u.profile_gradient_start, u.profile_gradient_end, u.profile_name_effect,
          sm.role, sm.role_id, sr.name AS role_name, sr.color AS role_color
         FROM server_members sm
         JOIN users u ON u.id=sm.user_id
         LEFT JOIN server_roles sr ON sr.id=sm.role_id
         WHERE sm.server_id=$1
         ORDER BY LOWER(u.display_name), LOWER(u.username)`,
        [serverId]
      )
    ]);
    if (!serverResult.rows.length) return res.status(404).json({ error: 'Server not found' });
    res.json({
      server: formatServer(serverResult.rows[0]),
      channels: channelsResult.rows.filter(channel => channel.can_view).map(channel => ({
        id: channel.id,
        name: channel.name,
        type: channel.channel_type || 'text',
        position: Number(channel.position || 0),
        locked: !!channel.locked,
        private: !!channel.private,
        topic: channel.topic || null,
        slowmodeSeconds: Math.max(0, Number(channel.slowmode_seconds || 0))
      })),
      members: membersResult.rows.map(member => ({
        ...formatUser(member),
        role: member.role || null,
        roleId: member.role_id || null,
        roleName: member.role_name || null,
        roleColor: member.role_color || null
      }))
    });
  } catch (error) {
    next(error);
  }
});

router.get('/dms/:userId', async (req, res, next) => {
  try {
    const userId = req.nexusClient.userId;
    const peerId = String(req.params.userId || '');
    const isGuardThread = peerId === NEXUS_GUARD_ID;
    if (!isGuardThread && !(await ensureFriendship(userId, peerId))) return res.status(403).json({ error: 'You can only read direct messages with Nexus friends' });

    const { limit, before, after } = pagination(req);
    let query = `SELECT m.id, m.from_id, m.to_id, m.content, m.created_at,
      u.id, u.username, u.display_name, u.bio, u.status, (u.avatar_data IS NOT NULL) AS has_avatar,
      u.active_decoration, u.active_nameplate, u.active_color, u.active_font, u.pro_expires_at,
      u.profile_gradient_start, u.profile_gradient_end, u.profile_name_effect,
      ats.id AS tag_server_id, ats.name AS tag_server_name, ats.invite_code AS tag_invite_code,
      ats.server_tag, ats.tag_background, ats.tag_private
      FROM messages m
      JOIN users u ON u.id=m.from_id
      LEFT JOIN servers ats ON ats.id=u.active_server_tag_id
      WHERE ((m.from_id=$1 AND m.to_id=$2) OR (m.from_id=$2 AND m.to_id=$1))`;
    const params = [userId, peerId];
    if (after) {
      params.push(after);
      query += ` AND m.created_at >= $${params.length}`;
      query += ` ORDER BY m.created_at ASC LIMIT $${params.length + 1}`;
    } else {
      if (before) {
        params.push(before);
        query += ` AND m.created_at < $${params.length}`;
      }
      query += ` ORDER BY m.created_at DESC LIMIT $${params.length + 1}`;
    }
    params.push(limit);
    const result = await pool.query(query, params);
    const rows = after ? result.rows : result.rows.reverse();
    const authors = {};
    rows.forEach(row => { if (!authors[row.from_id]) authors[row.from_id] = formatAuthor(row); });
    res.json({
      authors,
      messages: rows.map(row => ({
        id: row.id,
        fromId: row.from_id,
        toId: row.to_id,
        content: row.content,
        createdAt: Number(row.created_at),
        authorId: row.from_id
      }))
    });
  } catch (error) {
    next(error);
  }
});

router.post('/dms/:userId', async (req, res, next) => {
  try {
    const fromId = req.nexusClient.userId;
    const toId = String(req.params.userId || '');
    if (!toId || toId === fromId) return res.status(400).json({ error: 'Choose another Nexus user' });
    const content = safeMessageContent(req.body?.content, { field: 'Message' });
    if (await activeGlobalMute(fromId)) return res.status(403).json({ error: 'Your Nexus account is globally muted' });
    const violation = await enforceGlobalSafety({ userId: fromId, content, messageType: 'dm' });
    if (violation) return res.status(400).json({ error: 'Message blocked by NexusGuard global safety policy. The attempt was automatically reported.' });
    if (!(await ensureFriendship(fromId, toId))) return res.status(403).json({ error: 'You can only message Nexus friends' });

    const sender = await userForMessage(fromId);
    if (!sender) return res.status(404).json({ error: 'Nexus account was not found' });
    const now = Math.floor(Date.now() / 1000);
    const message = {
      id: uuidv4(),
      fromId,
      toId,
      content,
      createdAt: now,
      mentions: await resolveDirectMentions(content, [fromId, toId]),
      author: formatUser(sender)
    };
    await pool.query('INSERT INTO messages (id, from_id, to_id, content, created_at) VALUES ($1,$2,$3,$4,$5)', [message.id, fromId, toId, content, now]);

    const io = req.app.get('io');
    io?.to(`user:${fromId}`).emit('new_message', message);
    io?.to(`user:${toId}`).emit('new_message', message);
    if (content.includes(`<@user:${toId}>`)) {
      io?.to(`user:${toId}`).emit('mentioned', {
        type: 'dm',
        fromUser: { displayName: sender.display_name, username: sender.username },
        preview: content.replace(/<@user:[a-f0-9-]+>/g, '@...').slice(0, 80)
      });
    }

    const relay = req.app.get('relayNexusDirectMessage');
    if (typeof relay === 'function') {
      relay({
        nexusRecipientId: toId,
        nexusMessageId: message.id,
        sender: {
          id: fromId,
          username: sender.username,
          displayName: sender.display_name,
          avatarDataUrl: sender.has_avatar ? `/api/users/avatar/${encodeURIComponent(fromId)}` : null,
          activeServerTag: sender.server_tag || null
        },
        content
      }).catch(error => console.error('Nexus client API LINK DM relay error:', error.message));
    }
    const track = req.app.get('trackAchievement');
    track?.(fromId, ['messages_sent', 'dms_sent']);
    res.status(201).json({ message });
  } catch (error) {
    next(error);
  }
});

router.get('/servers/:serverId/channels/:channelId/messages', async (req, res, next) => {
  try {
    const { serverId, channelId } = req.params;
    const userId = req.nexusClient.userId;
    const channel = await getChannelAccess(pool, serverId, channelId, userId);
    if (!channel) return res.status(403).json({ error: 'You cannot view that channel' });
    if ((channel.channel_type || 'text') === 'voice') return res.json({ authors: {}, messages: [] });

    const { limit, before, after } = pagination(req);
    let query = `SELECT cm.id, cm.channel_id, cm.from_id, cm.content, cm.created_at, cm.reply_to_id,
      u.id, u.username, u.display_name, u.bio, u.status, (u.avatar_data IS NOT NULL) AS has_avatar,
      u.active_decoration, u.active_nameplate, u.active_color, u.active_font, u.pro_expires_at,
      u.profile_gradient_start, u.profile_gradient_end, u.profile_name_effect,
      sr.name AS role_name, sr.color AS role_color,
      rm.content AS reply_content, rm.from_id AS reply_from_id,
      ru.display_name AS reply_display_name, ru.username AS reply_username
      FROM channel_messages cm
      JOIN users u ON u.id=cm.from_id
      LEFT JOIN server_members sm ON sm.server_id=$1 AND sm.user_id=cm.from_id
      LEFT JOIN server_roles sr ON sr.id=sm.role_id
      LEFT JOIN channel_messages rm ON rm.id=cm.reply_to_id
      LEFT JOIN users ru ON ru.id=rm.from_id
      WHERE cm.channel_id=$2`;
    const params = [serverId, channelId];
    if (after) {
      params.push(after);
      query += ` AND cm.created_at >= $${params.length}`;
      query += ` ORDER BY cm.created_at ASC LIMIT $${params.length + 1}`;
    } else {
      if (before) {
        params.push(before);
        query += ` AND cm.created_at < $${params.length}`;
      }
      query += ` ORDER BY cm.created_at DESC LIMIT $${params.length + 1}`;
    }
    params.push(limit);
    const result = await pool.query(query, params);
    const rows = after ? result.rows : result.rows.reverse();
    const authors = {};
    rows.forEach(row => {
      if (!authors[row.from_id]) {
        authors[row.from_id] = {
          ...formatAuthor(row),
          roleName: row.role_name || null,
          roleColor: row.role_color || null
        };
      }
    });
    res.json({
      authors,
      messages: rows.map(row => ({
        id: row.id,
        serverId,
        channelId: row.channel_id,
        fromId: row.from_id,
        content: row.content,
        createdAt: Number(row.created_at),
        authorId: row.from_id,
        replyTo: row.reply_to_id ? {
          id: row.reply_to_id,
          fromId: row.reply_from_id || null,
          displayName: row.reply_display_name || row.reply_username || 'Unknown user',
          content: row.reply_content || '[Original message unavailable]'
        } : null
      }))
    });
  } catch (error) {
    next(error);
  }
});

async function activeServerMute(serverId, userId) {
  const now = Math.floor(Date.now() / 1000);
  const result = await pool.query(
    `SELECT muted_until FROM server_mutes
     WHERE server_id=$1 AND user_id=$2 AND muted_until>$3 LIMIT 1`,
    [serverId, userId, now]
  );
  return result.rows[0]?.muted_until || null;
}

router.post('/servers/:serverId/channels/:channelId/messages', async (req, res, next) => {
  try {
    const { serverId, channelId } = req.params;
    const userId = req.nexusClient.userId;
    const content = safeMessageContent(req.body?.content, { field: 'Message' });
    const replyToMessageId = typeof req.body?.replyToMessageId === 'string' && req.body.replyToMessageId.trim()
      ? req.body.replyToMessageId.trim()
      : null;
    const channel = await getChannelAccess(pool, serverId, channelId, userId);
    if (!channel) return res.status(403).json({ error: 'You cannot view or post in that channel' });
    if ((channel.channel_type || 'text') === 'voice') return res.status(400).json({ error: 'Voice channels do not accept text messages' });
    if (await activeGlobalMute(userId)) return res.status(403).json({ error: 'Your Nexus account is globally muted' });
    if (await activeServerMute(serverId, userId)) return res.status(403).json({ error: 'You are muted in this server' });
    const violation = await enforceGlobalSafety({ userId, content, messageType: 'channel', serverId, channelId });
    if (violation) return res.status(400).json({ error: 'Message blocked by NexusGuard global safety policy. The attempt was automatically reported.' });

    const memberResult = await pool.query(
      `SELECT sm.role, sm.role_id, sr.name AS role_name, sr.color AS role_color, sr.is_admin,
        ch.locked, ch.slowmode_seconds,
        EXISTS(
          SELECT 1 FROM server_member_roles smr
          JOIN server_roles role_grant ON role_grant.id=smr.role_id
          WHERE smr.server_id=sm.server_id AND smr.user_id=sm.user_id AND role_grant.can_mention_everyone=TRUE
        ) AS can_mention_everyone,
        u.id, u.username, u.display_name, u.bio, u.status, (u.avatar_data IS NOT NULL) AS has_avatar,
        u.active_decoration, u.active_nameplate, u.active_color, u.active_font, u.pro_expires_at,
        u.profile_gradient_start, u.profile_gradient_end, u.profile_name_effect
       FROM server_members sm
       JOIN users u ON u.id=sm.user_id
       JOIN channels ch ON ch.id=$2 AND ch.server_id=$1
       LEFT JOIN server_roles sr ON sr.id=sm.role_id
       WHERE sm.server_id=$1 AND sm.user_id=$3`,
      [serverId, channelId, userId]
    );
    const member = memberResult.rows[0];
    if (!member) return res.status(403).json({ error: 'You are no longer a member of this server' });
    const isAdmin = member.role === 'admin' || !!member.is_admin;
    if ((content.includes('<@everyone>') || content.includes('<@here>')) && !isAdmin && !member.can_mention_everyone) {
      return res.status(403).json({ error: 'You do not have permission to mention everyone' });
    }
    if (member.locked && !isAdmin) {
      const channelPermission = await pool.query(
        `SELECT allow_send FROM channel_permissions
         WHERE channel_id=$1 AND (role_id=$2 OR role_id IS NULL)
         ORDER BY role_id NULLS LAST LIMIT 1`,
        [channelId, member.role_id]
      );
      if (!channelPermission.rows[0]?.allow_send) return res.status(403).json({ error: 'You do not have permission to send messages in this channel' });
    }

    const slowmodeSeconds = Math.max(0, Number(member.slowmode_seconds || 0));
    if (slowmodeSeconds > 0 && !isAdmin) {
      const latest = await pool.query(
        'SELECT created_at FROM channel_messages WHERE channel_id=$1 AND from_id=$2 ORDER BY created_at DESC LIMIT 1',
        [channelId, userId]
      );
      const elapsed = Math.floor(Date.now() / 1000) - Number(latest.rows[0]?.created_at || 0);
      if (latest.rows.length && elapsed < slowmodeSeconds) return res.status(429).json({ error: `Slowmode is enabled. Wait ${slowmodeSeconds - elapsed}s before sending again.` });
    }

    const botConfig = await pool.query(
      `SELECT bot_enabled, bot_auto_mod, bot_block_links, bot_caps_threshold, bot_spam_window
       FROM servers WHERE id=$1`,
      [serverId]
    );
    const bot = botConfig.rows[0];
    if (bot?.bot_enabled !== false && bot?.bot_auto_mod !== false) {
      const terms = await pool.query('SELECT word FROM server_blocked_words WHERE server_id=$1 ORDER BY word ASC', [serverId]);
      const blocked = findConfiguredViolation(content, terms.rows.map(row => row.word));
      if (blocked) return res.status(400).json({ error: `Message blocked: contains blocked word "${blocked.term}".` });
      if (bot.bot_block_links && /(https?:\/\/|www\.)/i.test(content)) return res.status(400).json({ error: 'Links are blocked by server automod.' });
      const letters = content.replace(/[^a-z]/gi, '');
      const capitals = content.replace(/[^A-Z]/g, '');
      const threshold = Math.min(100, Math.max(50, Number(bot.bot_caps_threshold || 90)));
      if (letters.length >= 12 && Math.round((capitals.length / letters.length) * 100) >= threshold) return res.status(400).json({ error: 'Message blocked: too much caps.' });
      const spamKey = `${serverId}:${userId}`;
      const recent = (clientSpamTracker.get(spamKey) || []).filter(time => Date.now() - time < 6000);
      recent.push(Date.now());
      clientSpamTracker.set(spamKey, recent);
      const window = Math.min(20, Math.max(3, Number(bot.bot_spam_window || 6)));
      if (recent.length > window) return res.status(429).json({ error: 'Slow down. Automod detected message spam.' });
    }

    let replyTo = null;
    if (replyToMessageId) {
      const reply = await pool.query(
        `SELECT cm.id, cm.from_id, cm.content, u.display_name, u.username
         FROM channel_messages cm JOIN users u ON u.id=cm.from_id
         WHERE cm.id=$1 AND cm.channel_id=$2`,
        [replyToMessageId, channelId]
      );
      if (!reply.rows.length) return res.status(404).json({ error: 'Reply target was not found in this channel' });
      const row = reply.rows[0];
      replyTo = { id: row.id, fromId: row.from_id, displayName: row.display_name || row.username, content: String(row.content || '').slice(0, 160) };
    }

    const now = Math.floor(Date.now() / 1000);
    const message = {
      id: uuidv4(),
      serverId,
      channelId,
      fromId: userId,
      content,
      createdAt: now,
      isPinned: false,
      replyTo,
      mentions: await resolveChannelMentions(content, serverId),
      author: { ...formatUser(member), roleName: member.role_name || null, roleColor: member.role_color || null }
    };
    await pool.query(
      'INSERT INTO channel_messages (id, channel_id, from_id, content, created_at, reply_to_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [message.id, channelId, userId, content, now, replyToMessageId]
    );
    const io = req.app.get('io');
    io?.to(`channel:${serverId}:${channelId}`).emit('new_channel_message', message);
    const relay = req.app.get('relayNexusChannelMessage');
    if (typeof relay === 'function') {
      relay({
        serverId,
        channelId,
        nexusMessageId: message.id,
        sender: {
          id: userId,
          username: member.username,
          displayName: member.display_name,
          avatarDataUrl: member.has_avatar ? `/api/users/avatar/${encodeURIComponent(userId)}` : null
        },
        content,
        replyTo
      }).catch(error => console.error('Nexus client API LINK channel relay error:', error.message));
    }
    const track = req.app.get('trackAchievement');
    track?.(userId, ['messages_sent', 'channel_msgs']);
    res.status(201).json({ message });
  } catch (error) {
    next(error);
  }
});

router.get('/media/users/:userId/avatar', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT avatar_data, avatar_mime, avatar_pro_only, pro_expires_at
       FROM users WHERE id=$1`,
      [req.params.userId]
    );
    const avatar = result.rows[0];
    if (!avatar?.avatar_data || (avatar.avatar_pro_only && Number(avatar.pro_expires_at || 0) <= Math.floor(Date.now() / 1000))) return res.sendStatus(404);
    const data = Buffer.from(avatar.avatar_data, 'base64');
    const mime = safeStoredImageMime(avatar.avatar_mime, data);
    if (!mime) return res.sendStatus(404);
    res.setHeader('Cache-Control', 'private, max-age=3600, stale-while-revalidate=86400');
    res.type(mime).send(data);
  } catch (error) {
    next(error);
  }
});

router.get('/media/servers/:serverId/icon', async (req, res, next) => {
  try {
    const membership = await pool.query(
      'SELECT 1 FROM server_members WHERE server_id=$1 AND user_id=$2',
      [req.params.serverId, req.nexusClient.userId]
    );
    if (!membership.rows.length) return res.status(403).json({ error: 'You are not a member of that server' });
    const result = await pool.query('SELECT icon_data, icon_mime FROM servers WHERE id=$1', [req.params.serverId]);
    const icon = result.rows[0];
    if (!icon?.icon_data) return res.sendStatus(404);
    const data = Buffer.from(icon.icon_data, 'base64');
    const mime = safeStoredImageMime(icon.icon_mime, data);
    if (!mime) return res.sendStatus(404);
    res.setHeader('Cache-Control', 'private, max-age=3600, stale-while-revalidate=86400');
    res.type(mime).send(data);
  } catch (error) {
    next(error);
  }
});

router.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  console.error('Nexus client API error:', error.message);
  const status = Number(error.statusCode) || (/must be text|must be 1-|unsupported characters|cannot contain HTML/i.test(error.message || '') ? 400 : 500);
  res.status(status).json({ error: status >= 400 && status < 500 ? error.message : 'Nexus client request failed' });
});

module.exports = router;
