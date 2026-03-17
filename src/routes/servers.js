const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../models/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Parse <@user:ID> and <@role:ID> tokens and resolve to display names
async function resolveMentions(content, serverId) {
  const userMentions = [...content.matchAll(/<@user:([a-f0-9-]+)>/g)];
  const roleMentions = [...content.matchAll(/<@role:([a-f0-9-]+)>/g)];
  const mentionData = { users: {}, roles: {} };
  if (userMentions.length) {
    const ids = [...new Set(userMentions.map(m => m[1]))];
    const r = await pool.query(`SELECT id, username, display_name FROM users WHERE id = ANY($1)`, [ids]);
    r.rows.forEach(u => { mentionData.users[u.id] = { username: u.username, displayName: u.display_name }; });
  }
  if (roleMentions.length) {
    const ids = [...new Set(roleMentions.map(m => m[1]))];
    const r = await pool.query(`SELECT id, name, color FROM server_roles WHERE id = ANY($1) AND server_id = $2`, [ids, serverId]);
    r.rows.forEach(r => { mentionData.roles[r.id] = { name: r.name, color: r.color }; });
  }
  return mentionData;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg','image/png','image/gif','image/webp'].includes(file.mimetype)) cb(null,true);
    else cb(new Error('Invalid file type'));
  }
});

function genInviteCode() { return Math.random().toString(36).substring(2,10).toUpperCase(); }

function fmtServer(s) {
  return {
    id: s.id, name: s.name, ownerId: s.owner_id,
    iconDataUrl: s.icon_data ? `data:${s.icon_mime};base64,${s.icon_data}` : null,
    inviteCode: s.invite_code, createdAt: s.created_at
  };
}

async function getMemberRole(serverId, userId) {
  const r = await pool.query(
    `SELECT sm.role, sm.role_id, sr.name as role_name, sr.color, sr.is_admin
     FROM server_members sm
     LEFT JOIN server_roles sr ON sr.id = sm.role_id
     WHERE sm.server_id=$1 AND sm.user_id=$2`,
    [serverId, userId]
  );
  return r.rows[0] || null;
}

async function isAdmin(serverId, userId) {
  const server = await pool.query('SELECT owner_id FROM servers WHERE id=$1', [serverId]);
  if (!server.rows.length) return false;
  if (server.rows[0].owner_id === userId) return true;
  const m = await getMemberRole(serverId, userId);
  return m && (m.role === 'admin' || m.is_admin);
}

// List my servers
router.get('/', async (req, res) => {
  const r = await pool.query(
    `SELECT s.* FROM servers s JOIN server_members sm ON sm.server_id=s.id
     WHERE sm.user_id=$1 ORDER BY sm.joined_at ASC`,
    [req.session.userId]
  );
  res.json({ servers: r.rows.map(fmtServer) });
});

// Get pending server invites for me
router.get('/invites/pending', async (req, res) => {
  const r = await pool.query(
    `SELECT si.id, si.server_id, si.from_id, si.created_at,
       s.name as server_name, s.icon_data, s.icon_mime,
       u.username as from_username, u.display_name as from_display_name,
       u.avatar_data as from_avatar, u.avatar_mime as from_avatar_mime
     FROM server_invites si
     JOIN servers s ON s.id=si.server_id
     JOIN users u ON u.id=si.from_id
     WHERE si.to_id=$1 AND si.status='pending'`,
    [req.session.userId]
  );
  res.json({ invites: r.rows.map(i => ({
    id: i.id, serverId: i.server_id, fromId: i.from_id,
    serverName: i.server_name,
    serverIconDataUrl: i.icon_data ? `data:${i.icon_mime};base64,${i.icon_data}` : null,
    from: {
      username: i.from_username, displayName: i.from_display_name,
      avatarDataUrl: i.from_avatar ? `data:${i.from_avatar_mime};base64,${i.from_avatar}` : null
    }
  }))});
});

// Respond to server invite
router.post('/invites/:id/respond', async (req, res) => {
  const { id } = req.params;
  const { action } = req.body;
  const inv = await pool.query(
    `SELECT * FROM server_invites WHERE id=$1 AND to_id=$2 AND status='pending'`,
    [id, req.session.userId]
  );
  if (!inv.rows.length) return res.status(404).json({ error: 'Invite not found' });
  const invite = inv.rows[0];
  if (action === 'accept') {
    const banned = await pool.query('SELECT id FROM server_bans WHERE server_id=$1 AND user_id=$2', [invite.server_id, req.session.userId]);
    if (banned.rows.length) return res.status(403).json({ error: 'You are banned from this server' });
    await pool.query(`UPDATE server_invites SET status='accepted' WHERE id=$1`, [id]);
    await pool.query(
      `INSERT INTO server_members (id, server_id, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [uuidv4(), invite.server_id, req.session.userId]
    );
    const s = await pool.query('SELECT * FROM servers WHERE id=$1', [invite.server_id]);
    return res.json({ success: true, server: fmtServer(s.rows[0]) });
  } else {
    await pool.query(`UPDATE server_invites SET status='declined' WHERE id=$1`, [id]);
    return res.json({ success: true });
  }
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
    // Default roles — wrapped separately so if server_roles table is missing we still create the server
    try {
      const adminRoleId = uuidv4();
      const memberRoleId = uuidv4();
      await pool.query(
        `INSERT INTO server_roles (id, server_id, name, color, is_admin, position) VALUES ($1,$2,'Admin','#f05454',true,0),($3,$2,'Member','#8892a4',false,1)`,
        [adminRoleId, id, memberRoleId]
      );
      await pool.query(`UPDATE server_members SET role_id=$1 WHERE server_id=$2 AND user_id=$3`, [adminRoleId, id, req.session.userId]);
    } catch(roleErr) {
      console.error('Role creation failed (table may not exist yet):', roleErr.message);
    }
    // Default channel
    await pool.query(`INSERT INTO channels (id, server_id, name, position) VALUES ($1,$2,'general',0)`, [uuidv4(), id]);
    const s = await pool.query('SELECT * FROM servers WHERE id=$1', [id]);
    res.json({ server: fmtServer(s.rows[0]) });
  } catch(e) {
    console.error('Create server error:', e.message, e.stack);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// Get server details + channels + members + roles
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const member = await pool.query('SELECT id FROM server_members WHERE server_id=$1 AND user_id=$2', [id, req.session.userId]);
  if (!member.rows.length) return res.status(403).json({ error: 'Not a member' });
  const [sRes, chRes, memRes, roleRes] = await Promise.all([
    pool.query('SELECT * FROM servers WHERE id=$1', [id]),
    pool.query(`
      SELECT c.*,
        CASE WHEN c.private = FALSE THEN TRUE
             WHEN sm.role = 'admin' OR EXISTS(
               SELECT 1 FROM server_roles sr2
               WHERE sr2.id = sm.role_id AND sr2.is_admin = TRUE
             ) THEN TRUE
             WHEN c.private = TRUE AND EXISTS(
               SELECT 1 FROM channel_permissions cp2
               WHERE cp2.channel_id = c.id AND cp2.role_id = sm.role_id
               AND cp2.allow_view = TRUE
             ) THEN TRUE
             ELSE FALSE
        END as can_view
      FROM channels c
      LEFT JOIN server_members sm ON sm.server_id = c.server_id AND sm.user_id = $2
      WHERE c.server_id = $1
      ORDER BY c.position ASC
    `, [id, req.session.userId]),
    pool.query(
      `SELECT sm.role, sm.role_id, sr.name as role_name, sr.color as role_color, sr.is_admin,
       u.id, u.username, u.display_name, u.avatar_data, u.avatar_mime, u.status, u.active_decoration
       FROM server_members sm
       JOIN users u ON u.id=sm.user_id
       LEFT JOIN server_roles sr ON sr.id=sm.role_id
       WHERE sm.server_id=$1 ORDER BY u.display_name ASC`, [id]
    ),
    pool.query('SELECT * FROM server_roles WHERE server_id=$1 ORDER BY position ASC', [id])
  ]);
  if (!sRes.rows.length) return res.status(404).json({ error: 'Not found' });
  res.json({
    server: fmtServer(sRes.rows[0]),
    channels: chRes.rows.filter(c => c.can_view).map(c => ({ id: c.id, name: c.name, position: c.position, locked: !!c.locked, private: !!c.private })),
    members: memRes.rows.map(m => ({
      id: m.id, username: m.username, displayName: m.display_name,
      avatarDataUrl: m.avatar_data ? `data:${m.avatar_mime};base64,${m.avatar_data}` : null,
      status: m.status, role: m.role, roleId: m.role_id,
      roleName: m.role_name, roleColor: m.role_color, isAdmin: m.is_admin,
      activeDecoration: m.active_decoration || null
    })),
    roles: roleRes.rows.map(r => ({ id: r.id, name: r.name, color: r.color, isAdmin: r.is_admin, position: r.position, canDeleteMessages: !!r.can_delete_messages }))
  });
});

// Update server
router.patch('/:id', upload.single('icon'), async (req, res) => {
  const { id } = req.params;
  if (!await isAdmin(id, req.session.userId)) return res.status(403).json({ error: 'Admins only' });
  const s = await pool.query('SELECT * FROM servers WHERE id=$1', [id]);
  if (!s.rows.length) return res.status(404).json({ error: 'Not found' });
  const name = req.body.name ? req.body.name.trim() : s.rows[0].name;
  const iconData = req.file ? req.file.buffer.toString('base64') : s.rows[0].icon_data;
  const iconMime = req.file ? req.file.mimetype : s.rows[0].icon_mime;
  await pool.query('UPDATE servers SET name=$1, icon_data=$2, icon_mime=$3 WHERE id=$4', [name, iconData, iconMime, id]);
  const updated = await pool.query('SELECT * FROM servers WHERE id=$1', [id]);
  res.json({ server: fmtServer(updated.rows[0]) });
});

// Create channel
router.post('/:id/channels', async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  if (!await isAdmin(id, req.session.userId)) return res.status(403).json({ error: 'Admins only' });
  const pos = await pool.query('SELECT COUNT(*) FROM channels WHERE server_id=$1', [id]);
  const chId = uuidv4();
  const chName = name.trim().toLowerCase().replace(/\s+/g,'-');
  await pool.query('INSERT INTO channels (id, server_id, name, position) VALUES ($1,$2,$3,$4)', [chId, id, chName, parseInt(pos.rows[0].count)]);
  res.json({ channel: { id: chId, name: chName, serverId: id } });
});

// Delete channel
router.delete('/:id/channels/:chId', async (req, res) => {
  const { id, chId } = req.params;
  if (!await isAdmin(id, req.session.userId)) return res.status(403).json({ error: 'Admins only' });
  const count = await pool.query('SELECT COUNT(*) FROM channels WHERE server_id=$1', [id]);
  if (parseInt(count.rows[0].count) <= 1) return res.status(400).json({ error: 'Cannot delete the last channel' });
  await pool.query('DELETE FROM channels WHERE id=$1 AND server_id=$2', [chId, id]);
  res.json({ success: true });
});

// ---- ROLES ----
// Get roles
router.get('/:id/roles', async (req, res) => {
  const { id } = req.params;
  const member = await pool.query('SELECT id FROM server_members WHERE server_id=$1 AND user_id=$2', [id, req.session.userId]);
  if (!member.rows.length) return res.status(403).json({ error: 'Not a member' });
  const r = await pool.query('SELECT * FROM server_roles WHERE server_id=$1 ORDER BY position ASC', [id]);
  res.json({ roles: r.rows.map(r => ({ id: r.id, name: r.name, color: r.color, isAdmin: r.is_admin, position: r.position, canDeleteMessages: !!r.can_delete_messages })) });
});

// Create role
router.post('/:id/roles', async (req, res) => {
  const { id } = req.params;
  if (!await isAdmin(id, req.session.userId)) return res.status(403).json({ error: 'Admins only' });
  const { name, color, isAdmin: roleIsAdmin } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const pos = await pool.query('SELECT COUNT(*) FROM server_roles WHERE server_id=$1', [id]);
  const roleId = uuidv4();
  const canDelete = req.body.canDeleteMessages || false;
  await pool.query(
    'INSERT INTO server_roles (id, server_id, name, color, is_admin, position, can_delete_messages) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [roleId, id, name.trim(), color || '#8892a4', !!roleIsAdmin, parseInt(pos.rows[0].count), !!canDelete]
  );
  res.json({ role: { id: roleId, name: name.trim(), color: color || '#8892a4', isAdmin: !!roleIsAdmin, canDeleteMessages: !!canDelete } });
});

// Update role
router.patch('/:id/roles/:roleId', async (req, res) => {
  const { id, roleId } = req.params;
  if (!await isAdmin(id, req.session.userId)) return res.status(403).json({ error: 'Admins only' });
  const { name, color, isAdmin: roleIsAdmin } = req.body;
  const { canDeleteMessages } = req.body;
  await pool.query(
    `UPDATE server_roles SET
      name=COALESCE($1,name),
      color=COALESCE($2,color),
      is_admin=COALESCE($3,is_admin),
      can_delete_messages=COALESCE($4,can_delete_messages)
     WHERE id=$5 AND server_id=$6`,
    [name || null, color || null,
     roleIsAdmin != null ? !!roleIsAdmin : null,
     canDeleteMessages != null ? !!canDeleteMessages : null,
     roleId, id]
  );
  const r = await pool.query('SELECT * FROM server_roles WHERE id=$1', [roleId]);
  res.json({ role: { id: r.rows[0].id, name: r.rows[0].name, color: r.rows[0].color, isAdmin: r.rows[0].is_admin, canDeleteMessages: !!r.rows[0].can_delete_messages } });
});

// Delete role
router.delete('/:id/roles/:roleId', async (req, res) => {
  const { id, roleId } = req.params;
  if (!await isAdmin(id, req.session.userId)) return res.status(403).json({ error: 'Admins only' });
  // Unassign from members first
  await pool.query('UPDATE server_members SET role_id=NULL WHERE server_id=$1 AND role_id=$2', [id, roleId]);
  await pool.query('DELETE FROM server_roles WHERE id=$1 AND server_id=$2', [roleId, id]);
  res.json({ success: true });
});

// Assign role to member
router.patch('/:id/members/:userId/role', async (req, res) => {
  const { id, userId } = req.params;
  if (!await isAdmin(id, req.session.userId)) return res.status(403).json({ error: 'Admins only' });
  const { roleId } = req.body;
  // Validate role belongs to server
  if (roleId) {
    const role = await pool.query('SELECT id, is_admin FROM server_roles WHERE id=$1 AND server_id=$2', [roleId, id]);
    if (!role.rows.length) return res.status(400).json({ error: 'Role not found' });
    const newRole = role.rows[0].is_admin ? 'admin' : 'member';
    await pool.query('UPDATE server_members SET role_id=$1, role=$2 WHERE server_id=$3 AND user_id=$4', [roleId, newRole, id, userId]);
  } else {
    await pool.query('UPDATE server_members SET role_id=NULL, role=\'member\' WHERE server_id=$1 AND user_id=$2', [id, userId]);
  }
  await syncAch(userId, ['roles_received']);
  res.json({ success: true });
});

// ---- INVITES ----
router.post('/join/:code', async (req, res) => {
  const { code } = req.params;
  const s = await pool.query('SELECT * FROM servers WHERE invite_code=$1', [code.toUpperCase()]);
  if (!s.rows.length) return res.status(404).json({ error: 'Invalid invite code' });
  const server = s.rows[0];
  const banned = await pool.query('SELECT id FROM server_bans WHERE server_id=$1 AND user_id=$2', [server.id, req.session.userId]);
  if (banned.rows.length) return res.status(403).json({ error: 'You are banned from this server' });
  const already = await pool.query('SELECT id FROM server_members WHERE server_id=$1 AND user_id=$2', [server.id, req.session.userId]);
  if (already.rows.length) return res.json({ server: fmtServer(server), alreadyMember: true });
  await pool.query('INSERT INTO server_members (id, server_id, user_id) VALUES ($1,$2,$3)', [uuidv4(), server.id, req.session.userId]);
  await syncAch(req.session.userId, ['servers_joined']);
  res.json({ server: fmtServer(server) });
});

// Direct invite — creates a pending invite
router.post('/:id/invite', async (req, res) => {
  const { id } = req.params;
  const { userId } = req.body;
  const member = await pool.query('SELECT id FROM server_members WHERE server_id=$1 AND user_id=$2', [id, req.session.userId]);
  if (!member.rows.length) return res.status(403).json({ error: 'Not a member' });
  const already = await pool.query('SELECT id FROM server_members WHERE server_id=$1 AND user_id=$2', [id, userId]);
  if (already.rows.length) return res.status(409).json({ error: 'Already a member' });
  const banned = await pool.query('SELECT id FROM server_bans WHERE server_id=$1 AND user_id=$2', [id, userId]);
  if (banned.rows.length) return res.status(403).json({ error: 'This user is banned' });
  // Upsert invite
  await pool.query(
    `INSERT INTO server_invites (id, server_id, from_id, to_id, status) VALUES ($1,$2,$3,$4,'pending')
     ON CONFLICT (server_id, to_id) DO UPDATE SET status='pending', from_id=$3`,
    [uuidv4(), id, req.session.userId, userId]
  );
  // Socket notification to the invited user
  try {
    const io = req.io;
    const server = await pool.query('SELECT * FROM servers WHERE id=$1', [id]);
    const inviter = await pool.query('SELECT username, display_name, avatar_data, avatar_mime FROM users WHERE id=$1', [req.session.userId]);
    const s = server.rows[0]; const u = inviter.rows[0];
    if (io) {
      const inviteData = {
        serverId: id, serverName: s.name,
        serverIconDataUrl: s.icon_data ? `data:${s.icon_mime};base64,${s.icon_data}` : null,
        from: {
          username: u.username, displayName: u.display_name,
          avatarDataUrl: u.avatar_data ? `data:${u.avatar_mime};base64,${u.avatar_data}` : null
        }
      };
      io.to(`user:${userId}`).emit('server_invite', inviteData);
    }
  } catch(e) { console.error('Socket emit error:', e); }
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

// Delete server
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const s = await pool.query('SELECT id FROM servers WHERE id=$1 AND owner_id=$2', [id, req.session.userId]);
  if (!s.rows.length) return res.status(403).json({ error: 'Not owner' });
  await pool.query('DELETE FROM servers WHERE id=$1', [id]);
  res.json({ success: true });
});

// ---- KICK / BAN ----
router.post('/:id/kick/:userId', async (req, res) => {
  const { id, userId } = req.params;
  if (!await isAdmin(id, req.session.userId)) return res.status(403).json({ error: 'Admins only' });
  const server = await pool.query('SELECT owner_id FROM servers WHERE id=$1', [id]);
  if (server.rows[0]?.owner_id === userId) return res.status(400).json({ error: 'Cannot kick the owner' });
  await pool.query('DELETE FROM server_members WHERE server_id=$1 AND user_id=$2', [id, userId]);
  try {
    if (req.io) req.io.to(`user:${userId}`).emit('kicked_from_server', { serverId: id });
  } catch(e) {}
  res.json({ success: true });
});

router.post('/:id/ban/:userId', async (req, res) => {
  const { id, userId } = req.params;
  if (!await isAdmin(id, req.session.userId)) return res.status(403).json({ error: 'Admins only' });
  const server = await pool.query('SELECT owner_id FROM servers WHERE id=$1', [id]);
  if (server.rows[0]?.owner_id === userId) return res.status(400).json({ error: 'Cannot ban the owner' });
  const { reason } = req.body;
  await pool.query('DELETE FROM server_members WHERE server_id=$1 AND user_id=$2', [id, userId]);
  await pool.query(
    `INSERT INTO server_bans (id, server_id, user_id, banned_by, reason) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (server_id, user_id) DO UPDATE SET reason=$5, banned_by=$4`,
    [uuidv4(), id, userId, req.session.userId, reason || null]
  );
  try {
    if (req.io) req.io.to(`user:${userId}`).emit('banned_from_server', { serverId: id });
  } catch(e) {}
  res.json({ success: true });
});

router.post('/:id/unban/:userId', async (req, res) => {
  const { id, userId } = req.params;
  if (!await isAdmin(id, req.session.userId)) return res.status(403).json({ error: 'Admins only' });
  await pool.query('DELETE FROM server_bans WHERE server_id=$1 AND user_id=$2', [id, userId]);
  res.json({ success: true });
});

router.get('/:id/bans', async (req, res) => {
  const { id } = req.params;
  if (!await isAdmin(id, req.session.userId)) return res.status(403).json({ error: 'Admins only' });
  const r = await pool.query(
    `SELECT sb.id, sb.reason, sb.created_at, u.id as user_id, u.username, u.display_name
     FROM server_bans sb JOIN users u ON u.id=sb.user_id WHERE sb.server_id=$1`, [id]
  );
  res.json({ bans: r.rows.map(b => ({ id: b.id, userId: b.user_id, username: b.username, displayName: b.display_name, reason: b.reason })) });
});

// ---- CHANNEL PERMISSIONS ----
// Get permissions for a channel
router.get('/:id/channels/:chId/permissions', async (req, res) => {
  const { id, chId } = req.params;
  if (!await isAdmin(id, req.session.userId)) return res.status(403).json({ error: 'Admins only' });
  const ch = await pool.query('SELECT locked FROM channels WHERE id=$1 AND server_id=$2', [chId, id]);
  if (!ch.rows.length) return res.status(404).json({ error: 'Channel not found' });
  const perms = await pool.query(
    `SELECT cp.id, cp.role_id, cp.allow_send, cp.allow_view, sr.name as role_name, sr.color
     FROM channel_permissions cp
     JOIN server_roles sr ON sr.id=cp.role_id
     WHERE cp.channel_id=$1`, [chId]
  );
  res.json({
    locked: ch.rows[0].locked,
    private: ch.rows[0].private || false,
    permissions: perms.rows.map(p => ({ id: p.id, roleId: p.role_id, roleName: p.role_name, color: p.color, allowSend: p.allow_send, allowView: p.allow_view }))
  });
});

// Set channel locked state
router.patch('/:id/channels/:chId/lock', async (req, res) => {
  const { id, chId } = req.params;
  if (!await isAdmin(id, req.session.userId)) return res.status(403).json({ error: 'Admins only' });
  const { locked } = req.body;
  await pool.query('UPDATE channels SET locked=$1 WHERE id=$2 AND server_id=$3', [!!locked, chId, id]);
  res.json({ success: true, locked: !!locked });
});

// Set channel private state
router.patch('/:id/channels/:chId/private', async (req, res) => {
  const { id, chId } = req.params;
  if (!await isAdmin(id, req.session.userId)) return res.status(403).json({ error: 'Admins only' });
  const { private: isPrivate } = req.body;
  await pool.query('UPDATE channels SET private=$1 WHERE id=$2 AND server_id=$3', [!!isPrivate, chId, id]);
  res.json({ success: true, private: !!isPrivate });
});

// Set role permission for a channel
router.put('/:id/channels/:chId/permissions/:roleId', async (req, res) => {
  const { id, chId, roleId } = req.params;
  if (!await isAdmin(id, req.session.userId)) return res.status(403).json({ error: 'Admins only' });
  const { allowSend } = req.body;
  const role = await pool.query('SELECT id FROM server_roles WHERE id=$1 AND server_id=$2', [roleId, id]);
  if (!role.rows.length) return res.status(404).json({ error: 'Role not found' });
  const { allowView } = req.body;
  await pool.query(
    `INSERT INTO channel_permissions (id, channel_id, role_id, allow_send, allow_view)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (channel_id, role_id) DO UPDATE SET allow_send=$4, allow_view=$5`,
    [uuidv4(), chId, roleId, allowSend !== false, allowView !== false]
  );
  res.json({ success: true });
});

// Remove role permission override for a channel
router.delete('/:id/channels/:chId/permissions/:roleId', async (req, res) => {
  const { id, chId, roleId } = req.params;
  if (!await isAdmin(id, req.session.userId)) return res.status(403).json({ error: 'Admins only' });
  await pool.query('DELETE FROM channel_permissions WHERE channel_id=$1 AND role_id=$2', [chId, roleId]);
  res.json({ success: true });
});

// Get channel messages
router.get('/:id/channels/:chId/messages', async (req, res) => {
  const { id, chId } = req.params;
  const { before, limit = 50 } = req.query;
  const member = await pool.query('SELECT id FROM server_members WHERE server_id=$1 AND user_id=$2', [id, req.session.userId]);
  if (!member.rows.length) return res.status(403).json({ error: 'Not a member' });
  let q = `SELECT cm.id, cm.channel_id, cm.from_id, cm.content, cm.created_at,
    u.username, u.display_name, u.avatar_data, u.avatar_mime, u.active_decoration,
    sm.role_id, sr.name as role_name, sr.color as role_color
    FROM channel_messages cm
    JOIN users u ON u.id=cm.from_id
    LEFT JOIN server_members sm ON sm.server_id=$1 AND sm.user_id=cm.from_id
    LEFT JOIN server_roles sr ON sr.id=sm.role_id
    WHERE cm.channel_id=$2`;
  const params = [id, chId];
  if (before) { params.push(parseInt(before)); q += ` AND cm.created_at < $${params.length}`; }
  q += ` ORDER BY cm.created_at DESC LIMIT $${params.length+1}`;
  params.push(parseInt(limit));
  const r = await pool.query(q, params);
  const messages = r.rows.reverse();
  // Collect all mention data for the batch
  const allContent = messages.map(m => m.content).join(' ');
  const mentionData = await resolveMentions(allContent, id);
  res.json({ messages: messages.map(m => ({
    id: m.id, channelId: m.channel_id, fromId: m.from_id,
    content: m.content, createdAt: parseInt(m.created_at),
    mentions: mentionData,
    author: {
      username: m.username, displayName: m.display_name,
      avatarDataUrl: m.avatar_data ? `data:${m.avatar_mime};base64,${m.avatar_data}` : null,
      roleColor: m.role_color || null, roleName: m.role_name || null,
      activeDecoration: m.active_decoration || null
    }
  }))});
});

// Delete a channel message
router.delete('/:id/channels/:chId/messages/:msgId', async (req, res) => {
  const { id, chId, msgId } = req.params;

  // Check membership
  const member = await pool.query(
    `SELECT sm.role, sm.role_id, sr.is_admin, sr.can_delete_messages
     FROM server_members sm
     LEFT JOIN server_roles sr ON sr.id = sm.role_id
     WHERE sm.server_id=$1 AND sm.user_id=$2`,
    [id, req.session.userId]
  );
  if (!member.rows.length) return res.status(403).json({ error: 'Not a member' });
  const m = member.rows[0];

  // Check the message exists and get its author
  const msg = await pool.query(
    'SELECT id, from_id FROM channel_messages WHERE id=$1 AND channel_id=$2',
    [msgId, chId]
  );
  if (!msg.rows.length) return res.status(404).json({ error: 'Message not found' });

  const isOwn = msg.rows[0].from_id === req.session.userId;
  const isAdmin = m.role === 'admin' || m.is_admin;
  const canDelete = m.can_delete_messages;

  if (!isOwn && !isAdmin && !canDelete) {
    return res.status(403).json({ error: 'No permission to delete this message' });
  }

  await pool.query('DELETE FROM channel_messages WHERE id=$1', [msgId]);
  res.json({ success: true });
});

module.exports = router;
