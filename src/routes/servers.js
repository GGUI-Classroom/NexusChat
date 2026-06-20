const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../models/db');
const { requireAuth } = require('../middleware/auth');
const { syncAll } = require('./achievements');

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
    inviteCode: s.invite_code, createdAt: s.created_at,
    tag: s.server_tag || null
  };
}

async function activeBoostCount(serverId) {
  const now = Math.floor(Date.now() / 1000);
  const result = await pool.query('SELECT COUNT(*)::int AS count FROM server_boosts WHERE server_id=$1 AND expires_at>$2', [serverId, now]);
  return result.rows[0]?.count || 0;
}

async function activeBoostFeatures(serverId) {
  const count = await activeBoostCount(serverId);
  const allocations = await pool.query('SELECT feature FROM server_boost_allocations WHERE server_id=$1 ORDER BY created_at ASC', [serverId]);
  return new Set(allocations.rows.slice(0, Math.floor(count / 2)).map(row => row.feature));
}

function roleForClient(role, gradientsEnabled) {
  return {
    id: role.id,
    name: role.name,
    color: role.color,
    isAdmin: role.is_admin,
    position: role.position,
    canDeleteMessages: !!role.can_delete_messages,
    gradientStart: gradientsEnabled ? role.gradient_start : null,
    gradientEnd: gradientsEnabled ? role.gradient_end : null,
    gradientAnimated: gradientsEnabled && !!role.gradient_animated
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
    await pool.query(`INSERT INTO channels (id, server_id, name, position, channel_type) VALUES ($1,$2,'general',0,'text')`, [uuidv4(), id]);
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
  const [sRes, chRes, memRes, roleRes, boostRes] = await Promise.all([
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
       u.id, u.username, u.display_name, u.avatar_data, u.avatar_mime, CASE WHEN u.id=$2 THEN 'online' ELSE u.status END AS status, u.active_decoration, u.active_color
       FROM server_members sm
       JOIN users u ON u.id=sm.user_id
       LEFT JOIN server_roles sr ON sr.id=sm.role_id
        WHERE sm.server_id=$1 ORDER BY u.display_name ASC`, [id, req.session.userId]
    ),
    pool.query('SELECT * FROM server_roles WHERE server_id=$1 ORDER BY position ASC', [id]),
    activeBoostFeatures(id)
  ]);
  if (!sRes.rows.length) return res.status(404).json({ error: 'Not found' });
  const blockedWordsRes = await pool.query('SELECT word FROM server_blocked_words WHERE server_id=$1 ORDER BY word ASC', [id]);
  res.json({
    server: { ...fmtServer(sRes.rows[0]), boostCount: await activeBoostCount(id), tag: boostRes.has('tag') ? sRes.rows[0].server_tag : null, tagBackground: sRes.rows[0].tag_background || '#5865f2', boostFeatures: [...boostRes] },
    botConfig: {
      name: 'NexusGuard',
      prefix: sRes.rows[0].bot_prefix || '/',
      enabled: sRes.rows[0].bot_enabled !== false,
      automod: sRes.rows[0].bot_auto_mod !== false,
      blockLinks: !!sRes.rows[0].bot_block_links,
      capsThreshold: Math.min(100, Math.max(50, parseInt(sRes.rows[0].bot_caps_threshold, 10) || 90)),
      spamWindow: Math.min(20, Math.max(3, parseInt(sRes.rows[0].bot_spam_window, 10) || 6)),
      blockedWords: blockedWordsRes.rows.map(w => w.word),
      modLogChannelId: sRes.rows[0].mod_log_channel_id || null
    },
    channels: chRes.rows.filter(c => c.can_view).map(c => ({
      id: c.id,
      name: c.name,
      type: c.channel_type || 'text',
      position: c.position,
      locked: !!c.locked,
      private: !!c.private,
      topic: c.topic || null,
      slowmodeSeconds: Math.max(0, parseInt(c.slowmode_seconds, 10) || 0)
    })),
    members: memRes.rows.map(m => ({
      id: m.id, username: m.username, displayName: m.display_name,
      avatarDataUrl: m.avatar_data ? `data:${m.avatar_mime};base64,${m.avatar_data}` : null,
      status: m.status, role: m.role, roleId: m.role_id,
      roleName: m.role_name, roleColor: m.role_color, isAdmin: m.is_admin,
      activeDecoration: m.active_decoration || null,
      activeColor: m.active_color || null,
      activeColor: m.active_color || null,
      activeFont: m.active_font || null
    })),
    roles: roleRes.rows.map(r => roleForClient(r, boostRes.has('gradients')))
  });
});

router.get('/:id/bot-config', async (req, res) => {
  const { id } = req.params;
  const member = await pool.query('SELECT id FROM server_members WHERE server_id=$1 AND user_id=$2', [id, req.session.userId]);
  if (!member.rows.length) return res.status(403).json({ error: 'Not a member' });
  const s = await pool.query(
    `SELECT bot_prefix, bot_enabled, bot_auto_mod, bot_block_links,
            bot_caps_threshold, bot_spam_window, mod_log_channel_id
     FROM servers WHERE id=$1`,
    [id]
  );
  const blockedWordsRes = await pool.query('SELECT word FROM server_blocked_words WHERE server_id=$1 ORDER BY word ASC', [id]);
  if (!s.rows.length) return res.status(404).json({ error: 'Server not found' });
  const row = s.rows[0];
  res.json({
    config: {
      name: 'NexusGuard',
      prefix: row.bot_prefix || '/',
      enabled: row.bot_enabled !== false,
      automod: row.bot_auto_mod !== false,
      blockLinks: !!row.bot_block_links,
      capsThreshold: Math.min(100, Math.max(50, parseInt(row.bot_caps_threshold, 10) || 90)),
      spamWindow: Math.min(20, Math.max(3, parseInt(row.bot_spam_window, 10) || 6)),
      blockedWords: blockedWordsRes.rows.map(w => w.word),
      modLogChannelId: row.mod_log_channel_id || null
    }
  });
});

router.patch('/:id/bot-config', async (req, res) => {
  const { id } = req.params;
  if (!await isAdmin(id, req.session.userId)) return res.status(403).json({ error: 'Admins only' });

  const prefixRaw = (req.body.prefix || '/').toString().trim();
  const prefix = (prefixRaw.slice(0, 2) || '/');
  const enabled = req.body.enabled !== false;
  const automod = req.body.automod !== false;
  const blockLinks = !!req.body.blockLinks;
  const capsThreshold = Math.min(100, Math.max(50, parseInt(req.body.capsThreshold, 10) || 90));
  const spamWindow = Math.min(20, Math.max(3, parseInt(req.body.spamWindow, 10) || 6));
  const blockedWords = Array.isArray(req.body.blockedWords)
    ? req.body.blockedWords.map(w => String(w || '').trim().toLowerCase()).filter(w => w.length >= 2 && w.length <= 40)
    : null;

  await pool.query(
    `UPDATE servers
     SET bot_prefix=$1,
         bot_enabled=$2,
         bot_auto_mod=$3,
         bot_block_links=$4,
         bot_caps_threshold=$5,
         bot_spam_window=$6
     WHERE id=$7`,
    [prefix, enabled, automod, blockLinks, capsThreshold, spamWindow, id]
  );

  if (blockedWords) {
    await pool.query('DELETE FROM server_blocked_words WHERE server_id=$1', [id]);
    for (const word of blockedWords) {
      await pool.query(
        `INSERT INTO server_blocked_words (id, server_id, word, created_by)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (server_id, word) DO NOTHING`,
        [uuidv4(), id, word, req.session.userId]
      );
    }
  }

  res.json({
    success: true,
    config: {
      name: 'NexusGuard',
      prefix,
      enabled,
      automod,
      blockLinks,
      capsThreshold,
      spamWindow,
      blockedWords: blockedWords || undefined
    }
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
  const rawType = String(req.body.type || 'text').toLowerCase();
  const channelType = rawType === 'voice' ? 'voice' : 'text';
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  if (!await isAdmin(id, req.session.userId)) return res.status(403).json({ error: 'Admins only' });
  const pos = await pool.query('SELECT COUNT(*) FROM channels WHERE server_id=$1', [id]);
  const chId = uuidv4();
  const chName = name.trim().toLowerCase().replace(/\s+/g,'-');
  await pool.query(
    'INSERT INTO channels (id, server_id, name, position, channel_type) VALUES ($1,$2,$3,$4,$5)',
    [chId, id, chName, parseInt(pos.rows[0].count), channelType]
  );
  res.json({ channel: { id: chId, name: chName, type: channelType, serverId: id } });
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
  const [r, boosts] = await Promise.all([
    pool.query('SELECT * FROM server_roles WHERE server_id=$1 ORDER BY position ASC', [id]),
    activeBoostCount(id)
  ]);
  res.json({ roles: r.rows.map(role => roleForClient(role, boosts >= 2)) });
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
  const { name, color, isAdmin: roleIsAdmin, gradientStart, gradientEnd, gradientAnimated } = req.body;
  const { canDeleteMessages } = req.body;
  const clearingGradient = gradientAnimated === false;
  const wantsGradient = !clearingGradient && (gradientStart || gradientEnd || gradientAnimated === true);
  if (wantsGradient) {
    if (!await isAdmin(id, req.session.userId)) return res.status(403).json({ error: 'Admins only' });
    if (!(await activeBoostFeatures(id)).has('gradients')) return res.status(403).json({ error: 'Allocate two boosts to gradients first' });
    if (!/^#[0-9a-f]{6}$/i.test(String(gradientStart || '')) || !/^#[0-9a-f]{6}$/i.test(String(gradientEnd || ''))) {
      return res.status(400).json({ error: 'Choose two valid gradient colors' });
    }
  }
  await pool.query(
    `UPDATE server_roles SET
      name=COALESCE($1,name),
      color=COALESCE($2,color),
      is_admin=COALESCE($3,is_admin),
      can_delete_messages=COALESCE($4,can_delete_messages),
      gradient_start=CASE WHEN $5 THEN $6 WHEN $9 THEN NULL ELSE gradient_start END,
      gradient_end=CASE WHEN $5 THEN $7 WHEN $9 THEN NULL ELSE gradient_end END,
      gradient_animated=CASE WHEN $5 THEN $8 WHEN $9 THEN FALSE ELSE gradient_animated END
     WHERE id=$10 AND server_id=$11`,
    [name || null, color || null,
     roleIsAdmin != null ? !!roleIsAdmin : null,
     canDeleteMessages != null ? !!canDeleteMessages : null,
     wantsGradient, gradientStart || null, gradientEnd || null, !!gradientAnimated, clearingGradient,
     roleId, id]
  );
  const r = await pool.query('SELECT * FROM server_roles WHERE id=$1', [roleId]);
  res.json({ role: roleForClient(r.rows[0], (await activeBoostFeatures(id)).has('gradients')) });
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
  await syncAll(userId);
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
  await syncAll(req.session.userId);
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

// Update channel settings (topic + slowmode)
router.patch('/:id/channels/:chId/settings', async (req, res) => {
  const { id, chId } = req.params;
  if (!await isAdmin(id, req.session.userId)) return res.status(403).json({ error: 'Admins only' });

  const topicRaw = typeof req.body.topic === 'string' ? req.body.topic.trim() : '';
  const topic = topicRaw.length ? topicRaw.slice(0, 200) : null;
  const slowmodeSeconds = Math.min(120, Math.max(0, parseInt(req.body.slowmodeSeconds, 10) || 0));

  const updated = await pool.query(
    `UPDATE channels
     SET topic=$1, slowmode_seconds=$2
     WHERE id=$3 AND server_id=$4
     RETURNING id, name, position, locked, private, channel_type, topic, slowmode_seconds`,
    [topic, slowmodeSeconds, chId, id]
  );
  if (!updated.rows.length) return res.status(404).json({ error: 'Channel not found' });

  const ch = updated.rows[0];
  res.json({
    success: true,
    channel: {
      id: ch.id,
      name: ch.name,
      type: ch.channel_type || 'text',
      position: ch.position,
      locked: !!ch.locked,
      private: !!ch.private,
      topic: ch.topic || null,
      slowmodeSeconds: Math.max(0, parseInt(ch.slowmode_seconds, 10) || 0)
    }
  });
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
  const channelMeta = await pool.query('SELECT channel_type FROM channels WHERE id=$1 AND server_id=$2', [chId, id]);
  if (!channelMeta.rows.length) return res.status(404).json({ error: 'Channel not found' });
  if ((channelMeta.rows[0].channel_type || 'text') === 'voice') return res.json({ messages: [] });
  let q = `SELECT cm.id, cm.channel_id, cm.from_id, cm.content, cm.created_at, cm.reply_to_id,
    u.username, u.display_name, u.avatar_data, u.avatar_mime, u.active_decoration, u.active_color, u.active_font,
    sm.role_id, sr.name as role_name, sr.color as role_color,
    rm.content as reply_content,
    rm.from_id as reply_from_id,
    ru.display_name as reply_display_name,
    ru.username as reply_username,
    COALESCE(react.reactions, '[]'::json) as reactions,
    EXISTS (
      SELECT 1 FROM channel_pins cp
      WHERE cp.channel_id=cm.channel_id AND cp.message_id=cm.id
    ) as is_pinned
    FROM channel_messages cm
    JOIN channels chv ON chv.id=cm.channel_id AND chv.server_id=$1
    JOIN users u ON u.id=cm.from_id
    LEFT JOIN server_members sm ON sm.server_id=$1 AND sm.user_id=cm.from_id
    LEFT JOIN server_roles sr ON sr.id=sm.role_id
    LEFT JOIN channel_messages rm ON rm.id=cm.reply_to_id
    LEFT JOIN users ru ON ru.id=rm.from_id
    LEFT JOIN LATERAL (
      SELECT json_agg(
        json_build_object('emoji', r.emoji, 'count', r.cnt, 'reacted', r.reacted)
        ORDER BY r.cnt DESC, r.emoji ASC
      ) as reactions
      FROM (
        SELECT cmr.emoji,
               COUNT(*)::int as cnt,
               BOOL_OR(cmr.user_id=$3) as reacted
        FROM channel_message_reactions cmr
        WHERE cmr.message_id = cm.id
        GROUP BY cmr.emoji
      ) r
    ) react ON true
    WHERE cm.channel_id=$2`;
  const params = [id, chId, req.session.userId];
  if (before) { params.push(parseInt(before)); q += ` AND cm.created_at < $${params.length}`; }
  q += ` ORDER BY cm.created_at DESC LIMIT $${params.length+1}`;
  params.push(parseInt(limit));
  const r = await pool.query(q, params);
  const messages = r.rows.reverse();
  res.json({ messages: messages.map(m => ({
    id: m.id, channelId: m.channel_id, fromId: m.from_id,
    content: m.content, createdAt: parseInt(m.created_at),
    isPinned: !!m.is_pinned,
    reactions: Array.isArray(m.reactions) ? m.reactions : [],
    replyTo: m.reply_to_id ? {
      id: m.reply_to_id,
      fromId: m.reply_from_id || null,
      displayName: m.reply_display_name || m.reply_username || 'Unknown user',
      content: m.reply_content || '[Original message unavailable]'
    } : null,
    author: {
      username: m.username, displayName: m.display_name,
      avatarDataUrl: m.avatar_data ? `data:${m.avatar_mime};base64,${m.avatar_data}` : null,
      roleColor: m.role_color || null, roleName: m.role_name || null,
      activeDecoration: m.active_decoration || null,
      activeColor: m.active_color || null,
      activeColor: m.active_color || null,
      activeFont: m.active_font || null
    }
  }))});
});

// Get pinned messages for a channel
router.get('/:id/channels/:chId/pins', async (req, res) => {
  const { id, chId } = req.params;
  const member = await pool.query('SELECT id FROM server_members WHERE server_id=$1 AND user_id=$2', [id, req.session.userId]);
  if (!member.rows.length) return res.status(403).json({ error: 'Not a member' });

  const r = await pool.query(
    `SELECT cp.message_id, cp.pinned_at, cp.pinned_by,
            cm.from_id, cm.content, cm.created_at,
            u.username, u.display_name
     FROM channel_pins cp
     JOIN channels ch ON ch.id=cp.channel_id AND ch.server_id=$2
     JOIN channel_messages cm ON cm.id=cp.message_id
     JOIN users u ON u.id=cm.from_id
     WHERE cp.channel_id=$1
     ORDER BY cp.pinned_at DESC
     LIMIT 50`,
    [chId, id]
  );

  res.json({
    pins: r.rows.map(p => ({
      messageId: p.message_id,
      pinnedAt: parseInt(p.pinned_at),
      pinnedBy: p.pinned_by,
      fromId: p.from_id,
      content: p.content,
      createdAt: parseInt(p.created_at),
      author: {
        username: p.username,
        displayName: p.display_name
      }
    }))
  });
});

// Pin a message (admins only)
router.post('/:id/channels/:chId/messages/:msgId/pin', async (req, res) => {
  const { id, chId, msgId } = req.params;
  if (!await isAdmin(id, req.session.userId)) return res.status(403).json({ error: 'Admins only' });

  const msg = await pool.query(
    `SELECT cm.id
     FROM channel_messages cm
     JOIN channels ch ON ch.id=cm.channel_id
     WHERE cm.id=$1 AND cm.channel_id=$2 AND ch.server_id=$3`,
    [msgId, chId, id]
  );
  if (!msg.rows.length) return res.status(404).json({ error: 'Message not found' });

  const now = Math.floor(Date.now() / 1000);
  await pool.query(
    `INSERT INTO channel_pins (id, channel_id, message_id, pinned_by, pinned_at)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (channel_id, message_id)
     DO UPDATE SET pinned_by=$4, pinned_at=$5`,
    [uuidv4(), chId, msgId, req.session.userId, now]
  );
  res.json({ success: true, pinnedAt: now });
});

// Unpin a message (admins only)
router.delete('/:id/channels/:chId/messages/:msgId/pin', async (req, res) => {
  const { id, chId, msgId } = req.params;
  if (!await isAdmin(id, req.session.userId)) return res.status(403).json({ error: 'Admins only' });
  await pool.query(
    `DELETE FROM channel_pins cp
     USING channels ch
     WHERE cp.channel_id=ch.id
       AND cp.channel_id=$1
       AND cp.message_id=$2
       AND ch.server_id=$3`,
    [chId, msgId, id]
  );
  res.json({ success: true });
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
