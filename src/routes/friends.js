const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../models/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Search users
router.get('/search', (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json({ users: [] });
  const users = db.prepare(
    `SELECT id, username, display_name, avatar FROM users 
     WHERE username LIKE ? AND id != ? LIMIT 10`
  ).all(`%${q.toLowerCase()}%`, req.session.userId);
  res.json({ users: users.map(u => ({ id: u.id, username: u.username, displayName: u.display_name, avatar: u.avatar })) });
});

// Send friend request
router.post('/request', (req, res) => {
  const { toId } = req.body;
  if (!toId) return res.status(400).json({ error: 'Missing toId' });
  if (toId === req.session.userId) return res.status(400).json({ error: 'Cannot friend yourself' });

  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(toId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  // Check already friends
  const already = db.prepare(
    `SELECT id FROM friendships WHERE (user1_id=? AND user2_id=?) OR (user1_id=? AND user2_id=?)`
  ).get(req.session.userId, toId, toId, req.session.userId);
  if (already) return res.status(409).json({ error: 'Already friends' });

  // Check existing request
  const existing = db.prepare(
    `SELECT id, status FROM friend_requests WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)`
  ).get(req.session.userId, toId, toId, req.session.userId);
  if (existing) {
    if (existing.status === 'pending') return res.status(409).json({ error: 'Request already pending' });
  }

  try {
    db.prepare('INSERT OR REPLACE INTO friend_requests (id, from_id, to_id, status) VALUES (?,?,?,?)')
      .run(uuidv4(), req.session.userId, toId, 'pending');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get pending requests (incoming)
router.get('/requests/incoming', (req, res) => {
  const reqs = db.prepare(
    `SELECT fr.id, fr.from_id, fr.created_at, u.username, u.display_name, u.avatar
     FROM friend_requests fr JOIN users u ON u.id = fr.from_id
     WHERE fr.to_id = ? AND fr.status = 'pending'`
  ).all(req.session.userId);
  res.json({ requests: reqs.map(r => ({ id: r.id, fromId: r.from_id, username: r.username, displayName: r.display_name, avatar: r.avatar, createdAt: r.created_at })) });
});

// Get pending requests (outgoing)
router.get('/requests/outgoing', (req, res) => {
  const reqs = db.prepare(
    `SELECT fr.id, fr.to_id, fr.created_at, u.username, u.display_name, u.avatar
     FROM friend_requests fr JOIN users u ON u.id = fr.to_id
     WHERE fr.from_id = ? AND fr.status = 'pending'`
  ).all(req.session.userId);
  res.json({ requests: reqs.map(r => ({ id: r.id, toId: r.to_id, username: r.username, displayName: r.display_name, avatar: r.avatar, createdAt: r.created_at })) });
});

// Accept / decline
router.post('/request/:id/respond', (req, res) => {
  const { id } = req.params;
  const { action } = req.body; // 'accept' or 'decline'

  const fr = db.prepare(`SELECT * FROM friend_requests WHERE id = ? AND to_id = ? AND status = 'pending'`).get(id, req.session.userId);
  if (!fr) return res.status(404).json({ error: 'Request not found' });

  if (action === 'accept') {
    db.prepare(`UPDATE friend_requests SET status='accepted' WHERE id=?`).run(id);
    db.prepare(`INSERT INTO friendships (id, user1_id, user2_id) VALUES (?,?,?)`).run(uuidv4(), fr.from_id, fr.to_id);
    return res.json({ success: true, action: 'accepted' });
  } else if (action === 'decline') {
    db.prepare(`UPDATE friend_requests SET status='declined' WHERE id=?`).run(id);
    return res.json({ success: true, action: 'declined' });
  }
  return res.status(400).json({ error: 'Invalid action' });
});

// Remove friend
router.delete('/:friendId', (req, res) => {
  const { friendId } = req.params;
  db.prepare(`DELETE FROM friendships WHERE (user1_id=? AND user2_id=?) OR (user1_id=? AND user2_id=?)`).run(req.session.userId, friendId, friendId, req.session.userId);
  res.json({ success: true });
});

// List friends
router.get('/', (req, res) => {
  const friends = db.prepare(
    `SELECT u.id, u.username, u.display_name, u.avatar, u.status
     FROM friendships f
     JOIN users u ON u.id = CASE WHEN f.user1_id=? THEN f.user2_id ELSE f.user1_id END
     WHERE f.user1_id=? OR f.user2_id=?`
  ).all(req.session.userId, req.session.userId, req.session.userId);
  res.json({ friends: friends.map(u => ({ id: u.id, username: u.username, displayName: u.display_name, avatar: u.avatar, status: u.status })) });
});

module.exports = router;
