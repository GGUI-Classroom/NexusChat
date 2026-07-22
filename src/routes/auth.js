const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../models/db');
const { avatarUrl } = require('../utils/avatar');
const { getActiveReportForUser } = require('../utils/systemReport');
const { requestIp, requestDeviceId } = require('../utils/ip');
const { getCurrentTos, getUserTosState } = require('../utils/tosPolicy');
const { safeDisplayName } = require('../utils/inputSafety');
const {
  SESSION_SECURITY_VERSION,
  ensureCsrfToken,
  rotateCsrfToken,
  bindDeviceSessionToRequest,
  revokeCurrentDeviceSession,
  getUserSessionVersion
} = require('../utils/security');

const router = express.Router();
const DEFAULT_SERVER_INVITE_CODE = 'GPFA9B32';
const authAttemptBuckets = new Map();

// Auth responses contain per-session state. They must never be served from an
// HTTP cache, otherwise the client can keep an obsolete CSRF token.
router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Vary', 'Cookie');
  next();
});

function allowAuthAttempt(req, action) {
  const now = Date.now();
  const key = `${action}:${requestIp(req) || 'unknown'}`;
  const recent = (authAttemptBuckets.get(key) || []).filter(time => now - time < 15 * 60 * 1000);
  if (recent.length >= 15) {
    authAttemptBuckets.set(key, recent);
    return false;
  }
  recent.push(now);
  authAttemptBuckets.set(key, recent);
  return true;
}

function establishFreshSession(req, userId, tosAcceptedVersion = 0) {
  return new Promise((resolve, reject) => {
    req.session.regenerate(async error => {
      if (error) return reject(error);
      try {
        req.session.userId = userId;
        req.session.authVersion = SESSION_SECURITY_VERSION;
        req.session.authIssuedAt = Date.now();
        req.session.userSessionVersion = await getUserSessionVersion(userId);
        req.session.tosAcceptedVersion = tosAcceptedVersion;
        rotateCsrfToken(req);
        const deviceSession = await bindDeviceSessionToRequest(req, userId);
        req.session.save(saveError => saveError ? reject(saveError) : resolve(deviceSession));
      } catch (setupError) {
        reject(setupError);
      }
    });
  });
}

router.get('/csrf', (req, res, next) => {
  const csrfToken = ensureCsrfToken(req);
  // Persist a freshly created anonymous session before the browser makes its
  // next write request. This avoids a race on a first login or registration.
  req.session.save(error => {
    if (error) return next(error);
    res.json({ csrfToken });
  });
});

router.post('/register', async (req, res) => {
  const { username, displayName, password } = req.body;
  if (!allowAuthAttempt(req, 'register')) return res.status(429).json({ error: 'Too many registration attempts. Try again in a few minutes.' });
  if (typeof username !== 'string' || typeof displayName !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'All fields must be text' });
  }
  if (!username || !displayName || !password)
    return res.status(400).json({ error: 'All fields required' });
  if (username.length < 3 || username.length > 32)
    return res.status(400).json({ error: 'Username must be 3-32 characters' });
  if (!/^[a-zA-Z0-9_.\-]+$/.test(username))
    return res.status(400).json({ error: 'Username may only contain letters, numbers, _, ., -' });
  let safeName;
  try {
    safeName = safeDisplayName(displayName);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  if (password.length < 8 || password.length > 128)
    return res.status(400).json({ error: 'Password must be 8-128 characters' });
  try {
    const ip = requestIp(req);
    const deviceId = requestDeviceId(req);
    if (deviceId) {
      const banned = await pool.query('SELECT reason FROM ip_bans WHERE device_id=$1 AND active=TRUE LIMIT 1', [deviceId]);
      if (banned.rows.length) return res.status(403).json({ error: 'This device is banned from Nexus' });
    }
    const exists = await pool.query('SELECT id FROM users WHERE LOWER(username)=LOWER($1)', [username]);
    if (exists.rows.length) return res.status(409).json({ error: 'Username already taken' });
    const hash = await bcrypt.hash(password, 12);
    const id = uuidv4();
    await pool.query('INSERT INTO users (id, username, display_name, password_hash, last_ip, last_device_id, tutorial_completed) VALUES ($1,$2,$3,$4,$5,$6,FALSE)',
      [id, username.toLowerCase(), safeName, hash, ip || null, deviceId || null]);
    const defaultServer = await pool.query(
      'SELECT id FROM servers WHERE UPPER(invite_code)=UPPER($1) LIMIT 1',
      [DEFAULT_SERVER_INVITE_CODE]
    );
    if (defaultServer.rows[0]) {
      await pool.query(
        `INSERT INTO server_members (id, server_id, user_id)
         VALUES ($1,$2,$3) ON CONFLICT (server_id, user_id) DO NOTHING`,
        [uuidv4(), defaultServer.rows[0].id, id]
      );
    }
    const deviceSession = await establishFreshSession(req, id, 0);
    const systemReport = await getActiveReportForUser(pool, id);
    const tos = await getCurrentTos();
    return res.json({ success: true, csrfToken: ensureCsrfToken(req), deviceToken: deviceSession?.token || null, systemReport, tosRequired: true, tos, user: { id, username: username.toLowerCase(), displayName: safeName, bio: null, activeDecoration: null, activeColor: null, activeFont: null, activeRingtone: null, developerMode: false, tutorialCompleted: false } });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!allowAuthAttempt(req, 'login')) return res.status(429).json({ error: 'Too many sign-in attempts. Try again in a few minutes.' });
  if (typeof username !== 'string' || typeof password !== 'string') return res.status(400).json({ error: 'All fields must be text' });
  if (!username || !password) return res.status(400).json({ error: 'All fields required' });
  if (username.length > 32 || password.length > 128) return res.status(400).json({ error: 'Invalid credentials' });
  try {
    const ip = requestIp(req);
    const deviceId = requestDeviceId(req);
    if (deviceId) {
      const banned = await pool.query('SELECT reason FROM ip_bans WHERE device_id=$1 AND active=TRUE LIMIT 1', [deviceId]);
      if (banned.rows.length) return res.status(403).json({ error: 'This device is banned from Nexus' });
    }
    const r = await pool.query(
      `SELECT id, username, display_name, password_hash, bio, (avatar_data IS NOT NULL) AS has_avatar,
        active_decoration, active_nameplate, active_color, active_font, active_ringtone, pro_expires_at,
        profile_card_style, profile_gradient_start, profile_gradient_end, profile_name_effect, profile_effect,
        (profile_banner_data IS NOT NULL) AS has_profile_banner, tutorial_completed, accepted_tos_version, developer_mode,
        app_theme_base, app_theme_primary, app_theme_secondary, app_theme_style, app_theme_motion
       FROM users WHERE LOWER(username)=LOWER($1)`,
      [username]
    );
    const user = r.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    // Check suspension
    const susp = await pool.query(
      `SELECT suspended_until, reason FROM suspensions WHERE user_id=$1 AND active=TRUE AND suspended_until > EXTRACT(EPOCH FROM NOW())::BIGINT ORDER BY created_at DESC LIMIT 1`,
      [user.id]
    );
    if (susp.rows.length) {
      const until = parseInt(susp.rows[0].suspended_until);
      return res.status(403).json({
        error: 'Account suspended',
        suspended: true,
        suspendedUntil: until,
        suspendedReason: susp.rows[0].reason || null
      });
    }

    const deviceSession = await establishFreshSession(req, user.id, parseInt(user.accepted_tos_version, 10) || 0);
    await pool.query('UPDATE users SET last_ip=$1, last_device_id=$2 WHERE id=$3', [ip || null, deviceId || null, user.id]);
    const systemReport = await getActiveReportForUser(pool, user.id);
    const tosState = await getUserTosState(user.id);
    return res.json({ success: true, csrfToken: ensureCsrfToken(req), deviceToken: deviceSession?.token || null, systemReport, tosRequired: tosState.required, tos: tosState.required ? tosState.policy : null, user: {
      id: user.id, username: user.username, displayName: user.display_name,
      avatarDataUrl: avatarUrl(user.id, !!user.has_avatar),
      bio: user.bio || null,
      activeDecoration: user.active_decoration || null,
      activeNameplate: user.active_nameplate || null,
      activeColor: user.active_color || null,
        activeFont: user.active_font || null,
      activeRingtone: user.active_ringtone || null,
      proActive: (user.pro_expires_at || 0) > Math.floor(Date.now() / 1000), profileCardStyle: user.profile_card_style || 'soft', proGradientStart: user.profile_gradient_start || '#5865f2', proGradientEnd: user.profile_gradient_end || '#a855f7', proNameEffect: user.profile_name_effect || 'none', profileEffect: user.profile_effect || 'none', profileBannerUrl: user.has_profile_banner && (user.pro_expires_at || 0) > Math.floor(Date.now() / 1000) ? `/api/users/banner/${user.id}` : null, appTheme: { base: user.app_theme_base || 'dark', primary: user.app_theme_primary || '#5b6ef5', secondary: user.app_theme_secondary || '#a855f7', style: user.app_theme_style || 'gradient', motion: !!user.app_theme_motion }, developerMode: !!user.developer_mode, tutorialCompleted: user.tutorial_completed !== false, acceptedTosVersion: tosState.acceptedVersion
    }});
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});

router.post('/logout', async (req, res) => {
  try {
    await revokeCurrentDeviceSession(req);
  } catch (error) {
    console.error('Device session revoke failed:', error.message);
  }
  if (req.session) {
    delete req.session.csrfToken;
    delete req.session.deviceSessionId;
    delete req.session.deviceId;
    delete req.session.deviceTokenHash;
  }
  req.session.destroy(() => {
    res.clearCookie('nexus.sid');
    res.json({ success: true });
  });
});

router.get('/me', async (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  try {
    const susp = await pool.query(
      `SELECT suspended_until, reason FROM suspensions
       WHERE user_id=$1 AND active=TRUE AND suspended_until > EXTRACT(EPOCH FROM NOW())::BIGINT
       ORDER BY created_at DESC LIMIT 1`,
      [req.session.userId]
    );
    if (susp.rows.length) {
      return res.json({
        user: null,
        suspended: true,
        suspendedUntil: parseInt(susp.rows[0].suspended_until),
        suspendedReason: susp.rows[0].reason || null
      });
    }

    const r = await pool.query(
      'SELECT u.id, u.username, u.display_name, (u.avatar_data IS NOT NULL) AS has_avatar, u.bio, u.active_decoration, u.active_nameplate, u.active_color, u.active_font, u.active_ringtone, u.pro_expires_at, u.profile_card_style, u.profile_gradient_start, u.profile_gradient_end, u.profile_name_effect, u.profile_effect, (u.profile_banner_data IS NOT NULL) AS has_profile_banner, u.tutorial_completed, u.accepted_tos_version, u.developer_mode, u.app_theme_base, u.app_theme_primary, u.app_theme_secondary, u.app_theme_style, u.app_theme_motion, s.id AS tag_server_id, s.name AS tag_server_name, s.invite_code AS tag_invite_code, s.server_tag, s.tag_background, s.tag_private FROM users u LEFT JOIN servers s ON s.id=u.active_server_tag_id WHERE u.id=$1',
      [req.session.userId]
    );
    const user = r.rows[0];
    if (!user) return res.json({ user: null });
    req.session.tosAcceptedVersion = parseInt(user.accepted_tos_version, 10) || 0;
    const systemReport = await getActiveReportForUser(pool, user.id);
    const tosState = await getUserTosState(user.id);
    return res.json({ csrfToken: ensureCsrfToken(req), systemReport, tosRequired: tosState.required, tos: tosState.required ? tosState.policy : null, user: {
      id: user.id, username: user.username, displayName: user.display_name,
      avatarDataUrl: avatarUrl(user.id, !!user.has_avatar),
      bio: user.bio || null,
      activeDecoration: user.active_decoration || null,
      activeNameplate: user.active_nameplate || null,
      activeColor: user.active_color || null,
      activeColor: user.active_color || null,
        activeFont: user.active_font || null,
      activeRingtone: user.active_ringtone || null,
      proActive: (user.pro_expires_at || 0) > Math.floor(Date.now() / 1000), profileCardStyle: user.profile_card_style || 'soft', proGradientStart: user.profile_gradient_start || '#5865f2', proGradientEnd: user.profile_gradient_end || '#a855f7', proNameEffect: user.profile_name_effect || 'none', profileEffect: user.profile_effect || 'none', profileBannerUrl: user.has_profile_banner && (user.pro_expires_at || 0) > Math.floor(Date.now() / 1000) ? `/api/users/banner/${user.id}` : null, appTheme: { base: user.app_theme_base || 'dark', primary: user.app_theme_primary || '#5b6ef5', secondary: user.app_theme_secondary || '#a855f7', style: user.app_theme_style || 'gradient', motion: !!user.app_theme_motion }, activeServerTag: user.server_tag || null, activeServerTagBackground: user.tag_background || '#5865f2', activeServerTagServerId: user.tag_server_id || null, activeServerTagServerName: user.tag_private ? null : (user.tag_server_name || null), activeServerTagInviteCode: user.tag_private ? null : (user.tag_invite_code || null), activeServerTagPrivate: !!user.tag_private, developerMode: !!user.developer_mode, tutorialCompleted: user.tutorial_completed !== false, acceptedTosVersion: tosState.acceptedVersion
    }});
  } catch (e) {
    return res.status(500).json({ error: 'Server error' });
  }
});

router.get('/tos', async (req, res) => {
  try {
    const policy = await getCurrentTos();
    if (!req.session.userId) return res.json({ required: true, tos: policy });
    const state = await getUserTosState(req.session.userId);
    res.json({ required: state.required, acceptedVersion: state.acceptedVersion, tos: policy });
  } catch (error) {
    res.status(503).json({ error: 'Terms of Service are temporarily unavailable' });
  }
});

router.post('/tos/accept', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  const policy = await getCurrentTos();
  const version = parseInt(req.body.version, 10);
  if (req.body.accepted !== true || version !== policy.version) {
    return res.status(409).json({ error: 'The Terms of Service changed. Review the latest version.', tosRequired: true, tos: policy });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE users
       SET accepted_tos_version=$1, accepted_tos_at=EXTRACT(EPOCH FROM NOW())::BIGINT
       WHERE id=$2`,
      [policy.version, req.session.userId]
    );
    await client.query(
      `INSERT INTO tos_acceptances (id, user_id, version)
       VALUES ($1,$2,$3) ON CONFLICT (user_id, version) DO NOTHING`,
      [uuidv4(), req.session.userId, policy.version]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  req.session.tosAcceptedVersion = policy.version;
  res.json({ success: true, acceptedVersion: policy.version });
});

module.exports = router;
