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

router.patch('/profile', requireAuth, async (req, res) => {
  const { displayName } = req.body;
  if (!displayName || displayName.trim().length < 1)
    return res.status(400).json({ error: 'Invalid display name' });
  await pool.query('UPDATE users SET display_name=$1 WHERE id=$2',
    [displayName.trim(), req.session.userId]);
  res.json({ success: true });
});

module.exports = router;
