const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../models/db');
const { requireAuth } = require('../middleware/auth');
const { syncAll } = require('./achievements');
const { avatarUrl } = require('../utils/avatar');
const { enforceGlobalSafety } = require('../utils/globalSafety');

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
    tag: s.server_tag || null,
    tagPrivate: !!s.tag_private,
    inviteDescription: s.invite_description || '',
    inviteTags: s.invite_tags || '',
    inviteBannerMode: s.invite_banner_mode || 'solid',
    inviteBannerStart: s.invite_banner_start || '#5865f2',
    inviteBannerEnd: s.invite_banner_end || '#a855f7',
    inviteBannerImage: s.invite_banner_image || null
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
    displaySeparately: !!role.display_separately,
    canDeleteMessages: !!role.can_delete_messages,
    permissions: {
      manageChannels: !!role.can_manage_channels,
      manageRoles: !!role.can_manage_roles,
      kickMembers: !!role.can_kick_members,
      banMembers: !!role.can_ban_members,
      manageMessages: !!role.can_manage_messages,
      mentionEveryone: !!role.can_mention_everyone,
      createInvites: !!role.can_create_invites,
      connectVoice: role.can_connect_voice !== false,
      createForumPosts: role.can_create_forum_posts !== false,
      replyForumPosts: role.can_reply_forum_posts !== false,
      lockForumPosts: !!role.can_lock_forum_posts
    },
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

async function hasPermission(serverId, userId, permission) {
  if (await isAdmin(serverId, userId)) return true;
  const allowed = new Set([
    'can_manage_channels', 'can_manage_roles', 'can_kick_members', 'can_ban_members',
    'can_manage_messages', 'can_mention_everyone', 'can_create_invites', 'can_connect_voice',
    'can_create_forum_posts', 'can_reply_forum_posts', 'can_lock_forum_posts'
  ]);
  if (!allowed.has(permission)) return false;
  const result = await pool.query(
    `SELECT 1 FROM server_member_roles smr
     JOIN server_roles sr ON sr.id=smr.role_id
     WHERE smr.server_id=$1 AND smr.user_id=$2 AND sr.${permission}=TRUE LIMIT 1`,
    [serverId, userId]
  );
  if (result.rows.length) return true;
  if (permission === 'can_create_invites' || permission === 'can_connect_voice' ||
      permission === 'can_create_forum_posts' || permission === 'can_reply_forum_posts') {
    const assigned = await pool.query(
      'SELECT 1 FROM server_member_roles WHERE server_id=$1 AND user_id=$2 LIMIT 1',
      [serverId, userId]
    );
    return !assigned.rows.length;
  }
  return false;
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
       s.name as server_name, s.icon_data, s.icon_mime, s.invite_description, s.invite_tags,
       s.invite_banner_mode, s.invite_banner_start, s.invite_banner_end, s.invite_banner_image,
       u.username as from_username, u.display_name as from_display_name,
       (u.avatar_data IS NOT NULL) as from_has_avatar
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
    inviteDescription: i.invite_description || '', inviteTags: i.invite_tags || '',
    inviteBannerMode: i.invite_banner_mode || 'solid', inviteBannerStart: i.invite_banner_start || '#5865f2',
    inviteBannerEnd: i.invite_banner_end || '#a855f7', inviteBannerImage: i.invite_banner_image || null,
    from: {
      username: i.from_username, displayName: i.from_display_name,
      avatarDataUrl: avatarUrl(i.from_id, !!i.from_has_avatar)
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
        `INSERT INTO server_roles (id, server_id, name, color, is_admin, position, display_separately, can_create_invites)
         VALUES ($1,$2,'Admin','#f05454',true,0,true,true),($3,$2,'Member','#8892a4',false,1,false,true)`,
        [adminRoleId, id, memberRoleId]
      );
      await pool.query(`UPDATE server_members SET role_id=$1 WHERE server_id=$2 AND user_id=$3`, [adminRoleId, id, req.session.userId]);
      await pool.query('INSERT INTO server_member_roles (server_id,user_id,role_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [id, req.session.userId, adminRoleId]);
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
      `SELECT sm.role, sm.role_id, sr.name as role_name, sr.color as role_color, sr.gradient_start, sr.gradient_end, sr.gradient_animated, sr.is_admin,
       COALESCE((SELECT array_agg(smr.role_id) FROM server_member_roles smr WHERE smr.server_id=sm.server_id AND smr.user_id=sm.user_id), ARRAY[]::text[]) AS role_ids,
       u.id, u.username, u.display_name, (u.avatar_data IS NOT NULL) AS has_avatar, u.discord_status, u.discord_activity, CASE WHEN u.id=$2 THEN 'online' ELSE u.status END AS status, u.active_decoration, u.active_nameplate, u.active_color, ats.id AS tag_server_id, ats.name AS tag_server_name, ats.invite_code AS tag_invite_code, ats.server_tag, ats.tag_background, ats.tag_private
       FROM server_members sm
       JOIN users u ON u.id=sm.user_id
       LEFT JOIN server_roles sr ON sr.id=sm.role_id
       LEFT JOIN servers ats ON ats.id=u.active_server_tag_id
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
      avatarDataUrl: avatarUrl(m.id, !!m.has_avatar),
      status: m.status, discordStatus: m.discord_status || 'offline', discordActivity: m.discord_activity || null, role: m.role, roleId: m.role_id, roleIds: m.role_ids || [],
      roleName: m.role_name, roleColor: m.role_color, roleGradientStart: boostRes.has('gradients') ? m.gradient_start : null, roleGradientEnd: boostRes.has('gradients') ? m.gradient_end : null, isAdmin: m.is_admin,
      activeDecoration: m.active_decoration || null,
      activeNameplate: m.active_nameplate || null,
      activeColor: m.active_color || null,
      activeColor: m.active_color || null,
      activeFont: m.active_font || null,
      activeServerTag: m.server_tag || null, activeServerTagBackground: m.tag_background || '#5865f2', activeServerTagServerId: m.tag_server_id || null, activeServerTagServerName: m.tag_private ? null : (m.tag_server_name || null), activeServerTagInviteCode: m.tag_private ? null : (m.tag_invite_code || null), activeServerTagPrivate: !!m.tag_private
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
  const channelType = ['voice', 'forum'].includes(rawType) ? rawType : 'text';
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  if (!await hasPermission(id, req.session.userId, 'can_manage_channels')) return res.status(403).json({ error: 'You need Manage Channels permission' });
  const pos = await pool.query('SELECT COUNT(*) FROM channels WHERE server_id=$1', [id]);
  const chId = uuidv4();
  const chName = name.trim().toLowerCase().replace(/\s+/g,'-');
  await pool.query(
    'INSERT INTO channels (id, server_id, name, position, channel_type) VALUES ($1,$2,$3,$4,$5)',
    [chId, id, chName, parseInt(pos.rows[0].count), channelType]
  );
  res.json({ channel: { id: chId, name: chName, type: channelType, serverId: id } });
});

router.patch('/:id/invite-style', async (req, res) => {
  const { id } = req.params;
  if (!await isAdmin(id, req.session.userId)) return res.status(403).json({ error: 'Admins only' });
  const description = String(req.body.description || '').trim().slice(0, 180);
  const tags = String(req.body.tags || '').split(',').map(tag => tag.trim().replace(/[^a-z0-9 _-]/gi, '').slice(0, 18)).filter(Boolean).slice(0, 5).join(', ');
  const mode = String(req.body.bannerMode || 'solid');
  const start = /^#[0-9a-f]{6}$/i.test(String(req.body.bannerStart || '')) ? req.body.bannerStart : '#5865f2';
  const end = /^#[0-9a-f]{6}$/i.test(String(req.body.bannerEnd || '')) ? req.body.bannerEnd : '#a855f7';
  const image = String(req.body.bannerImage || '').trim().slice(0, 2000);
  const tagPrivate = req.body.tagPrivate === true;
  if (!['solid', 'gradient', 'image'].includes(mode)) return res.status(400).json({ error: 'Invalid invite banner mode' });
  if (mode === 'image' && !/^https:\/\/.+/i.test(image)) return res.status(400).json({ error: 'Banner image must use a secure https URL' });
  if (mode !== 'solid') {
    const features = await activeBoostFeatures(id);
    if (!features.has('invite_banner')) return res.status(403).json({ error: 'Spend two boosts on Invite Banners before using gradients or images' });
  }
  await pool.query(`UPDATE servers SET invite_description=$1, invite_tags=$2, invite_banner_mode=$3,
    invite_banner_start=$4, invite_banner_end=$5, invite_banner_image=$6, tag_private=$7 WHERE id=$8`,
  [description || null, tags, mode, start, end, mode === 'image' ? image : null, tagPrivate, id]);
  const updated = await pool.query('SELECT * FROM servers WHERE id=$1', [id]);
  res.json({ success: true, server: fmtServer(updated.rows[0]) });
});

// Persist an admin-controlled channel order.
router.put('/:id/channels/order', async (req, res) => {
  const { id } = req.params;
  const channelIds = Array.isArray(req.body.channelIds) ? req.body.channelIds : [];
  if (!await hasPermission(id, req.session.userId, 'can_manage_channels')) return res.status(403).json({ error: 'You need Manage Channels permission' });
  const existing = await pool.query('SELECT id FROM channels WHERE server_id=$1 ORDER BY position ASC', [id]);
  const existingIds = existing.rows.map(row => row.id);
  if (channelIds.length !== existingIds.length || channelIds.some(chId => !existingIds.includes(chId))) {
    return res.status(400).json({ error: 'Channel order does not match this server' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let index = 0; index < channelIds.length; index++) {
      await client.query('UPDATE channels SET position=$1 WHERE id=$2 AND server_id=$3', [index, channelIds[index], id]);
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Could not save channel order' });
  } finally { client.release(); }
});

// Delete channel
router.delete('/:id/channels/:chId', async (req, res) => {
  const { id, chId } = req.params;
  if (!await hasPermission(id, req.session.userId, 'can_manage_channels')) return res.status(403).json({ error: 'You need Manage Channels permission' });
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
  if (!await hasPermission(id, req.session.userId, 'can_manage_roles')) return res.status(403).json({ error: 'You need Manage Roles permission' });
  const { name, color, isAdmin: roleIsAdmin } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  if (roleIsAdmin && !await isAdmin(id, req.session.userId)) return res.status(403).json({ error: 'Only administrators can create administrator roles' });
  const pos = await pool.query('SELECT COUNT(*) FROM server_roles WHERE server_id=$1', [id]);
  const roleId = uuidv4();
  const canDelete = req.body.canDeleteMessages || false;
  await pool.query(
    'INSERT INTO server_roles (id, server_id, name, color, is_admin, position, can_delete_messages, display_separately) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [roleId, id, name.trim(), color || '#8892a4', !!roleIsAdmin, parseInt(pos.rows[0].count), !!canDelete, !!roleIsAdmin]
  );
  res.json({ role: { id: roleId, name: name.trim(), color: color || '#8892a4', isAdmin: !!roleIsAdmin, canDeleteMessages: !!canDelete, displaySeparately: !!roleIsAdmin } });
});

// Update role
router.patch('/:id/roles/:roleId', async (req, res) => {
  const { id, roleId } = req.params;
  if (!await hasPermission(id, req.session.userId, 'can_manage_roles')) return res.status(403).json({ error: 'You need Manage Roles permission' });
  const { name, color, isAdmin: roleIsAdmin, gradientStart, gradientEnd, gradientAnimated, displaySeparately } = req.body;
  const existingRole = await pool.query('SELECT is_admin FROM server_roles WHERE id=$1 AND server_id=$2', [roleId, id]);
  if (!existingRole.rows.length) return res.status(404).json({ error: 'Role not found' });
  if ((existingRole.rows[0].is_admin || roleIsAdmin === true) && !await isAdmin(id, req.session.userId)) {
    return res.status(403).json({ error: 'Only administrators can edit administrator roles' });
  }
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
  const separate = displaySeparately != null ? !!displaySeparately : null;
  const base = [name || null, color || null, roleIsAdmin != null ? !!roleIsAdmin : null, canDeleteMessages != null ? !!canDeleteMessages : null, separate, roleId, id];
  if (wantsGradient) {
    await pool.query(`UPDATE server_roles SET name=COALESCE($1,name), color=COALESCE($2,color), is_admin=COALESCE($3,is_admin), can_delete_messages=COALESCE($4,can_delete_messages), display_separately=COALESCE($5,display_separately), gradient_start=$6, gradient_end=$7, gradient_animated=TRUE WHERE id=$8 AND server_id=$9`, [...base.slice(0, 5), gradientStart, gradientEnd, roleId, id]);
  } else if (clearingGradient) {
    await pool.query(`UPDATE server_roles SET name=COALESCE($1,name), color=COALESCE($2,color), is_admin=COALESCE($3,is_admin), can_delete_messages=COALESCE($4,can_delete_messages), display_separately=COALESCE($5,display_separately), gradient_start=NULL, gradient_end=NULL, gradient_animated=FALSE WHERE id=$6 AND server_id=$7`, base);
  } else {
    await pool.query(`UPDATE server_roles SET name=COALESCE($1,name), color=COALESCE($2,color), is_admin=COALESCE($3,is_admin), can_delete_messages=COALESCE($4,can_delete_messages), display_separately=COALESCE($5,display_separately) WHERE id=$6 AND server_id=$7`, base);
  }
  const r = await pool.query('SELECT * FROM server_roles WHERE id=$1', [roleId]);
  if (req.body.permissions && typeof req.body.permissions === 'object') {
    const p = req.body.permissions;
    await pool.query(
      `UPDATE server_roles SET can_manage_channels=$1, can_manage_roles=$2, can_kick_members=$3,
       can_ban_members=$4, can_manage_messages=$5, can_mention_everyone=$6,
       can_create_invites=$7, can_connect_voice=$8, can_create_forum_posts=$9,
       can_reply_forum_posts=$10, can_lock_forum_posts=$11 WHERE id=$12 AND server_id=$13`,
      [!!p.manageChannels, !!p.manageRoles, !!p.kickMembers, !!p.banMembers,
       !!p.manageMessages, !!p.mentionEveryone, !!p.createInvites, p.connectVoice !== false,
       p.createForumPosts !== false, p.replyForumPosts !== false, !!p.lockForumPosts, roleId, id]
    );
  }
  const updatedRole = await pool.query('SELECT * FROM server_roles WHERE id=$1', [roleId]);
  res.json({ role: roleForClient(updatedRole.rows[0], (await activeBoostFeatures(id)).has('gradients')) });
});

// Delete role
router.delete('/:id/roles/:roleId', async (req, res) => {
  const { id, roleId } = req.params;
  if (!await hasPermission(id, req.session.userId, 'can_manage_roles')) return res.status(403).json({ error: 'You need Manage Roles permission' });
  const deletingRole = await pool.query('SELECT is_admin FROM server_roles WHERE id=$1 AND server_id=$2', [roleId, id]);
  if (deletingRole.rows[0]?.is_admin && !await isAdmin(id, req.session.userId)) return res.status(403).json({ error: 'Only administrators can delete administrator roles' });
  // Unassign from members first
  await pool.query('UPDATE server_members SET role_id=NULL WHERE server_id=$1 AND role_id=$2', [id, roleId]);
  await pool.query('DELETE FROM server_roles WHERE id=$1 AND server_id=$2', [roleId, id]);
  res.json({ success: true });
});

// Assign role to member
router.patch('/:id/members/:userId/role', async (req, res) => {
  const { id, userId } = req.params;
  if (!await hasPermission(id, req.session.userId, 'can_manage_roles')) return res.status(403).json({ error: 'You need Manage Roles permission' });
  const { roleId } = req.body;
  // Validate role belongs to server
  if (roleId) {
    const role = await pool.query('SELECT id, is_admin FROM server_roles WHERE id=$1 AND server_id=$2', [roleId, id]);
    if (!role.rows.length) return res.status(400).json({ error: 'Role not found' });
    if (role.rows[0].is_admin && !await isAdmin(id, req.session.userId)) return res.status(403).json({ error: 'Only administrators can assign administrator roles' });
    const newRole = role.rows[0].is_admin ? 'admin' : 'member';
    await pool.query('UPDATE server_members SET role_id=$1, role=$2 WHERE server_id=$3 AND user_id=$4', [roleId, newRole, id, userId]);
    await pool.query('INSERT INTO server_member_roles (server_id,user_id,role_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [id, userId, roleId]);
  } else {
    await pool.query('UPDATE server_members SET role_id=NULL, role=\'member\' WHERE server_id=$1 AND user_id=$2', [id, userId]);
  }
  await syncAll(userId);
  res.json({ success: true });
});

router.post('/:id/members/:userId/roles/:roleId', async (req, res) => {
  const { id, userId, roleId } = req.params;
  if (!await hasPermission(id, req.session.userId, 'can_manage_roles')) return res.status(403).json({ error: 'You need Manage Roles permission' });
  const serverOwner = await pool.query('SELECT owner_id FROM servers WHERE id=$1', [id]);
  if (serverOwner.rows[0]?.owner_id === userId && userId !== req.session.userId) return res.status(403).json({ error: 'The server owner manages their own roles' });
  const [member, role] = await Promise.all([
    pool.query('SELECT id, role_id FROM server_members WHERE server_id=$1 AND user_id=$2', [id, userId]),
    pool.query('SELECT id, is_admin FROM server_roles WHERE server_id=$1 AND id=$2', [id, roleId])
  ]);
  if (!member.rows.length || !role.rows.length) return res.status(404).json({ error: 'Member or role not found' });
  if (role.rows[0].is_admin && !await isAdmin(id, req.session.userId)) return res.status(403).json({ error: 'Only administrators can assign administrator roles' });
  await pool.query('INSERT INTO server_member_roles (server_id,user_id,role_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [id, userId, roleId]);
  if (!member.rows[0].role_id) {
    await pool.query('UPDATE server_members SET role_id=$1, role=$2 WHERE server_id=$3 AND user_id=$4', [roleId, role.rows[0].is_admin ? 'admin' : 'member', id, userId]);
  } else if (role.rows[0].is_admin) {
    await pool.query("UPDATE server_members SET role='admin' WHERE server_id=$1 AND user_id=$2", [id, userId]);
  }
  res.json({ success: true });
});

router.delete('/:id/members/:userId/roles/:roleId', async (req, res) => {
  const { id, userId, roleId } = req.params;
  if (!await hasPermission(id, req.session.userId, 'can_manage_roles')) return res.status(403).json({ error: 'You need Manage Roles permission' });
  const serverOwner = await pool.query('SELECT owner_id FROM servers WHERE id=$1', [id]);
  if (serverOwner.rows[0]?.owner_id === userId && userId !== req.session.userId) return res.status(403).json({ error: 'The server owner manages their own roles' });
  await pool.query('DELETE FROM server_member_roles WHERE server_id=$1 AND user_id=$2 AND role_id=$3', [id, userId, roleId]);
  const stillAdmin = await pool.query(
    `SELECT 1 FROM server_member_roles smr JOIN server_roles sr ON sr.id=smr.role_id
     WHERE smr.server_id=$1 AND smr.user_id=$2 AND sr.is_admin=TRUE LIMIT 1`,
    [id, userId]
  );
  await pool.query('UPDATE server_members SET role=$1 WHERE server_id=$2 AND user_id=$3', [stillAdmin.rows.length ? 'admin' : 'member', id, userId]);
  const member = await pool.query('SELECT role_id FROM server_members WHERE server_id=$1 AND user_id=$2', [id, userId]);
  if (member.rows[0]?.role_id === roleId) {
    const next = await pool.query(
      `SELECT sr.id, sr.is_admin FROM server_member_roles smr JOIN server_roles sr ON sr.id=smr.role_id
       WHERE smr.server_id=$1 AND smr.user_id=$2 ORDER BY sr.position ASC LIMIT 1`,
      [id, userId]
    );
    await pool.query('UPDATE server_members SET role_id=$1, role=$2 WHERE server_id=$3 AND user_id=$4', [
      next.rows[0]?.id || null, next.rows[0]?.is_admin ? 'admin' : 'member', id, userId
    ]);
  }
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
  if (!await hasPermission(id, req.session.userId, 'can_create_invites')) return res.status(403).json({ error: 'You need Create Invites permission' });
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
        inviteDescription: s.invite_description || '', inviteTags: s.invite_tags || '',
        inviteBannerMode: s.invite_banner_mode || 'solid', inviteBannerStart: s.invite_banner_start || '#5865f2',
        inviteBannerEnd: s.invite_banner_end || '#a855f7', inviteBannerImage: s.invite_banner_image || null,
        from: {
          username: u.username, displayName: u.display_name,
          avatarDataUrl: avatarUrl(req.session.userId, !!u.avatar_data)
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
  if (!await hasPermission(id, req.session.userId, 'can_kick_members')) return res.status(403).json({ error: 'You need Kick Members permission' });
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
  if (!await hasPermission(id, req.session.userId, 'can_ban_members')) return res.status(403).json({ error: 'You need Ban Members permission' });
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
  if (!await hasPermission(id, req.session.userId, 'can_manage_channels')) return res.status(403).json({ error: 'You need Manage Channels permission' });
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
  if (!await hasPermission(id, req.session.userId, 'can_manage_channels')) return res.status(403).json({ error: 'You need Manage Channels permission' });
  const { locked } = req.body;
  await pool.query('UPDATE channels SET locked=$1 WHERE id=$2 AND server_id=$3', [!!locked, chId, id]);
  res.json({ success: true, locked: !!locked });
});

// Set channel private state
router.patch('/:id/channels/:chId/private', async (req, res) => {
  const { id, chId } = req.params;
  if (!await hasPermission(id, req.session.userId, 'can_manage_channels')) return res.status(403).json({ error: 'You need Manage Channels permission' });
  const { private: isPrivate } = req.body;
  await pool.query('UPDATE channels SET private=$1 WHERE id=$2 AND server_id=$3', [!!isPrivate, chId, id]);
  res.json({ success: true, private: !!isPrivate });
});

// Update channel settings (topic + slowmode)
router.patch('/:id/channels/:chId/settings', async (req, res) => {
  const { id, chId } = req.params;
  if (!await hasPermission(id, req.session.userId, 'can_manage_channels')) return res.status(403).json({ error: 'You need Manage Channels permission' });

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
  if (!await hasPermission(id, req.session.userId, 'can_manage_channels')) return res.status(403).json({ error: 'You need Manage Channels permission' });
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
  if (!await hasPermission(id, req.session.userId, 'can_manage_channels')) return res.status(403).json({ error: 'You need Manage Channels permission' });
  await pool.query('DELETE FROM channel_permissions WHERE channel_id=$1 AND role_id=$2', [chId, roleId]);
  res.json({ success: true });
});

async function requireForumAccess(serverId, channelId, userId) {
  const result = await pool.query(
    `SELECT c.id FROM channels c
     JOIN server_members sm ON sm.server_id=c.server_id AND sm.user_id=$3
     WHERE c.server_id=$1 AND c.id=$2 AND c.channel_type='forum'`,
    [serverId, channelId, userId]
  );
  return !!result.rows.length;
}

router.get('/:id/channels/:chId/forum/posts', async (req, res) => {
  const { id, chId } = req.params;
  if (!await requireForumAccess(id, chId, req.session.userId)) return res.status(403).json({ error: 'Forum unavailable' });
  const result = await pool.query(
    `SELECT fp.id, fp.title, fp.content, fp.created_at, fp.updated_at, fp.replies_locked,
      u.id AS author_id, u.username, u.display_name, (u.avatar_data IS NOT NULL) AS has_avatar,
      COUNT(fr.id)::int AS reply_count
     FROM forum_posts fp
     JOIN users u ON u.id=fp.author_id
     LEFT JOIN forum_replies fr ON fr.post_id=fp.id
     WHERE fp.channel_id=$1
     GROUP BY fp.id,u.id
     ORDER BY fp.updated_at DESC
     LIMIT 100`,
    [chId]
  );
  const canCreatePosts = await hasPermission(id, req.session.userId, 'can_create_forum_posts');
  res.json({ canCreatePosts, posts: result.rows.map(row => ({
    id: row.id, title: row.title, content: row.content,
    createdAt: parseInt(row.created_at), updatedAt: parseInt(row.updated_at),
    replyCount: row.reply_count, repliesLocked: !!row.replies_locked,
    author: { id: row.author_id, username: row.username, displayName: row.display_name, avatarDataUrl: avatarUrl(row.author_id, !!row.has_avatar) }
  })) });
});

router.post('/:id/channels/:chId/forum/posts', async (req, res) => {
  const { id, chId } = req.params;
  if (!await requireForumAccess(id, chId, req.session.userId)) return res.status(403).json({ error: 'Forum unavailable' });
  if (!await hasPermission(id, req.session.userId, 'can_create_forum_posts')) return res.status(403).json({ error: 'You do not have permission to create forum posts' });
  const title = String(req.body.title || '').trim().slice(0, 120);
  const content = String(req.body.content || '').trim().slice(0, 4000);
  if (!title || !content) return res.status(400).json({ error: 'A title and message are required' });
  const violation = await enforceGlobalSafety({ userId: req.session.userId, content: `${title}\n${content}`, messageType: 'forum_post', serverId: id, channelId: chId });
  if (violation) return res.status(400).json({ error: 'NexusGuard blocked this post for violating global safety rules' });
  const postId = uuidv4();
  await pool.query(
    'INSERT INTO forum_posts (id,channel_id,author_id,title,content) VALUES ($1,$2,$3,$4,$5)',
    [postId, chId, req.session.userId, title, content]
  );
  res.json({ success: true, postId });
});

router.get('/:id/channels/:chId/forum/posts/:postId', async (req, res) => {
  const { id, chId, postId } = req.params;
  if (!await requireForumAccess(id, chId, req.session.userId)) return res.status(403).json({ error: 'Forum unavailable' });
  const [post, replies] = await Promise.all([
    pool.query(
      `SELECT fp.id,fp.title,fp.content,fp.created_at,fp.replies_locked,u.id AS author_id,u.username,u.display_name,(u.avatar_data IS NOT NULL) AS has_avatar
       FROM forum_posts fp JOIN users u ON u.id=fp.author_id WHERE fp.id=$1 AND fp.channel_id=$2`,
      [postId, chId]
    ),
    pool.query(
      `SELECT fr.id,fr.content,fr.created_at,u.id AS author_id,u.username,u.display_name,(u.avatar_data IS NOT NULL) AS has_avatar
       FROM forum_replies fr JOIN users u ON u.id=fr.author_id WHERE fr.post_id=$1 ORDER BY fr.created_at ASC`,
      [postId]
    )
  ]);
  if (!post.rows.length) return res.status(404).json({ error: 'Post not found' });
  const formatAuthor = row => ({ id: row.author_id, username: row.username, displayName: row.display_name, avatarDataUrl: avatarUrl(row.author_id, !!row.has_avatar) });
  const row = post.rows[0];
  const [canReply, canLock] = await Promise.all([
    hasPermission(id, req.session.userId, 'can_reply_forum_posts'),
    hasPermission(id, req.session.userId, 'can_lock_forum_posts')
  ]);
  res.json({
    post: { id: row.id, title: row.title, content: row.content, createdAt: parseInt(row.created_at), repliesLocked: !!row.replies_locked, author: formatAuthor(row) },
    permissions: { canReply, canLock },
    replies: replies.rows.map(reply => ({ id: reply.id, content: reply.content, createdAt: parseInt(reply.created_at), author: formatAuthor(reply) }))
  });
});

router.post('/:id/channels/:chId/forum/posts/:postId/replies', async (req, res) => {
  const { id, chId, postId } = req.params;
  if (!await requireForumAccess(id, chId, req.session.userId)) return res.status(403).json({ error: 'Forum unavailable' });
  if (!await hasPermission(id, req.session.userId, 'can_reply_forum_posts')) return res.status(403).json({ error: 'You do not have permission to reply in forums' });
  const content = String(req.body.content || '').trim().slice(0, 4000);
  if (!content) return res.status(400).json({ error: 'Reply cannot be empty' });
  const violation = await enforceGlobalSafety({ userId: req.session.userId, content, messageType: 'forum_reply', serverId: id, channelId: chId });
  if (violation) return res.status(400).json({ error: 'NexusGuard blocked this reply for violating global safety rules' });
  const exists = await pool.query('SELECT id, replies_locked FROM forum_posts WHERE id=$1 AND channel_id=$2', [postId, chId]);
  if (!exists.rows.length) return res.status(404).json({ error: 'Post not found' });
  if (exists.rows[0].replies_locked) return res.status(403).json({ error: 'Replies are locked for this post' });
  await pool.query('INSERT INTO forum_replies (id,post_id,author_id,content) VALUES ($1,$2,$3,$4)', [uuidv4(), postId, req.session.userId, content]);
  await pool.query('UPDATE forum_posts SET updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id=$1', [postId]);
  res.json({ success: true });
});

router.patch('/:id/channels/:chId/forum/posts/:postId/lock', async (req, res) => {
  const { id, chId, postId } = req.params;
  if (!await requireForumAccess(id, chId, req.session.userId)) return res.status(403).json({ error: 'Forum unavailable' });
  if (!await hasPermission(id, req.session.userId, 'can_lock_forum_posts')) return res.status(403).json({ error: 'You do not have permission to manage forum replies' });
  const locked = req.body.locked === true;
  const updated = await pool.query(
    'UPDATE forum_posts SET replies_locked=$1 WHERE id=$2 AND channel_id=$3 RETURNING id',
    [locked, postId, chId]
  );
  if (!updated.rows.length) return res.status(404).json({ error: 'Post not found' });
  res.json({ success: true, repliesLocked: locked });
});

// Get channel messages
router.get('/:id/channels/:chId/messages', async (req, res) => {
  const { id, chId } = req.params;
  const { before } = req.query;
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const member = await pool.query('SELECT id FROM server_members WHERE server_id=$1 AND user_id=$2', [id, req.session.userId]);
  if (!member.rows.length) return res.status(403).json({ error: 'Not a member' });
  const channelMeta = await pool.query('SELECT channel_type FROM channels WHERE id=$1 AND server_id=$2', [chId, id]);
  if (!channelMeta.rows.length) return res.status(404).json({ error: 'Channel not found' });
  if ((channelMeta.rows[0].channel_type || 'text') === 'voice') return res.json({ messages: [] });
  let q = `SELECT cm.id, cm.channel_id, cm.from_id, cm.content, cm.created_at, cm.reply_to_id,
    u.username, u.display_name, (u.avatar_data IS NOT NULL) AS has_avatar, u.active_decoration, u.active_nameplate, u.active_color, u.active_font, u.pro_expires_at, u.profile_gradient_start, u.profile_gradient_end, u.profile_name_effect, ats.id AS tag_server_id, ats.name AS tag_server_name, ats.invite_code AS tag_invite_code, ats.server_tag, ats.tag_background, ats.tag_private,
    sm.role_id, sr.name as role_name, sr.color as role_color, sr.gradient_start as role_gradient_start, sr.gradient_end as role_gradient_end,
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
    LEFT JOIN servers ats ON ats.id=u.active_server_tag_id
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
  if (before) { params.push(parseInt(before, 10)); q += ` AND cm.created_at < $${params.length}`; }
  q += ` ORDER BY cm.created_at DESC LIMIT $${params.length+1}`;
  params.push(limit);
  const r = await pool.query(q, params);
  const messages = r.rows.reverse();
  const authors = {};
  messages.forEach(m => {
    if (!authors[m.from_id]) {
      authors[m.from_id] = {
        username: m.username, displayName: m.display_name,
        avatarDataUrl: avatarUrl(m.from_id, !!m.has_avatar),
        roleColor: m.role_color || null, roleName: m.role_name || null, roleGradientStart: m.role_gradient_start || null, roleGradientEnd: m.role_gradient_end || null,
        activeDecoration: m.active_decoration || null,
        activeNameplate: m.active_nameplate || null,
        activeColor: m.active_color || null,
        activeFont: m.active_font || null, proActive: (m.pro_expires_at || 0) > Math.floor(Date.now() / 1000), proGradientStart: m.profile_gradient_start, proGradientEnd: m.profile_gradient_end, proNameEffect: m.profile_name_effect,
        activeServerTag: m.server_tag || null, activeServerTagBackground: m.tag_background || '#5865f2', activeServerTagServerId: m.tag_server_id || null, activeServerTagServerName: m.tag_private ? null : (m.tag_server_name || null), activeServerTagInviteCode: m.tag_private ? null : (m.tag_invite_code || null), activeServerTagPrivate: !!m.tag_private
      };
    }
  });
  const allMentionedUserIds = [...new Set(messages.flatMap(m =>
    [...String(m.content || '').matchAll(/<@user:([a-f0-9-]+)>/g)].map(match => match[1])
  ))];
  const allMentionedRoleIds = [...new Set(messages.flatMap(m =>
    [...String(m.content || '').matchAll(/<@role:([a-f0-9-]+)>/g)].map(match => match[1])
  ))];
  const mentionUsers = {};
  const mentionRoles = {};
  if (allMentionedUserIds.length) {
    const mentionedUsers = await pool.query('SELECT id, username, display_name FROM users WHERE id = ANY($1)', [allMentionedUserIds]);
    mentionedUsers.rows.forEach(u => { mentionUsers[u.id] = { username: u.username, displayName: u.display_name }; });
  }
  if (allMentionedRoleIds.length) {
    const mentionedRoles = await pool.query('SELECT id, name, color FROM server_roles WHERE id = ANY($1) AND server_id = $2', [allMentionedRoleIds, id]);
    mentionedRoles.rows.forEach(r => { mentionRoles[r.id] = { name: r.name, color: r.color }; });
  }
  function mentionsForContent(content) {
    if (!String(content || '').includes('<@')) return undefined;
    const data = { users: {}, roles: {} };
    [...String(content || '').matchAll(/<@user:([a-f0-9-]+)>/g)].forEach(match => {
      if (mentionUsers[match[1]]) data.users[match[1]] = mentionUsers[match[1]];
    });
    [...String(content || '').matchAll(/<@role:([a-f0-9-]+)>/g)].forEach(match => {
      if (mentionRoles[match[1]]) data.roles[match[1]] = mentionRoles[match[1]];
    });
    return Object.keys(data.users).length || Object.keys(data.roles).length ? data : undefined;
  }
  const messagesForClient = messages.map(m => ({
    id: m.id, channelId: m.channel_id, fromId: m.from_id,
    content: m.content, createdAt: parseInt(m.created_at),
    mentions: mentionsForContent(m.content),
    isPinned: !!m.is_pinned,
    reactions: Array.isArray(m.reactions) ? m.reactions : [],
    replyTo: m.reply_to_id ? {
      id: m.reply_to_id,
      fromId: m.reply_from_id || null,
      displayName: m.reply_display_name || m.reply_username || 'Unknown user',
      content: m.reply_content || '[Original message unavailable]'
    } : null,
    authorId: m.from_id
  }));
  res.json({ authors, messages: messagesForClient });
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
  if (!await hasPermission(id, req.session.userId, 'can_manage_messages')) return res.status(403).json({ error: 'You need Manage Messages permission' });

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
  if (!await hasPermission(id, req.session.userId, 'can_manage_messages')) return res.status(403).json({ error: 'You need Manage Messages permission' });
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
    `SELECT sm.role, sm.role_id, sr.is_admin, sr.can_delete_messages,
      EXISTS(
        SELECT 1 FROM server_member_roles smr2 JOIN server_roles sr2 ON sr2.id=smr2.role_id
        WHERE smr2.server_id=sm.server_id AND smr2.user_id=sm.user_id
          AND (sr2.can_manage_messages=TRUE OR sr2.can_delete_messages=TRUE)
      ) AS can_manage_messages
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
  const canDelete = m.can_delete_messages || m.can_manage_messages;

  if (!isOwn && !isAdmin && !canDelete) {
    return res.status(403).json({ error: 'No permission to delete this message' });
  }

  await pool.query('DELETE FROM channel_messages WHERE id=$1', [msgId]);
  res.json({ success: true });
});

module.exports = router;
