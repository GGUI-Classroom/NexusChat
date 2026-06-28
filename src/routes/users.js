const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { requireAuth } = require('../middleware/auth');
const { pool } = require('../models/db');
const { avatarUrl, clearCachedAvatar, getAvatar } = require('../utils/avatar');

const router = express.Router();

// Store in memory, save as base64 in DB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB limit for free tier
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'));
    }
  }
});

router.post('/avatar', requireAuth, upload.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const base64 = req.file.buffer.toString('base64');
  const mime = req.file.mimetype;
  await pool.query('UPDATE users SET avatar_data=$1, avatar_mime=$2 WHERE id=$3',
    [base64, mime, req.session.userId]);
  clearCachedAvatar(req.session.userId);
  res.json({ success: true, avatarDataUrl: avatarUrl(req.session.userId, true) });
});

router.get('/avatar/:userId', requireAuth, async (req, res) => {
  const avatar = await getAvatar(pool, req.params.userId);
  if (!avatar) return res.sendStatus(404);
  const etag = `"avatar-${req.params.userId}-${avatar.data.length}"`;
  res.setHeader('Content-Type', avatar.mime);
  res.setHeader('Cache-Control', 'private, max-age=86400, stale-while-revalidate=604800');
  res.setHeader('ETag', etag);
  if (req.headers['if-none-match'] === etag) return res.sendStatus(304);
  res.send(avatar.data);
});

router.get('/banner/:userId', requireAuth, async (req, res) => {
  const result = await pool.query(
    'SELECT profile_banner_data, profile_banner_mime FROM users WHERE id=$1',
    [req.params.userId]
  );
  const row = result.rows[0];
  if (!row?.profile_banner_data) return res.sendStatus(404);
  const data = Buffer.from(row.profile_banner_data, 'base64');
  const etag = `"banner-${req.params.userId}-${data.length}"`;
  res.setHeader('Content-Type', row.profile_banner_mime || 'image/png');
  res.setHeader('Cache-Control', 'private, max-age=86400, stale-while-revalidate=604800');
  res.setHeader('ETag', etag);
  if (req.headers['if-none-match'] === etag) return res.sendStatus(304);
  res.send(data);
});

router.post('/profile-banner', requireAuth, upload.single('banner'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a banner image' });
  const user = await pool.query('SELECT pro_expires_at FROM users WHERE id=$1', [req.session.userId]);
  if ((user.rows[0]?.pro_expires_at || 0) <= Math.floor(Date.now() / 1000)) {
    return res.status(403).json({ error: 'Active Pro is required for profile banners' });
  }
  await pool.query(
    'UPDATE users SET profile_banner_data=$1, profile_banner_mime=$2 WHERE id=$3',
    [req.file.buffer.toString('base64'), req.file.mimetype, req.session.userId]
  );
  res.json({ success: true, profileBannerUrl: `/api/users/banner/${req.session.userId}?v=${Date.now()}` });
});

router.delete('/profile-banner', requireAuth, async (req, res) => {
  await pool.query(
    'UPDATE users SET profile_banner_data=NULL, profile_banner_mime=NULL WHERE id=$1',
    [req.session.userId]
  );
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
  const tag = await pool.query(`SELECT s.name, s.invite_code, s.server_tag, s.tag_background, s.icon_data, s.icon_mime FROM servers s JOIN server_boost_allocations a ON a.server_id=s.id AND a.feature='tag' WHERE s.id=$1`, [u.active_server_tag_id]);
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
    profileBannerUrl: u.has_profile_banner ? `/api/users/banner/${u.id}` : null,
    serverTag: tag.rows[0] ? { name: tag.rows[0].name, inviteCode: tag.rows[0].invite_code, tag: tag.rows[0].server_tag, background: tag.rows[0].tag_background, iconDataUrl: tag.rows[0].icon_data ? `data:${tag.rows[0].icon_mime};base64,${tag.rows[0].icon_data}` : null } : null
  });
});

router.patch('/profile', requireAuth, async (req, res) => {
  const { displayName, bio } = req.body;
  if (!displayName || displayName.trim().length < 1)
    return res.status(400).json({ error: 'Invalid display name' });
  await pool.query('UPDATE users SET display_name=$1, bio=$2 WHERE id=$3',
    [displayName.trim(), (bio || '').slice(0, 300), req.session.userId]);
  res.json({ success: true });
});

router.post('/change-password', requireAuth, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) return res.status(400).json({ error: 'All fields required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

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
