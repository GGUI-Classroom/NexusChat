const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { requireAuth } = require('../middleware/auth');
const { pool } = require('../models/db');
const { avatarUrl, clearCachedAvatar, getAvatar } = require('../utils/avatar');
const { deleteCachedMedia, getCachedMedia, setCachedMedia } = require('../utils/mediaCache');
const { safeDisplayName, safeBio } = require('../utils/inputSafety');
const { safeUploadMime, safeStoredImageMime } = require('../utils/imageSafety');

const router = express.Router();
const TRUSTED_BUILT_IN_SVG_USERS = new Set([
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002'
]);

function avatarMimeForResponse(userId, avatar) {
  const detected = safeStoredImageMime(avatar.mime, avatar.data);
  if (detected) return detected;
  return TRUSTED_BUILT_IN_SVG_USERS.has(String(userId)) && avatar.mime === 'image/svg+xml'
    ? 'image/svg+xml'
    : null;
}

// Store in memory, save as base64 in DB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'));
    }
  }
});

router.post('/avatar', requireAuth, (req, res, next) => {
  upload.single('avatar')(req, res, error => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Pro avatars must be smaller than 5 MB' });
    return res.status(400).json({ error: error.message || 'Could not upload avatar' });
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const mime = safeUploadMime(req.file);
  if (!mime) return res.status(400).json({ error: 'Avatar data does not match a supported image format' });
  const user = await pool.query('SELECT pro_expires_at FROM users WHERE id=$1', [req.session.userId]);
  const proActive = (user.rows[0]?.pro_expires_at || 0) > Math.floor(Date.now() / 1000);
  if (!proActive && req.file.size > 2 * 1024 * 1024) {
    return res.status(403).json({ error: 'Nexus Pro is required for avatars larger than 2 MB' });
  }
  const animatedWebp = mime === 'image/webp' && req.file.buffer.includes(Buffer.from('ANIM'));
  if (!proActive && (mime === 'image/gif' || animatedWebp)) {
    return res.status(403).json({ error: 'Animated avatars require Nexus Pro' });
  }
  const base64 = req.file.buffer.toString('base64');
  const proOnly = req.file.size > 2 * 1024 * 1024 || mime === 'image/gif' || animatedWebp;
  await pool.query('UPDATE users SET avatar_data=$1, avatar_mime=$2, avatar_pro_only=$3 WHERE id=$4',
    [base64, mime, proOnly, req.session.userId]);
  clearCachedAvatar(req.session.userId);
  res.json({ success: true, avatarDataUrl: `${avatarUrl(req.session.userId, true)}?v=${Date.now()}` });
});

const bannerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.mimetype)) cb(null, true);
    else cb(new Error('Banner must be a JPEG, PNG, GIF, or WebP image'));
  }
});

router.get('/avatar/:userId', requireAuth, async (req, res) => {
  const avatar = await getAvatar(pool, req.params.userId);
  if (!avatar) return res.sendStatus(404);
  const mime = avatarMimeForResponse(req.params.userId, avatar);
  if (!mime) return res.sendStatus(404);
  const etag = `"avatar-${req.params.userId}-${avatar.data.length}"`;
  res.setHeader('Content-Type', mime);
  if (mime === 'image/svg+xml') res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  res.setHeader('Cache-Control', 'private, max-age=86400, stale-while-revalidate=604800');
  res.setHeader('ETag', etag);
  if (req.headers['if-none-match'] === etag) return res.sendStatus(304);
  res.send(avatar.data);
});

router.get('/banner/:userId', requireAuth, async (req, res) => {
  const cacheKey = `profile-banner:${req.params.userId}`;
  const cached = getCachedMedia(cacheKey);
  if (cached && cached.proExpiresAt > Math.floor(Date.now() / 1000)) {
    const mime = safeStoredImageMime(cached.mime, cached.data);
    if (!mime) return res.sendStatus(404);
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, max-age=86400, stale-while-revalidate=604800');
    return res.send(cached.data);
  }
  if (cached) deleteCachedMedia(cacheKey);
  const result = await pool.query(
    'SELECT profile_banner_data, profile_banner_mime, pro_expires_at FROM users WHERE id=$1',
    [req.params.userId]
  );
  const row = result.rows[0];
  if (!row?.profile_banner_data || (row.pro_expires_at || 0) <= Math.floor(Date.now() / 1000)) return res.sendStatus(404);
  const data = Buffer.from(row.profile_banner_data, 'base64');
  const mime = safeStoredImageMime(row.profile_banner_mime, data);
  if (!mime) return res.sendStatus(404);
  setCachedMedia(cacheKey, data, mime, { proExpiresAt: Number(row.pro_expires_at) || 0 });
  const etag = `"banner-${req.params.userId}-${data.length}"`;
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'private, max-age=86400, stale-while-revalidate=604800');
  res.setHeader('ETag', etag);
  if (req.headers['if-none-match'] === etag) return res.sendStatus(304);
  res.send(data);
});

router.post('/profile-banner', requireAuth, (req, res, next) => {
  bannerUpload.single('banner')(req, res, error => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Pro banners must be smaller than 6 MB' });
    return res.status(400).json({ error: error.message || 'Could not upload banner' });
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a banner image' });
  const mime = safeUploadMime(req.file);
  if (!mime) return res.status(400).json({ error: 'Banner data does not match a supported image format' });
  const user = await pool.query('SELECT pro_expires_at FROM users WHERE id=$1', [req.session.userId]);
  if ((user.rows[0]?.pro_expires_at || 0) <= Math.floor(Date.now() / 1000)) {
    return res.status(403).json({ error: 'Active Pro is required for profile banners' });
  }
  await pool.query(
    'UPDATE users SET profile_banner_data=$1, profile_banner_mime=$2 WHERE id=$3',
    [req.file.buffer.toString('base64'), mime, req.session.userId]
  );
  deleteCachedMedia(`profile-banner:${req.session.userId}`);
  res.json({ success: true, profileBannerUrl: `/api/users/banner/${req.session.userId}?v=${Date.now()}` });
});

router.delete('/profile-banner', requireAuth, async (req, res) => {
  await pool.query(
    'UPDATE users SET profile_banner_data=NULL, profile_banner_mime=NULL WHERE id=$1',
    [req.session.userId]
  );
  deleteCachedMedia(`profile-banner:${req.session.userId}`);
  res.json({ success: true });
});

// Get any user's public profile
router.get('/profile/:userId', requireAuth, async (req, res) => {
  const r = await pool.query(
    'SELECT id, username, display_name, (avatar_data IS NOT NULL) AS has_avatar, bio, active_decoration, active_nameplate, pro_expires_at, profile_card_style, profile_gradient_start, profile_gradient_end, profile_name_effect, profile_effect, (profile_banner_data IS NOT NULL) AS has_profile_banner, active_server_tag_id FROM users WHERE id=$1',
    [req.params.userId]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  const u = r.rows[0];
  const tag = await pool.query(`SELECT s.id, s.name, s.invite_code, s.server_tag, s.tag_background, (s.icon_data IS NOT NULL) AS has_icon, s.tag_private FROM servers s JOIN server_boost_allocations a ON a.server_id=s.id AND a.feature='tag' WHERE s.id=$1`, [u.active_server_tag_id]);
  const tagRow = tag.rows[0];
  let serverRoles = [];
  let availableRoles = [];
  let canManageRoles = false;
  const serverId = String(req.query.serverId || '');
  if (serverId) {
    const membership = await pool.query(
      `SELECT sm.role, sr.is_admin
       FROM server_members sm
       LEFT JOIN server_roles sr ON sr.id=sm.role_id
       WHERE sm.server_id=$1 AND sm.user_id=$2`,
      [serverId, req.session.userId]
    );
    const server = await pool.query('SELECT owner_id FROM servers WHERE id=$1', [serverId]);
    const rolePermission = await pool.query(
      `SELECT 1 FROM server_member_roles smr JOIN server_roles sr ON sr.id=smr.role_id
       WHERE smr.server_id=$1 AND smr.user_id=$2 AND sr.can_manage_roles=TRUE LIMIT 1`,
      [serverId, req.session.userId]
    );
    canManageRoles = server.rows[0]?.owner_id === req.session.userId ||
      membership.rows.some(row => row.role === 'admin' || row.is_admin) ||
      !!rolePermission.rows.length;
    const assigned = await pool.query(
      `SELECT sr.id, sr.name, sr.color, sr.position
       FROM server_member_roles smr
       JOIN server_roles sr ON sr.id=smr.role_id
       WHERE smr.server_id=$1 AND smr.user_id=$2
       ORDER BY sr.position ASC`,
      [serverId, req.params.userId]
    );
    serverRoles = assigned.rows;
    if (canManageRoles) {
      const roles = await pool.query(
        'SELECT id, name, color, position FROM server_roles WHERE server_id=$1 ORDER BY position ASC',
        [serverId]
      );
      availableRoles = roles.rows;
    }
  }
  res.json({
    id: u.id, username: u.username, displayName: u.display_name,
    avatarDataUrl: avatarUrl(u.id, !!u.has_avatar),
    bio: u.bio || null,
    activeDecoration: u.active_decoration || null,
    activeNameplate: u.active_nameplate || null,
    pro: (u.pro_expires_at || 0) > Math.floor(Date.now() / 1000),
    profileCardStyle: u.profile_card_style || 'soft',
    profileGradientStart: u.profile_gradient_start,
    profileGradientEnd: u.profile_gradient_end,
    profileNameEffect: u.profile_name_effect,
    profileEffect: u.profile_effect || 'none',
    profileBannerUrl: u.has_profile_banner && (u.pro_expires_at || 0) > Math.floor(Date.now() / 1000) ? `/api/users/banner/${u.id}` : null,
    serverRoles: serverRoles.map(role => ({ id: role.id, name: role.name, color: role.color })),
    availableServerRoles: availableRoles.map(role => ({ id: role.id, name: role.name, color: role.color })),
    canManageServerRoles: canManageRoles,
    serverTag: tagRow ? {
      name: tagRow.tag_private ? null : tagRow.name,
      inviteCode: tagRow.tag_private ? null : tagRow.invite_code,
      tag: tagRow.server_tag,
      background: tagRow.tag_background,
      iconDataUrl: !tagRow.tag_private && tagRow.has_icon ? `/api/servers/${encodeURIComponent(tagRow.id)}/icon` : null,
      private: !!tagRow.tag_private
    } : null
  });
});

router.patch('/profile', requireAuth, async (req, res) => {
  const { displayName, bio } = req.body;
  let safeName;
  let safeUserBio;
  try {
    safeName = safeDisplayName(displayName);
    safeUserBio = safeBio(bio);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  await pool.query('UPDATE users SET display_name=$1, bio=$2 WHERE id=$3',
    [safeName, safeUserBio, req.session.userId]);
  res.json({ success: true });
});

router.post('/change-password', requireAuth, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (typeof oldPassword !== 'string' || typeof newPassword !== 'string' || !oldPassword || !newPassword) return res.status(400).json({ error: 'All fields required' });
  if (newPassword.length < 8 || newPassword.length > 128) return res.status(400).json({ error: 'New password must be 8-128 characters' });

  const bcrypt = require('bcryptjs');
  const r = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.session.userId]);
  if (!r.rows.length) return res.status(404).json({ error: 'User not found' });

  const match = await bcrypt.compare(oldPassword, r.rows[0].password_hash);
  if (!match) return res.status(401).json({ error: 'Current password is incorrect' });

  const newHash = await bcrypt.hash(newPassword, 12);
  await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [newHash, req.session.userId]);
  res.json({ success: true });
});

router.get('/client-state', requireAuth, async (req, res) => {
  const r = await pool.query(
    'SELECT is_paused, pause_message FROM user_client_state WHERE user_id=$1',
    [req.session.userId]
  );
  const row = r.rows[0] || null;
  res.json({
    paused: !!(row && row.is_paused),
    message: row && row.pause_message ? row.pause_message : null
  });
});

router.patch('/preferences', requireAuth, async (req, res) => {
  if (typeof req.body.developerMode !== 'boolean') return res.status(400).json({ error: 'Invalid preference' });
  await pool.query('UPDATE users SET developer_mode=$1 WHERE id=$2', [req.body.developerMode, req.session.userId]);
  res.json({ success: true, developerMode: req.body.developerMode });
});

router.post('/tutorial/complete', requireAuth, async (req, res) => {
  await pool.query('UPDATE users SET tutorial_completed=TRUE WHERE id=$1', [req.session.userId]);
  res.json({ success: true });
});

router.post('/system-report/:reportId/ack', requireAuth, async (req, res) => {
  const reportId = String(req.params.reportId || '').trim();
  if (!reportId) return res.status(400).json({ error: 'Report id required' });
  const active = await pool.query('SELECT id FROM system_reports WHERE id=$1 AND active=TRUE LIMIT 1', [reportId]);
  if (!active.rows.length) return res.status(404).json({ error: 'Active report not found' });
  await pool.query(
    `INSERT INTO system_report_acknowledgements (id, report_id, user_id)
     VALUES ($1,$2,$3)
     ON CONFLICT (report_id, user_id) DO NOTHING`,
    [uuidv4(), reportId, req.session.userId]
  );
  res.json({ success: true });
});

router.post('/report', requireAuth, async (req, res) => {
  const reportType = String(req.body.type || '').trim().toLowerCase();
  const reason = String(req.body.reason || '').trim().slice(0, 600) || null;
  const messageType = String(req.body.messageType || '').trim().toLowerCase();
  const messageId = String(req.body.messageId || '').trim();
  let targetUserId = String(req.body.targetUserId || '').trim();
  let messageContent = null;
  let serverId = null;
  let channelId = null;

  if (!['user', 'message'].includes(reportType)) {
    return res.status(400).json({ error: 'Choose user or message report type' });
  }

  try {
    if (reportType === 'message') {
      if (!messageId || !['dm', 'channel'].includes(messageType)) {
        return res.status(400).json({ error: 'Message report is missing context' });
      }
      if (messageType === 'dm') {
        const msg = await pool.query(
          `SELECT id, from_id, to_id, content
           FROM messages
           WHERE id=$1 AND (from_id=$2 OR to_id=$2)
           LIMIT 1`,
          [messageId, req.session.userId]
        );
        if (!msg.rows.length) return res.status(404).json({ error: 'Message not found' });
        const row = msg.rows[0];
        targetUserId = row.from_id === req.session.userId ? row.to_id : row.from_id;
        messageContent = String(row.content || '').slice(0, 1200);
      } else {
        const msg = await pool.query(
          `SELECT cm.id, cm.from_id, cm.content, cm.channel_id, c.server_id
           FROM channel_messages cm
           JOIN channels c ON c.id=cm.channel_id
           JOIN server_members sm ON sm.server_id=c.server_id AND sm.user_id=$2
           WHERE cm.id=$1
           LIMIT 1`,
          [messageId, req.session.userId]
        );
        if (!msg.rows.length) return res.status(404).json({ error: 'Message not found' });
        const row = msg.rows[0];
        targetUserId = row.from_id;
        messageContent = String(row.content || '').slice(0, 1200);
        serverId = row.server_id;
        channelId = row.channel_id;
      }
    }

    if (!targetUserId || targetUserId === req.session.userId) {
      return res.status(400).json({ error: 'You cannot report yourself' });
    }

    const target = await pool.query('SELECT id FROM users WHERE id=$1', [targetUserId]);
    if (!target.rows.length) return res.status(404).json({ error: 'User not found' });

    await pool.query(
      `INSERT INTO user_reports
       (id, reporter_id, target_user_id, report_type, reason, message_type, message_id, message_content, server_id, channel_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        uuidv4(),
        req.session.userId,
        targetUserId,
        reportType,
        reason,
        reportType === 'message' ? messageType : null,
        reportType === 'message' ? messageId : null,
        messageContent,
        serverId,
        channelId
      ]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('user report failed:', error.message);
    res.status(500).json({ error: 'Could not submit report' });
  }
});

module.exports = router;
