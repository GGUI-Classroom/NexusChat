const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../models/db');
const { avatarUrl } = require('../utils/avatar');
const { getActiveReportForUser } = require('../utils/systemReport');
const { requestIp, requestDeviceId } = require('../utils/ip');

const router = express.Router();
const DEFAULT_SERVER_INVITE_CODE = 'GPFA9B32';

router.post('/register', async (req, res) => {
  const { username, displayName, password } = req.body;
  if (!username || !displayName || !password)
    return res.status(400).json({ error: 'All fields required' });
  if (username.length < 3 || username.length > 32)
    return res.status(400).json({ error: 'Username must be 3-32 characters' });
  if (!/^[a-zA-Z0-9_.\-]+$/.test(username))
    return res.status(400).json({ error: 'Username may only contain letters, numbers, _, ., -' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
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
      [id, username.toLowerCase(), displayName, hash, ip || null, deviceId || null]);
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
    req.session.userId = id;
    const systemReport = await getActiveReportForUser(pool, id);
    return res.json({ success: true, systemReport, user: { id, username: username.toLowerCase(), displayName, bio: null, activeDecoration: null, activeColor: null, activeFont: null, activeRingtone: null, tutorialCompleted: false } });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'All fields required' });
  try {
    const ip = requestIp(req);
    const deviceId = requestDeviceId(req);
    if (deviceId) {
      const banned = await pool.query('SELECT reason FROM ip_bans WHERE device_id=$1 AND active=TRUE LIMIT 1', [deviceId]);
      if (banned.rows.length) return res.status(403).json({ error: 'This device is banned from Nexus' });
    }
    const r = await pool.query(
      `SELECT id, username, display_name, password_hash, bio, (avatar_data IS NOT NULL) AS has_avatar,
        active_decoration, active_color, active_font, active_ringtone, pro_expires_at,
        profile_gradient_start, profile_gradient_end, profile_name_effect, tutorial_completed
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

    req.session.userId = user.id;
    await pool.query('UPDATE users SET last_ip=$1, last_device_id=$2 WHERE id=$3', [ip || null, deviceId || null, user.id]);
    const systemReport = await getActiveReportForUser(pool, user.id);
    return res.json({ success: true, systemReport, user: {
      id: user.id, username: user.username, displayName: user.display_name,
      avatarDataUrl: avatarUrl(user.id, !!user.has_avatar),
      bio: user.bio || null,
      activeDecoration: user.active_decoration || null,
      activeColor: user.active_color || null,
        activeFont: user.active_font || null,
      activeRingtone: user.active_ringtone || null,
      proActive: (user.pro_expires_at || 0) > Math.floor(Date.now() / 1000), proGradientStart: user.profile_gradient_start || '#5865f2', proGradientEnd: user.profile_gradient_end || '#a855f7', proNameEffect: user.profile_name_effect || 'none', tutorialCompleted: user.tutorial_completed !== false
    }});
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
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
      'SELECT u.id, u.username, u.display_name, (u.avatar_data IS NOT NULL) AS has_avatar, u.bio, u.active_decoration, u.active_color, u.active_font, u.active_ringtone, u.pro_expires_at, u.profile_gradient_start, u.profile_gradient_end, u.profile_name_effect, u.tutorial_completed, s.id AS tag_server_id, s.name AS tag_server_name, s.invite_code AS tag_invite_code, s.server_tag, s.tag_background FROM users u LEFT JOIN servers s ON s.id=u.active_server_tag_id WHERE u.id=$1',
      [req.session.userId]
    );
    const user = r.rows[0];
    if (!user) return res.json({ user: null });
    const systemReport = await getActiveReportForUser(pool, user.id);
    return res.json({ systemReport, user: {
      id: user.id, username: user.username, displayName: user.display_name,
      avatarDataUrl: avatarUrl(user.id, !!user.has_avatar),
      bio: user.bio || null,
      activeDecoration: user.active_decoration || null,
      activeColor: user.active_color || null,
      activeColor: user.active_color || null,
        activeFont: user.active_font || null,
      activeRingtone: user.active_ringtone || null,
      proActive: (user.pro_expires_at || 0) > Math.floor(Date.now() / 1000), proGradientStart: user.profile_gradient_start || '#5865f2', proGradientEnd: user.profile_gradient_end || '#a855f7', proNameEffect: user.profile_name_effect || 'none', activeServerTag: user.server_tag || null, activeServerTagBackground: user.tag_background || '#5865f2', activeServerTagServerId: user.tag_server_id || null, activeServerTagServerName: user.tag_server_name || null, activeServerTagInviteCode: user.tag_invite_code || null, tutorialCompleted: user.tutorial_completed !== false
    }});
  } catch (e) {
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
