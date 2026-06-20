const express = require('express');
const { pool } = require('../models/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
const NEXUS_GUARD_ID = '00000000-0000-0000-0000-000000000001';

router.get('/:userId', async (req, res) => {
  const { userId } = req.params;
  const { before, limit = 50 } = req.query;
  const isFriend = await pool.query(
    `SELECT id FROM friendships WHERE (user1_id=$1 AND user2_id=$2) OR (user1_id=$2 AND user2_id=$1)`,
    [req.session.userId, userId]
  );
  const isNexusGuardThread = userId === NEXUS_GUARD_ID;
  if (!isFriend.rows.length && !isNexusGuardThread) return res.status(403).json({ error: 'Not friends' });

  let query = `SELECT m.id, m.from_id, m.to_id, m.content, m.created_at,
    u.username, u.display_name, u.avatar_data, u.avatar_mime, u.active_decoration, u.active_color, u.active_font, u.pro_expires_at, u.profile_gradient_start, u.profile_gradient_end, u.profile_name_effect, ats.id AS tag_server_id, ats.name AS tag_server_name, ats.invite_code AS tag_invite_code, ats.server_tag, ats.tag_background
    FROM messages m JOIN users u ON u.id=m.from_id LEFT JOIN servers ats ON ats.id=u.active_server_tag_id
    WHERE ((m.from_id=$1 AND m.to_id=$2) OR (m.from_id=$2 AND m.to_id=$1))`;
  const params = [req.session.userId, userId];

  if (before) {
    params.push(parseInt(before));
    query += ` AND m.created_at < $${params.length}`;
  }
  query += ` ORDER BY m.created_at DESC LIMIT $${params.length + 1}`;
  params.push(parseInt(limit));

  const r = await pool.query(query, params);
  const msgs = r.rows.reverse();
  res.json({ messages: msgs.map(m => ({
    id: m.id, fromId: m.from_id, toId: m.to_id,
    content: m.content, createdAt: parseInt(m.created_at),
    author: {
      username: m.username, displayName: m.display_name,
      avatarDataUrl: m.avatar_data ? `data:${m.avatar_mime};base64,${m.avatar_data}` : null,
      activeDecoration: m.active_decoration || null,
      activeColor: m.active_color || null,
      activeFont: m.active_font || null, proActive: (m.pro_expires_at || 0) > Math.floor(Date.now() / 1000), proGradientStart: m.profile_gradient_start, proGradientEnd: m.profile_gradient_end, proNameEffect: m.profile_name_effect, activeServerTag: m.server_tag || null, activeServerTagBackground: m.tag_background || '#5865f2', activeServerTagServerId: m.tag_server_id || null, activeServerTagServerName: m.tag_server_name || null, activeServerTagInviteCode: m.tag_invite_code || null
    }
  }))});
});

module.exports = router;
