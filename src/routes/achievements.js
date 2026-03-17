const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../models/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const ACHIEVEMENTS = [
  { id: 'first_message',       title: 'First Words',        desc: 'Send your first message',                icon: '💬', nexals: 50,   target: 1,    field: 'messages_sent',   category: 'Social' },
  { id: 'messages_100',        title: 'Chatty',             desc: 'Send 100 messages',                      icon: '🗣️', nexals: 200,  target: 100,  field: 'messages_sent',   category: 'Social' },
  { id: 'messages_500',        title: 'Big Talker',         desc: 'Send 500 messages',                      icon: '📢', nexals: 500,  target: 500,  field: 'messages_sent',   category: 'Social' },
  { id: 'messages_1000',       title: 'Legendary Chatter',  desc: 'Send 1,000 messages',                    icon: '🏆', nexals: 1200, target: 1000, field: 'messages_sent',   category: 'Social' },
  { id: 'first_friend',        title: 'Not Alone',          desc: 'Make your first friend',                 icon: '🤝', nexals: 100,  target: 1,    field: 'friends_count',   category: 'Social' },
  { id: 'friends_5',           title: 'Social Butterfly',   desc: 'Have 5 friends',                         icon: '🦋', nexals: 350,  target: 5,    field: 'friends_count',   category: 'Social' },
  { id: 'friends_10',          title: 'Popular',            desc: 'Have 10 friends',                        icon: '⭐', nexals: 800,  target: 10,   field: 'friends_count',   category: 'Social' },
  { id: 'first_dm',            title: 'Inbox Zero',         desc: 'Send your first DM',                     icon: '📩', nexals: 50,   target: 1,    field: 'dms_sent',        category: 'Social' },
  { id: 'join_server',         title: 'Community Member',   desc: 'Join a server',                          icon: '🏠', nexals: 150,  target: 1,    field: 'servers_joined',  category: 'Explorer' },
  { id: 'join_3_servers',      title: 'Explorer',           desc: 'Join 3 servers',                         icon: '🗺️', nexals: 400,  target: 3,    field: 'servers_joined',  category: 'Explorer' },
  { id: 'create_server',       title: 'Founder',            desc: 'Create your own server',                 icon: '🏗️', nexals: 300,  target: 1,    field: 'servers_created', category: 'Explorer' },
  { id: 'get_role',            title: 'Ranked Up',          desc: 'Receive a role in a server',             icon: '🎖️', nexals: 250,  target: 1,    field: 'roles_received',  category: 'Explorer' },
  { id: 'channel_messages_50', title: 'Channel Regular',    desc: 'Send 50 server channel messages',        icon: '📡', nexals: 200,  target: 50,   field: 'channel_msgs',    category: 'Explorer' },
  { id: 'redeem_code',         title: 'Code Hunter',        desc: 'Redeem an exclusive code',               icon: '🔑', nexals: 600,  target: 1,    field: 'codes_redeemed',  category: 'Collector' },
  { id: 'equip_deco',          title: 'Looking Fresh',      desc: 'Equip a decoration',                     icon: '✨', nexals: 100,  target: 1,    field: 'decos_equipped',  category: 'Collector' },
  { id: 'own_3_decos',         title: 'Decorator',          desc: 'Own 3 decorations',                      icon: '🎨', nexals: 500,  target: 3,    field: 'decos_owned',     category: 'Collector' },
  { id: 'own_5_decos',         title: 'Connoisseur',        desc: 'Own 5 decorations',                      icon: '💎', nexals: 1500, target: 5,    field: 'decos_owned',     category: 'Collector' },
  { id: 'nexals_1000',         title: 'Thousandaire',       desc: 'Accumulate 1,000 nexals',                icon: '💰', nexals: 200,  target: 1000, field: 'nexals_balance',  category: 'Wealth' },
  { id: 'nexals_5000',         title: 'Five-Figure Club',   desc: 'Accumulate 5,000 nexals',                icon: '💵', nexals: 500,  target: 5000, field: 'nexals_balance',  category: 'Wealth' },
];

async function getUserStats(userId) {
  const [msgRes, friendRes, serverMemberRes, serverOwnerRes, roleRes, chMsgRes, decoRes, equippedRes, nexalsRes] = await Promise.all([
    pool.query('SELECT COUNT(*) FROM messages WHERE from_id=$1', [userId]),
    pool.query('SELECT COUNT(*) FROM friendships WHERE user1_id=$1 OR user2_id=$1', [userId]),
    pool.query('SELECT COUNT(*) FROM server_members WHERE user_id=$1', [userId]),
    pool.query('SELECT COUNT(*) FROM servers WHERE owner_id=$1', [userId]),
    pool.query('SELECT COUNT(*) FROM server_members WHERE user_id=$1 AND role_id IS NOT NULL', [userId]),
    pool.query('SELECT COUNT(*) FROM channel_messages WHERE from_id=$1', [userId]),
    pool.query('SELECT COUNT(*) FROM user_decorations WHERE user_id=$1', [userId]),
    pool.query('SELECT active_decoration FROM users WHERE id=$1', [userId]),
    pool.query('SELECT nexals FROM users WHERE id=$1', [userId]),
  ]);

  const decoCount = parseInt(decoRes.rows[0].count);
  const nexals = nexalsRes.rows[0]?.nexals || 0;

  return {
    messages_sent:   parseInt(msgRes.rows[0].count),
    dms_sent:        parseInt(msgRes.rows[0].count), // DMs = messages
    friends_count:   parseInt(friendRes.rows[0].count),
    servers_joined:  parseInt(serverMemberRes.rows[0].count),
    servers_created: parseInt(serverOwnerRes.rows[0].count),
    roles_received:  parseInt(roleRes.rows[0].count) > 0 ? 1 : 0,
    channel_msgs:    parseInt(chMsgRes.rows[0].count),
    codes_redeemed:  decoCount, // each deco = at least one code/purchase
    decos_equipped:  equippedRes.rows[0]?.active_decoration ? 1 : 0,
    decos_owned:     decoCount,
    nexals_balance:  nexals,
  };
}

async function upsertProgress(userId, achievementId, progress, target) {
  const completed = progress >= target;
  const now = Math.floor(Date.now() / 1000);
  await pool.query(`
    INSERT INTO user_achievements (id, user_id, achievement_id, progress, completed_at)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (user_id, achievement_id) DO UPDATE
      SET progress = GREATEST(user_achievements.progress, $4),
          completed_at = CASE
            WHEN user_achievements.completed_at IS NULL AND $6 THEN $5
            ELSE user_achievements.completed_at
          END
  `, [uuidv4(), userId, achievementId, progress, completed ? now : null, completed]);
}

// Sync all achievements for a user
async function syncAll(userId) {
  const stats = await getUserStats(userId);
  for (const a of ACHIEVEMENTS) {
    const progress = Math.min(stats[a.field] || 0, a.target);
    await upsertProgress(userId, a.id, progress, a.target);
  }
}

// GET — return achievements with current progress
router.get('/', async (req, res) => {
  const userId = req.session.userId;
  await syncAll(userId); // always sync on load
  const stats = await getUserStats(userId);
  const nexalsRes = await pool.query('SELECT nexals FROM users WHERE id=$1', [userId]);
  const ua = await pool.query('SELECT achievement_id, progress, completed_at, claimed_at FROM user_achievements WHERE user_id=$1', [userId]);
  const uaMap = {};
  ua.rows.forEach(r => { uaMap[r.achievement_id] = r; });

  res.json({
    achievements: ACHIEVEMENTS.map(a => ({
      ...a,
      progress: Math.min(stats[a.field] || 0, a.target),
      completed: (stats[a.field] || 0) >= a.target,
      claimed: !!uaMap[a.id]?.claimed_at,
    })),
    nexals: nexalsRes.rows[0]?.nexals || 0
  });
});

// POST /sync — same as GET but called from frontend explicitly
router.post('/sync', async (req, res) => {
  const userId = req.session.userId;
  await syncAll(userId);
  const stats = await getUserStats(userId);
  const nexalsRes = await pool.query('SELECT nexals FROM users WHERE id=$1', [userId]);
  const ua = await pool.query('SELECT achievement_id, progress, completed_at, claimed_at FROM user_achievements WHERE user_id=$1', [userId]);
  const uaMap = {};
  ua.rows.forEach(r => { uaMap[r.achievement_id] = r; });

  res.json({
    achievements: ACHIEVEMENTS.map(a => ({
      ...a,
      progress: Math.min(stats[a.field] || 0, a.target),
      completed: (stats[a.field] || 0) >= a.target,
      claimed: !!uaMap[a.id]?.claimed_at,
    })),
    nexals: nexalsRes.rows[0]?.nexals || 0
  });
});

// POST /claim/:id — auto-syncs then claims
router.post('/claim/:achievementId', async (req, res) => {
  const { achievementId } = req.params;
  const userId = req.session.userId;
  const achievement = ACHIEVEMENTS.find(a => a.id === achievementId);
  if (!achievement) return res.status(404).json({ error: 'Achievement not found' });

  // Auto-sync to make sure completed_at is set if earned
  await syncAll(userId);

  const ua = await pool.query('SELECT * FROM user_achievements WHERE user_id=$1 AND achievement_id=$2', [userId, achievementId]);
  if (!ua.rows.length || !ua.rows[0].completed_at) return res.status(400).json({ error: 'Achievement not completed yet' });
  if (ua.rows[0].claimed_at) return res.status(409).json({ error: 'Already claimed' });

  const now = Math.floor(Date.now() / 1000);
  await pool.query('UPDATE user_achievements SET claimed_at=$1 WHERE user_id=$2 AND achievement_id=$3', [now, userId, achievementId]);
  await pool.query('UPDATE users SET nexals = nexals + $1 WHERE id=$2', [achievement.nexals, userId]);

  const nexalsRes = await pool.query('SELECT nexals FROM users WHERE id=$1', [userId]);
  res.json({ success: true, nexals: nexalsRes.rows[0].nexals, earned: achievement.nexals });
});

module.exports = router;
module.exports.ACHIEVEMENTS = ACHIEVEMENTS;
module.exports.upsertProgress = upsertProgress;
