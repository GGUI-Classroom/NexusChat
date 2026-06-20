const express = require('express');
const multer = require('multer');
const { requireAuth } = require('../middleware/auth');
const { pool } = require('../models/db');

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
  const dataUrl = `data:${mime};base64,${base64}`;
  res.json({ success: true, avatarDataUrl: dataUrl });
});

// Get any user's public profile
router.get('/profile/:userId', requireAuth, async (req, res) => {
  const r = await pool.query(
    'SELECT id, username, display_name, avatar_data, avatar_mime, bio, active_decoration, pro_expires_at, profile_gradient_start, profile_gradient_end, profile_name_effect FROM users WHERE id=$1',
    [req.params.userId]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  const u = r.rows[0];
  const tag = await pool.query(`SELECT s.name, s.invite_code, s.server_tag, s.tag_background, s.icon_data, s.icon_mime FROM server_members sm JOIN servers s ON s.id=sm.server_id JOIN server_boost_allocations a ON a.server_id=s.id AND a.feature='tag' WHERE sm.user_id=$1 LIMIT 1`, [u.id]);
  res.json({
    id: u.id, username: u.username, displayName: u.display_name,
    avatarDataUrl: u.avatar_data ? `data:${u.avatar_mime};base64,${u.avatar_data}` : null,
    bio: u.bio || null,
    activeDecoration: u.active_decoration || null,
    pro: (u.pro_expires_at || 0) > Math.floor(Date.now() / 1000), profileGradientStart: u.profile_gradient_start, profileGradientEnd: u.profile_gradient_end, profileNameEffect: u.profile_name_effect,
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

module.exports = router;
