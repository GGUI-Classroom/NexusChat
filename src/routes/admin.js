const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../models/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Hardcoded admin user IDs
const ADMIN_IDS = new Set([
  '7db80df6-0566-4fa0-bbc2-6cde9775f3a4',
  '238a8575-224a-40cb-b699-eba0d9ff7384',
]);

function requireAdmin(req, res, next) {
  if (!ADMIN_IDS.has(req.session.userId)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  next();
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

  res.json({ success: true, username: user.rows[0].username, userId: user.rows[0].id, suspendedUntil: until });
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
    'SELECT id, username, display_name, nexals FROM users WHERE id=$1', [userId]
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

  res.json({
    id: u.id, username: u.username, displayName: u.display_name,
    nexals: u.nexals,
    suspendedUntil: suspRes.rows[0] ? parseInt(suspRes.rows[0].suspended_until) : null,
    suspendReason: suspRes.rows[0]?.reason || null,
    servers: serversRes.rows.map(s => ({
      id: s.id, name: s.name, role: s.role, memberCount: parseInt(s.member_count),
      iconDataUrl: s.icon_data ? `data:${s.icon_mime};base64,${s.icon_data}` : null,
    }))
  });
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

module.exports = router;
module.exports.ADMIN_IDS = ADMIN_IDS;
