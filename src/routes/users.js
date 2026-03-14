const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');
const db = require('../models/db');

const router = express.Router();

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '../../data/avatars');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `${req.session.userId}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'));
    }
  }
});

// Serve avatars
router.get('/avatar/:userId', (req, res) => {
  const user = db.prepare('SELECT avatar FROM users WHERE id=?').get(req.params.userId);
  if (!user || !user.avatar) return res.status(404).send('Not found');
  const fp = path.join(UPLOADS_DIR, user.avatar);
  if (!fs.existsSync(fp)) return res.status(404).send('Not found');
  res.sendFile(fp);
});

// Upload avatar
router.post('/avatar', requireAuth, upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const filename = req.file.filename;
  db.prepare('UPDATE users SET avatar=? WHERE id=?').run(filename, req.session.userId);
  res.json({ success: true, avatar: filename });
});

// Update display name
router.patch('/profile', requireAuth, (req, res) => {
  const { displayName } = req.body;
  if (!displayName || displayName.trim().length < 1) return res.status(400).json({ error: 'Invalid display name' });
  db.prepare('UPDATE users SET display_name=? WHERE id=?').run(displayName.trim(), req.session.userId);
  res.json({ success: true });
});

module.exports = router;
