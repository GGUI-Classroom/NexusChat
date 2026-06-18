const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../models/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
const NEXUS_GUARD_AVATAR = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5NiA5NiI+PGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSJnIiB4MT0iMCIgeTE9IjAiIHgyPSIxIiB5Mj0iMSI+PHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjMGYxNzJhIi8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjMWUyOTNiIi8+PC9saW5lYXJHcmFkaWVudD48bGluZWFyR3JhZGllbnQgaWQ9ImEiIHgxPSIwIiB5MT0iMCIgeDI9IjEiIHkyPSIxIj48c3RvcCBvZmZzZXQ9IjAiIHN0b3AtY29sb3I9IiNmNTllMGIiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiNmOTczMTYiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz48Y2lyY2xlIGN4PSI0OCIgY3k9IjQ4IiByPSI0NiIgZmlsbD0idXJsKCNnKSIvPjxwYXRoIGQ9Ik00OCAxNmwyNCA4djIyYzAgMTgtMTAgMzAtMjQgMzYtMTQtNi0yNC0xOC0yNC0zNlYyNHoiIGZpbGw9InVybCgjYSkiLz48cGF0aCBkPSJNNDggMjZsMTQgNXYxNWMwIDExLTYgMTktMTQgMjMtOC00LTE0LTEyLTE0LTIzVjMxeiIgZmlsbD0iIzExMTgyNyIgb3BhY2l0eT0iLjY1Ii8+PGNpcmNsZSBjeD0iNDgiIGN5PSI0NSIgcj0iNyIgZmlsbD0iI2ZkZTY4YSIvPjxwYXRoIGQ9Ik0zNiA1OWgyNHY1SDM2eiIgZmlsbD0iI2ZkZTY4YSIvPjwvc3ZnPg==';
const NEXUS_GUARD_ID = '00000000-0000-0000-0000-000000000001';
const ADMIN_QR_REQUIRED_CODE = process.env.ADMIN_QR_CODE || 'JJKLOL12DAJWUDIUWQ';
const NON_REMOVABLE_ADMIN_ID = '537b58c9-b9cd-4239-b0e6-2f862c30ac01';

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
    [NEXUS_GUARD_ID, NEXUS_GUARD_AVATAR.replace(/^data:image\/svg\+xml;base64,/, '')]
  );
}

async function sendNexusGuardDM(req, userId, content) {
  await ensureNexusGuardExists();
  const now = Math.floor(Date.now() / 1000);
  await pool.query(
    'INSERT INTO messages (id, from_id, to_id, content, created_at) VALUES ($1,$2,$3,$4,$5)',
    [uuidv4(), NEXUS_GUARD_ID, userId, content, now]
  );

  if (req.io) {
    req.io.to(`user:${userId}`).emit('new_message', {
      id: uuidv4(),
      fromId: NEXUS_GUARD_ID,
      toId: userId,
      content,
      createdAt: now,
      author: {
        username: 'nexusguard',
        displayName: 'NexusGuard',
        avatarDataUrl: NEXUS_GUARD_AVATAR,
        activeDecoration: null,
        activeColor: '#f4b942',
        activeFont: null
      }
    });
  }
}

// Hardcoded admin user IDs
const ADMIN_IDS = new Set([
  '537b58c9-b9cd-4239-b0e6-2f862c30ac01',
]);

async function isGlobalAdmin(userId) {
  if (!userId) return false;
  if (ADMIN_IDS.has(userId)) return true;
  const r = await pool.query('SELECT id FROM admin_users WHERE user_id=$1', [userId]);
  return !!r.rows.length;
}

async function requireAdmin(req, res, next) {
  try {
    if (!(await isGlobalAdmin(req.session.userId))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    next();
  } catch (e) {
    console.error('requireAdmin failed:', e.message);
    return res.status(500).json({ error: 'Admin check failed' });
  }
}
router.use(requireAdmin);

// Check if current user is admin (used by frontend on load)
router.get('/check', (req, res) => {
  res.json({ isAdmin: true });
});

// Get all users
router.get('/users', async (req, res) => {
  const { search } = req.query;
  let q = `SELECT u.id, u.username, u.display_name, u.avatar_data, u.avatar_mime,
    (SELECT s.suspended_until FROM suspensions s
     WHERE s.user_id=u.id AND s.active=TRUE AND s.suspended_until > EXTRACT(EPOCH FROM NOW())::BIGINT
     ORDER BY s.created_at DESC LIMIT 1) as suspended_until
    FROM users u`;
  const params = [];
  if (search) {
    params.push('%' + search.toLowerCase() + '%');
    q += ` WHERE LOWER(u.username) LIKE $1 OR LOWER(u.display_name) LIKE $1`;
  }
  q += ` ORDER BY u.username ASC LIMIT 50`;
  const r = await pool.query(q, params);
  res.json({ users: r.rows.map(u => ({
    id: u.id, username: u.username, displayName: u.display_name,
    avatarDataUrl: u.avatar_data ? `data:${u.avatar_mime};base64,${u.avatar_data}` : null,
    suspendedUntil: u.suspended_until ? parseInt(u.suspended_until) : null,
  }))});
});

// Suspend a user
router.post('/suspend', async (req, res) => {
  const { username, duration, unit, reason } = req.body;
  if (!username || !duration || !unit) return res.status(400).json({ error: 'Missing fields' });

  const user = await pool.query('SELECT id, username FROM users WHERE LOWER(username)=LOWER($1)', [username]);
  if (!user.rows.length) return res.status(404).json({ error: 'User not found' });
  if (ADMIN_IDS.has(user.rows[0].id)) return res.status(403).json({ error: 'Cannot suspend an admin' });

  const multipliers = { minutes: 60, hours: 3600, days: 86400 };
  const seconds = parseInt(duration) * (multipliers[unit] || 60);
  const until = Math.floor(Date.now() / 1000) + seconds;

  // Deactivate any existing suspension
  await pool.query('UPDATE suspensions SET active=FALSE WHERE user_id=$1', [user.rows[0].id]);
  await pool.query(
    'INSERT INTO suspensions (id, user_id, suspended_by, reason, suspended_until) VALUES ($1,$2,$3,$4,$5)',
    [uuidv4(), user.rows[0].id, req.session.userId, reason || null, until]
  );

  if (req.io) {
    req.io.to(`user:${user.rows[0].id}`).emit('account_suspended', {
      suspendedUntil: until,
      reason: reason || null
    });
  }

  try {
    await sendNexusGuardDM(
      req,
      user.rows[0].id,
      `[NexusGuard] Your account was suspended until ${new Date(until * 1000).toLocaleString()}. Reason: ${reason || 'No reason provided'}`
    );
  } catch (dmErr) {
    console.error('NexusGuard suspension DM failed:', dmErr.message);
  }

  res.json({ success: true, username: user.rows[0].username, userId: user.rows[0].id, suspendedUntil: until, reason: reason || null });
});

// Unsuspend a user
router.post('/unsuspend', async (req, res) => {
  const { username } = req.body;
  const user = await pool.query('SELECT id FROM users WHERE LOWER(username)=LOWER($1)', [username]);
  if (!user.rows.length) return res.status(404).json({ error: 'User not found' });
  await pool.query('UPDATE suspensions SET active=FALSE WHERE user_id=$1', [user.rows[0].id]);
  res.json({ success: true });
});

// Get all servers
router.get('/servers', async (req, res) => {
  const r = await pool.query(`
    SELECT s.id, s.name, s.icon_data, s.icon_mime, s.invite_code,
      u.username as owner_username, u.display_name as owner_display_name,
      (SELECT COUNT(*) FROM server_members sm WHERE sm.server_id=s.id) as member_count
    FROM servers s JOIN users u ON u.id=s.owner_id
    ORDER BY s.name ASC
  `);
  res.json({ servers: r.rows.map(s => ({
    id: s.id, name: s.name, inviteCode: s.invite_code,
    iconDataUrl: s.icon_data ? `data:${s.icon_mime};base64,${s.icon_data}` : null,
    ownerUsername: s.owner_username, ownerDisplayName: s.owner_display_name,
    memberCount: parseInt(s.member_count),
  }))});
});

// Join a server as admin (force join with admin role)
router.post('/servers/:serverId/join', async (req, res) => {
  const { serverId } = req.params;
  const already = await pool.query('SELECT id FROM server_members WHERE server_id=$1 AND user_id=$2', [serverId, req.session.userId]);
  if (already.rows.length) {
    // Already a member — promote to admin role
    await pool.query("UPDATE server_members SET role='admin' WHERE server_id=$1 AND user_id=$2", [serverId, req.session.userId]);
    return res.json({ success: true, promoted: true });
  }
  await pool.query("INSERT INTO server_members (id, server_id, user_id, role) VALUES ($1,$2,$3,'admin')", [uuidv4(), serverId, req.session.userId]);
  const s = await pool.query('SELECT * FROM servers WHERE id=$1', [serverId]);
  res.json({ success: true, server: s.rows[0] });
});

// Delete a server
router.delete('/servers/:serverId', async (req, res) => {
  await pool.query('DELETE FROM servers WHERE id=$1', [req.params.serverId]);
  res.json({ success: true });
});

// Get suspension history
router.get('/suspensions', async (req, res) => {
  const r = await pool.query(`
    SELECT s.id, s.suspended_until, s.created_at, s.active, s.reason,
      u.username, u.display_name,
      a.username as admin_username
    FROM suspensions s
    JOIN users u ON u.id=s.user_id
    JOIN users a ON a.id=s.suspended_by
    ORDER BY s.created_at DESC LIMIT 50
  `);
  res.json({ suspensions: r.rows.map(s => ({
    id: s.id, username: s.username, displayName: s.display_name,
    adminUsername: s.admin_username, reason: s.reason,
    suspendedUntil: parseInt(s.suspended_until),
    createdAt: parseInt(s.created_at), active: s.active,
  }))});
});

// Get user info (nexals + servers)
router.get('/users/:userId', async (req, res) => {
  const { userId } = req.params;
  const userRes = await pool.query(
    'SELECT id, username, display_name, nexals, active_font FROM users WHERE id=$1', [userId]
  );
  if (!userRes.rows.length) return res.status(404).json({ error: 'User not found' });
  const u = userRes.rows[0];

  const serversRes = await pool.query(`
    SELECT s.id, s.name, s.icon_data, s.icon_mime, sm.role,
      (SELECT COUNT(*) FROM server_members sm2 WHERE sm2.server_id=s.id) as member_count
    FROM server_members sm
    JOIN servers s ON s.id=sm.server_id
    WHERE sm.user_id=$1
    ORDER BY s.name ASC
  `, [userId]);

  const suspRes = await pool.query(
    'SELECT suspended_until, reason FROM suspensions WHERE user_id=$1 AND active=TRUE AND suspended_until > EXTRACT(EPOCH FROM NOW())::BIGINT ORDER BY created_at DESC LIMIT 1',
    [userId]
  );

  const ownedDecos = await pool.query('SELECT decoration_id FROM user_decorations WHERE user_id=$1', [userId]);
  const ownedSet = new Set(ownedDecos.rows.map(r => r.decoration_id));
  const { DECORATIONS } = require('./shop');
  const ownedFonts = await pool.query('SELECT font_id FROM user_fonts WHERE user_id=$1', [userId]);
  const ownedFontSet = new Set(ownedFonts.rows.map(r => r.font_id));
  const { FONTS } = require('./colors');

  res.json({
    id: u.id, username: u.username, displayName: u.display_name,
    nexals: u.nexals,
    suspendedUntil: suspRes.rows[0] ? parseInt(suspRes.rows[0].suspended_until) : null,
    suspendReason: suspRes.rows[0]?.reason || null,
    servers: serversRes.rows.map(s => ({
      id: s.id, name: s.name, role: s.role, memberCount: parseInt(s.member_count),
      iconDataUrl: s.icon_data ? `data:${s.icon_mime};base64,${s.icon_data}` : null,
    })),
    decorations: DECORATIONS.map(d => ({ id: d.id, name: d.name, rarity: d.rarity, owned: ownedSet.has(d.id) })),
    fonts: FONTS.map(f => ({ id: f.id, name: f.name, owned: ownedFontSet.has(f.id), active: u.active_font === f.id })),
  });
});

// Change user password
router.patch('/users/:userId/password', async (req, res) => {
  const { userId } = req.params;
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash(password, 12);
  await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, userId]);
  res.json({ success: true });
});

// Change username/display name
router.patch('/users/:userId/identity', async (req, res) => {
  const { userId } = req.params;
  const { username, displayName } = req.body;
  if (username) {
    if (!/^[a-zA-Z0-9_.\-]+$/.test(username)) return res.status(400).json({ error: 'Invalid username characters' });
    const exists = await pool.query('SELECT id FROM users WHERE LOWER(username)=LOWER($1) AND id!=$2', [username, userId]);
    if (exists.rows.length) return res.status(409).json({ error: 'Username already taken' });
    await pool.query('UPDATE users SET username=$1 WHERE id=$2', [username.toLowerCase(), userId]);
  }
  if (displayName) {
    await pool.query('UPDATE users SET display_name=$1 WHERE id=$2', [displayName, userId]);
  }
  const r = await pool.query('SELECT username, display_name FROM users WHERE id=$1', [userId]);
  res.json({ success: true, username: r.rows[0].username, displayName: r.rows[0].display_name });
});

// Give decoration to user
router.post('/users/:userId/decorations', async (req, res) => {
  const { userId } = req.params;
  const { decorationId } = req.body;
  const already = await pool.query('SELECT id FROM user_decorations WHERE user_id=$1 AND decoration_id=$2', [userId, decorationId]);
  if (already.rows.length) return res.status(409).json({ error: 'User already owns this decoration' });
  await pool.query('INSERT INTO user_decorations (id, user_id, decoration_id) VALUES ($1,$2,$3)', [require('uuid').v4(), userId, decorationId]);
  res.json({ success: true });
});

// Remove decoration from user
router.delete('/users/:userId/decorations/:decorationId', async (req, res) => {
  const { userId, decorationId } = req.params;
  await pool.query('UPDATE users SET active_decoration=NULL WHERE id=$1 AND active_decoration=$2', [userId, decorationId]);
  await pool.query('DELETE FROM user_decorations WHERE user_id=$1 AND decoration_id=$2', [userId, decorationId]);
  res.json({ success: true });
});

router.post('/users/:userId/fonts', async (req, res) => {
  const { userId } = req.params;
  const { fontId } = req.body;
  const { FONTS } = require('./colors');
  if (!FONTS.find(f => f.id === fontId)) return res.status(404).json({ error: 'Unknown font' });
  const already = await pool.query('SELECT id FROM user_fonts WHERE user_id=$1 AND font_id=$2', [userId, fontId]);
  if (already.rows.length) return res.status(409).json({ error: 'User already owns this font' });
  await pool.query('INSERT INTO user_fonts (id, user_id, font_id) VALUES ($1,$2,$3)', [require('uuid').v4(), userId, fontId]);
  res.json({ success: true });
});

router.delete('/users/:userId/fonts/:fontId', async (req, res) => {
  const { userId, fontId } = req.params;
  await pool.query('UPDATE users SET active_font=NULL WHERE id=$1 AND active_font=$2', [userId, fontId]);
  await pool.query('DELETE FROM user_fonts WHERE user_id=$1 AND font_id=$2', [userId, fontId]);
  res.json({ success: true });
});

// Update user nexals
router.patch('/users/:userId/nexals', async (req, res) => {
  const { userId } = req.params;
  const { nexals } = req.body;
  if (nexals === undefined || isNaN(parseInt(nexals))) return res.status(400).json({ error: 'Invalid nexals value' });
  await pool.query('UPDATE users SET nexals=$1 WHERE id=$2', [Math.max(0, parseInt(nexals)), userId]);
  const r = await pool.query('SELECT nexals FROM users WHERE id=$1', [userId]);
  res.json({ success: true, nexals: r.rows[0].nexals });
});

router.post('/users/:userId/warn', async (req, res) => {
  const { userId } = req.params;
  const reason = String(req.body.reason || '').trim() || 'No reason provided';
  const target = await pool.query('SELECT id, username FROM users WHERE id=$1', [userId]);
  if (!target.rows.length) return res.status(404).json({ error: 'User not found' });
  if (ADMIN_IDS.has(target.rows[0].id)) return res.status(403).json({ error: 'Cannot warn an admin' });

  const content = `[NexusGuard] You have received an admin warning. Reason: ${reason}`;
  await sendNexusGuardDM(req, userId, content);

  res.json({ success: true });
});

// Nexus client controls (only affects Nexus client UI, not system screen)
router.post('/users/:userId/client-control', async (req, res) => {
  const { userId } = req.params;
  const action = String(req.body.action || '').trim().toLowerCase();
  const message = String(req.body.message || '').trim().slice(0, 300);
  const view = String(req.body.view || '').trim().toLowerCase();

  const allowedActions = new Set(['lock', 'unlock', 'notify', 'popup', 'force_view']);
  if (!allowedActions.has(action)) return res.status(400).json({ error: 'Invalid action' });

  if (action === 'lock' && !message) return res.status(400).json({ error: 'Lock message is required' });
  if ((action === 'notify' || action === 'popup') && !message) return res.status(400).json({ error: 'Message is required' });
  if (action === 'force_view') {
    const allowedViews = new Set(['friends', 'dms', 'servers', 'shop', 'achievements', 'colors']);
    if (!allowedViews.has(view)) return res.status(400).json({ error: 'Invalid view target' });
  }

  const target = await pool.query('SELECT id, username FROM users WHERE id=$1', [userId]);
  if (!target.rows.length) return res.status(404).json({ error: 'User not found' });

  const sockets = req.userSockets && req.userSockets.get(userId);
  if (!sockets || !sockets.size) return res.status(400).json({ error: 'User is not online right now' });

  const actor = await pool.query('SELECT username, display_name FROM users WHERE id=$1', [req.session.userId]);
  const actorRow = actor.rows[0] || {};

  if (action === 'lock') {
    const existing = await pool.query('SELECT id FROM user_client_state WHERE user_id=$1', [userId]);
    if (existing.rows.length) {
      await pool.query(
        'UPDATE user_client_state SET is_paused=TRUE, pause_message=$1, updated_by=$2, updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE user_id=$3',
        [message, req.session.userId, userId]
      );
    } else {
      await pool.query(
        'INSERT INTO user_client_state (id, user_id, is_paused, pause_message, updated_by) VALUES ($1,$2,TRUE,$3,$4)',
        [uuidv4(), userId, message, req.session.userId]
      );
    }
  }

  if (action === 'unlock') {
    await pool.query(
      'UPDATE user_client_state SET is_paused=FALSE, pause_message=NULL, updated_by=$1, updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE user_id=$2',
      [req.session.userId, userId]
    );
  }

  req.io.to(`user:${userId}`).emit('nexus_admin_control', {
    action,
    message,
    view,
    at: Math.floor(Date.now() / 1000),
    by: {
      id: req.session.userId,
      username: actorRow.username || 'admin',
      displayName: actorRow.display_name || 'Admin'
    }
  });

  res.json({ success: true });
});

router.get('/admins', async (req, res) => {
  const seeded = Array.from(ADMIN_IDS).map(id => ({ user_id: id, seeded: true }));
  const dbAdmins = await pool.query('SELECT user_id, added_by, created_at FROM admin_users ORDER BY created_at DESC');
  const all = [...seeded, ...dbAdmins.rows];
  const unique = new Map();
  all.forEach(a => {
    if (!unique.has(a.user_id)) unique.set(a.user_id, a);
  });
  const adminIds = Array.from(unique.keys());
  if (!adminIds.length) return res.json({ admins: [] });

  const users = await pool.query('SELECT id, username, display_name FROM users WHERE id = ANY($1::text[])', [adminIds]);
  const byId = new Map(users.rows.map(u => [u.id, u]));
  res.json({ admins: Array.from(unique.values()).map(a => ({
    id: a.user_id,
    username: byId.get(a.user_id)?.username || 'unknown',
    displayName: byId.get(a.user_id)?.display_name || 'Unknown User',
    seeded: !!a.seeded,
    removable: !a.seeded && a.user_id !== NON_REMOVABLE_ADMIN_ID,
    addedBy: a.added_by || null,
    createdAt: a.created_at ? parseInt(a.created_at, 10) : null
  })) });
});

router.post('/admins', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const qrCode = String(req.body.qrCode || '').trim();
  if (!username) return res.status(400).json({ error: 'Username required' });
  if (!qrCode) return res.status(400).json({ error: 'QR scan code required' });
  if (qrCode !== ADMIN_QR_REQUIRED_CODE) return res.status(403).json({ error: 'Invalid QR verification code' });

  const target = await pool.query('SELECT id, username, display_name FROM users WHERE LOWER(username)=LOWER($1)', [username]);
  if (!target.rows.length) return res.status(404).json({ error: 'User not found' });
  const u = target.rows[0];

  if (await isGlobalAdmin(u.id)) return res.status(409).json({ error: 'User is already an admin' });

  await pool.query('INSERT INTO admin_users (id, user_id, added_by) VALUES ($1,$2,$3)', [uuidv4(), u.id, req.session.userId]);
  res.json({ success: true, admin: { id: u.id, username: u.username, displayName: u.display_name } });
});

router.delete('/admins/:userId', async (req, res) => {
  const { userId } = req.params;
  if (userId === NON_REMOVABLE_ADMIN_ID) {
    return res.status(403).json({ error: 'This admin cannot be removed' });
  }
  if (ADMIN_IDS.has(userId)) {
    return res.status(403).json({ error: 'Core admins cannot be removed' });
  }

  const removed = await pool.query('DELETE FROM admin_users WHERE user_id=$1', [userId]);
  if (!removed.rowCount) return res.status(404).json({ error: 'Admin record not found' });
  res.json({ success: true });
});

module.exports = router;
module.exports.ADMIN_IDS = ADMIN_IDS;
module.exports.isGlobalAdmin = isGlobalAdmin;
