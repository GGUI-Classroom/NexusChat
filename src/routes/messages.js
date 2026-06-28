const express = require('express');
const { pool } = require('../models/db');
const { requireAuth } = require('../middleware/auth');
const { avatarUrl } = require('../utils/avatar');

const router = express.Router();
router.use(requireAuth);
const NEXUS_GUARD_ID = '00000000-0000-0000-0000-000000000001';

async function resolveMessageMentions(messages, allowedUserIds) {
  const allowed = new Set(allowedUserIds.filter(Boolean));
  const ids = [...new Set(messages.flatMap(message =>
    [...String(message.content || '').matchAll(/<@user:([a-f0-9-]+)>/g)]
      .map(match => match[1])
      .filter(id => allowed.has(id))
  ))];
  if (!ids.length) return new Map();
  const users = await pool.query('SELECT id, username, display_name FROM users WHERE id = ANY($1)', [ids]);
  const byId = new Map(users.rows.map(user => [user.id, { username: user.username, displayName: user.display_name }]));
  const mentionByMessage = new Map();
  messages.forEach(message => {
    const messageMentions = { users: {}, roles: {} };
    [...String(message.content || '').matchAll(/<@user:([a-f0-9-]+)>/g)].forEach(match => {
      const user = byId.get(match[1]);
      if (user) messageMentions.users[match[1]] = user;
    });
    if (Object.keys(messageMentions.users).length) mentionByMessage.set(message.id, messageMentions);
  });
  return mentionByMessage;
}

router.get('/:userId', async (req, res) => {
  const { userId } = req.params;
  const { before } = req.query;
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const isFriend = await pool.query(
    `SELECT id FROM friendships WHERE (user1_id=$1 AND user2_id=$2) OR (user1_id=$2 AND user2_id=$1)`,
    [req.session.userId, userId]
  );
  const isNexusGuardThread = userId === NEXUS_GUARD_ID;
  if (!isFriend.rows.length && !isNexusGuardThread) return res.status(403).json({ error: 'Not friends' });

  let query = `SELECT m.id, m.from_id, m.to_id, m.content, m.created_at,
    u.username, u.display_name, (u.avatar_data IS NOT NULL) AS has_avatar, u.active_decoration, u.active_nameplate, u.active_color, u.active_font, u.pro_expires_at, u.profile_gradient_start, u.profile_gradient_end, u.profile_name_effect, ats.id AS tag_server_id, ats.name AS tag_server_name, ats.invite_code AS tag_invite_code, ats.server_tag, ats.tag_background, ats.tag_private
    FROM messages m JOIN users u ON u.id=m.from_id LEFT JOIN servers ats ON ats.id=u.active_server_tag_id
    WHERE ((m.from_id=$1 AND m.to_id=$2) OR (m.from_id=$2 AND m.to_id=$1))`;
  const params = [req.session.userId, userId];

  if (before) {
    params.push(parseInt(before, 10));
    query += ` AND m.created_at < $${params.length}`;
  }
  query += ` ORDER BY m.created_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);

  const r = await pool.query(query, params);
  const msgs = r.rows.reverse();
  const mentionByMessage = await resolveMessageMentions(msgs, [req.session.userId, userId]);
  const authors = {};
  msgs.forEach(m => {
    if (!authors[m.from_id]) {
      authors[m.from_id] = {
        username: m.username, displayName: m.display_name,
        avatarDataUrl: avatarUrl(m.from_id, !!m.has_avatar),
        activeDecoration: m.active_decoration || null,
        activeNameplate: m.active_nameplate || null,
        activeColor: m.active_color || null,
        activeFont: m.active_font || null, proActive: (m.pro_expires_at || 0) > Math.floor(Date.now() / 1000), proGradientStart: m.profile_gradient_start, proGradientEnd: m.profile_gradient_end, proNameEffect: m.profile_name_effect, activeServerTag: m.server_tag || null, activeServerTagBackground: m.tag_background || '#5865f2', activeServerTagServerId: m.tag_server_id || null, activeServerTagServerName: m.tag_private ? null : (m.tag_server_name || null), activeServerTagInviteCode: m.tag_private ? null : (m.tag_invite_code || null), activeServerTagPrivate: !!m.tag_private
      };
    }
  });
  res.json({ authors, messages: msgs.map(m => ({
    id: m.id, fromId: m.from_id, toId: m.to_id,
    content: m.content, createdAt: parseInt(m.created_at),
    mentions: mentionByMessage.get(m.id) || undefined,
    authorId: m.from_id
  }))});
});

module.exports = router;
