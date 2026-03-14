const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../models/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Get message history with a user
router.get('/:userId', (req, res) => {
  const { userId } = req.params;
  const { before, limit = 50 } = req.query;

  // Verify friendship
  const isFriend = db.prepare(
    `SELECT id FROM friendships WHERE (user1_id=? AND user2_id=?) OR (user1_id=? AND user2_id=?)`
  ).get(req.session.userId, userId, userId, req.session.userId);
  if (!isFriend) return res.status(403).json({ error: 'Not friends' });

  let query = `SELECT m.id, m.from_id, m.to_id, m.content, m.created_at,
    u.username, u.display_name, u.avatar
    FROM messages m JOIN users u ON u.id = m.from_id
    WHERE ((m.from_id=? AND m.to_id=?) OR (m.from_id=? AND m.to_id=?))`;
  const params = [req.session.userId, userId, userId, req.session.userId];

  if (before) {
    query += ' AND m.created_at < ?';
    params.push(parseInt(before));
  }
  query += ' ORDER BY m.created_at DESC LIMIT ?';
  params.push(parseInt(limit));

  const msgs = db.prepare(query).all(...params).reverse();
  res.json({
    messages: msgs.map(m => ({
      id: m.id,
      fromId: m.from_id,
      toId: m.to_id,
      content: m.content,
      createdAt: m.created_at,
      author: { username: m.username, displayName: m.display_name, avatar: m.avatar }
    }))
  });
});

module.exports = router;
