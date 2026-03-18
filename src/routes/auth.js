const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../models/db');

const router = express.Router();

router.post('/register', async (req, res) => {
  const { username, displayName, password } = req.body;
  if (!username || !displayName || !password)
    return res.status(400).json({ error: 'All fields required' });
  if (username.length < 3 || username.length > 32)
    return res.status(400).json({ error: 'Username must be 3-32 characters' });
  if (!/^[a-zA-Z0-9_.\-]+$/.test(username))
    return res.status(400).json({ error: 'Username may only contain letters, numbers, _, ., -' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const exists = await pool.query('SELECT id FROM users WHERE LOWER(username)=LOWER($1)', [username]);
    if (exists.rows.length) return res.status(409).json({ error: 'Username already taken' });
    const hash = await bcrypt.hash(password, 12);
    const id = uuidv4();
    await pool.query('INSERT INTO users (id, username, display_name, password_hash) VALUES ($1,$2,$3,$4)',
      [id, username.toLowerCase(), displayName, hash]);
    req.session.userId = id;
    return res.json({ success: true, user: { id, username: username.toLowerCase(), displayName, bio: null, activeDecoration: null, activeColor: null } });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'All fields required' });
  try {
    const r = await pool.query('SELECT * FROM users WHERE LOWER(username)=LOWER($1)', [username]);
    const user = r.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    // Check suspension
    const susp = await pool.query(
      `SELECT suspended_until FROM suspensions WHERE user_id=$1 AND active=TRUE AND suspended_until > EXTRACT(EPOCH FROM NOW())::BIGINT ORDER BY created_at DESC LIMIT 1`,
      [user.id]
    );
    if (susp.rows.length) {
      const until = parseInt(susp.rows[0].suspended_until);
      const untilDate = new Date(until * 1000);
      return res.status(403).json({
        error: `Your account is suspended until ${untilDate.toUTCString()}`,
        suspended: true,
        suspendedUntil: until
      });
    }

    req.session.userId = user.id;
    return res.json({ success: true, user: {
      id: user.id, username: user.username, displayName: user.display_name,
      avatarDataUrl: user.avatar_data ? `data:${user.avatar_mime};base64,${user.avatar_data}` : null,
      bio: user.bio || null,
      activeDecoration: user.active_decoration || null,
      activeColor: user.active_color || null
    }});
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

router.get('/me', async (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  try {
    const r = await pool.query(
      'SELECT id, username, display_name, avatar_data, avatar_mime, bio, active_decoration, active_color FROM users WHERE id=$1',
      [req.session.userId]
    );
    const user = r.rows[0];
    if (!user) return res.json({ user: null });
    return res.json({ user: {
      id: user.id, username: user.username, displayName: user.display_name,
      avatarDataUrl: user.avatar_data ? `data:${user.avatar_mime};base64,${user.avatar_data}` : null,
      bio: user.bio || null,
      activeDecoration: user.active_decoration || null,
      activeColor: user.active_color || null,
      activeColor: user.active_color || null
    }});
  } catch (e) {
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
