const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../models/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg','image/png','image/gif','image/webp'].includes(file.mimetype)) cb(null,true);
    else cb(new Error('Invalid file type'));
  }
});

function genInviteCode() {
  return Math.random().toString(36).substring(2,10).toUpperCase();
}

function fmtServer(s) {
  return {
    id: s.id, name: s.name, ownerId: s.owner_id,
    iconDataUrl: s.icon_data ? `data:${s.icon_mime};base64,${s.icon_data}` : null,
    inviteCode: s.invite_code, createdAt: s.created_at
  };
}

// List servers I'm in
router.get('/', async (req, res) => {
  const r = await pool.query(
    `SELECT s.* FROM servers s
     JOIN server_members sm ON sm.server_id = s.id
     WHERE sm.user_id = $1 ORDER BY sm.joined_at ASC`,
    [req.session.userId]
  );
  res.json({ servers: r.rows.map(fmtServer) });
});

// Create server
router.post('/', upload.single('icon'), async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const id = uuidv4();
  const inviteCode = genInviteCode();
  const iconData = req.file ? req.file.buffer.toString('base64') : null;
  const iconMime = req.file ? req.file.mimetype : null;
  try {
    await pool.query(
      `INSERT INTO servers (id, name, owner_id, icon_data, icon_mime, invite_code) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, name.trim(), req.session.userId, iconData, iconMime, inviteCode]
    );
    // Owner joins as admin
    await pool.query(
      `INSERT INTO server_members (id, server_id, user_id, role) VALUES ($1,$2,$3,'admin')`,
      [uuidv4(), id, req.session.userId]
    );
    // Create default #general channel
    await pool.query(
      `INSERT INTO channels (id, server_id, name, position) VALUES ($1,$2,'general',0)`,
      [uuidv4(), id]
    );
    const s = await pool.query('SELECT * FROM servers WHERE id=$1', [id]);
    res.json({ server: fmtServer(s.rows[0]) });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get server details + channels + members
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const member = await pool.query(
    'SELECT id FROM server_members WHERE server_id=$1 AND user_id=$2',
    [id, req.session.userId]
  );
  if (!member.rows.length) return res.status(403).json({ error: 'Not a member' });

  const [sRes, chRes, memRes] = await Promise.all([
    pool.query('SELECT * FROM servers WHERE id=$1', [id]),
    pool.query('SELECT * FROM channels WHERE server_id=$1 ORDER BY position ASC', [id]),
    pool.query(
      `SELECT sm.role, sm.joined_at, u.id, u.username, u.display_name, u.avatar_data, u.avatar_mime, u.status
       FROM server_members sm JOIN users u ON u.id=sm.user_id WHERE sm.server_id=$1`,
      [id]
    )
  ]);
  if (!sRes.rows.length) return res.status(404).json({ error: 'Not found' });

  res.json({
    server: fmtServer(sRes.rows[0]),
    channels: chRes.rows.map(c => ({ id: c.id, name: c.name, position: c.position })),
    members: memRes.rows.map(m => ({
      id: m.id, username: m.username, displayName: m.display_name,
      avatarDataUrl: m.avatar_data ? `data:${m.avatar_mime};base64,${m.avatar_data}` : null,
      status: m.status, role: m.role
    }))
  });
});

// Update server (name/icon) — owner only
router.patch('/:id', upload.single('icon'), async (req, res) => {
  const { id } = req.params;
  const s = await pool.query('SELECT * FROM servers WHERE id=$1 AND owner_id=$2', [id, req.session.userId]);
  if (!s.rows.length) return res.status(403).json({ error: 'Not owner' });
  const name = req.body.name ? req.body.name.trim() : s.rows[0].name;
  const iconData = req.file ? req.file.buffer.toString('base64') : s.rows[0].icon_data;
  const iconMime = req.file ? req.file.mimetype : s.rows[0].icon_mime;
  await pool.query('UPDATE servers SET name=$1, icon_data=$2, icon_mime=$3 WHERE id=$4', [name, iconData, iconMime, id]);
  const updated = await pool.query('SELECT * FROM servers WHERE id=$1', [id]);
  res.json({ server: fmtServer(updated.rows[0]) });
});

// Create channel — admin only
router.post('/:id/channels', async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const member = await pool.query(
    "SELECT role FROM server_members WHERE server_id=$1 AND user_id=$2",
    [id, req.session.userId]
  );
  if (!member.rows.length || member.rows[0].role !== 'admin')
    return res.status(403).json({ error: 'Admins only' });
  const pos = await pool.query('SELECT COUNT(*) FROM channels WHERE server_id=$1', [id]);
  const chId = uuidv4();
  await pool.query(
    'INSERT INTO channels (id, server_id, name, position) VALUES ($1,$2,$3,$4)',
    [chId, id, name.trim().toLowerCase().replace(/\s+/g,'-'), parseInt(pos.rows[0].count)]
  );
  res.json({ channel: { id: chId, name: name.trim(), serverId: id } });
});

// Delete channel — admin only
router.delete('/:id/channels/:chId', async (req, res) => {
  const { id, chId } = req.params;
  const member = await pool.query(
    "SELECT role FROM server_members WHERE server_id=$1 AND user_id=$2",
    [id, req.session.userId]
  );
  if (!member.rows.length || member.rows[0].role !== 'admin')
    return res.status(403).json({ error: 'Admins only' });
  // Don't delete if it's the last channel
  const count = await pool.query('SELECT COUNT(*) FROM channels WHERE server_id=$1', [id]);
  if (parseInt(count.rows[0].count) <= 1) return res.status(400).json({ error: 'Cannot delete the last channel' });
  await pool.query('DELETE FROM channels WHERE id=$1 AND server_id=$2', [chId, id]);
  res.json({ success: true });
});

// Join via invite code
router.post('/join/:code', async (req, res) => {
  const { code } = req.params;
  const s = await pool.query('SELECT * FROM servers WHERE invite_code=$1', [code.toUpperCase()]);
  if (!s.rows.length) return res.status(404).json({ error: 'Invalid invite code' });
  const server = s.rows[0];
  const already = await pool.query(
    'SELECT id FROM server_members WHERE server_id=$1 AND user_id=$2',
    [server.id, req.session.userId]
  );
  if (already.rows.length) return res.json({ server: fmtServer(server), alreadyMember: true });
  await pool.query(
    'INSERT INTO server_members (id, server_id, user_id, role) VALUES ($1,$2,$3,\'member\')',
    [uuidv4(), server.id, req.session.userId]
  );
  res.json({ server: fmtServer(server) });
});

// Invite a friend directly
router.post('/:id/invite', async (req, res) => {
  const { id } = req.params;
  const { userId } = req.body;
  const member = await pool.query(
    'SELECT id FROM server_members WHERE server_id=$1 AND user_id=$2',
    [id, req.session.userId]
  );
  if (!member.rows.length) return res.status(403).json({ error: 'Not a member' });
  const already = await pool.query(
    'SELECT id FROM server_members WHERE server_id=$1 AND user_id=$2',
    [id, userId]
  );
  if (already.rows.length) return res.status(409).json({ error: 'Already a member' });
  await pool.query(
    'INSERT INTO server_members (id, server_id, user_id, role) VALUES ($1,$2,$3,\'member\')',
    [uuidv4(), id, userId]
  );
  res.json({ success: true });
});

// Leave server
router.delete('/:id/leave', async (req, res) => {
  const { id } = req.params;
  const s = await pool.query('SELECT owner_id FROM servers WHERE id=$1', [id]);
  if (s.rows[0]?.owner_id === req.session.userId) return res.status(400).json({ error: 'Owner cannot leave — delete the server instead' });
  await pool.query('DELETE FROM server_members WHERE server_id=$1 AND user_id=$2', [id, req.session.userId]);
  res.json({ success: true });
});

// Delete server — owner only
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const s = await pool.query('SELECT id FROM servers WHERE id=$1 AND owner_id=$2', [id, req.session.userId]);
  if (!s.rows.length) return res.status(403).json({ error: 'Not owner' });
  await pool.query('DELETE FROM servers WHERE id=$1', [id]);
  res.json({ success: true });
});

// Get channel messages
router.get('/:id/channels/:chId/messages', async (req, res) => {
  const { id, chId } = req.params;
  const { before, limit = 50 } = req.query;
  const member = await pool.query(
    'SELECT id FROM server_members WHERE server_id=$1 AND user_id=$2',
    [id, req.session.userId]
  );
  if (!member.rows.length) return res.status(403).json({ error: 'Not a member' });

  let q = `SELECT cm.id, cm.channel_id, cm.from_id, cm.content, cm.created_at,
    u.username, u.display_name, u.avatar_data, u.avatar_mime
    FROM channel_messages cm JOIN users u ON u.id=cm.from_id
    WHERE cm.channel_id=$1`;
  const params = [chId];
  if (before) { params.push(parseInt(before)); q += ` AND cm.created_at < $${params.length}`; }
  q += ` ORDER BY cm.created_at DESC LIMIT $${params.length+1}`;
  params.push(parseInt(limit));

  const r = await pool.query(q, params);
  res.json({ messages: r.rows.reverse().map(m => ({
    id: m.id, channelId: m.channel_id, fromId: m.from_id,
    content: m.content, createdAt: parseInt(m.created_at),
    author: {
      username: m.username, displayName: m.display_name,
      avatarDataUrl: m.avatar_data ? `data:${m.avatar_mime};base64,${m.avatar_data}` : null
    }
  }))});
});

module.exports = router;
