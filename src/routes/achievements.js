const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../models/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Progressive chains: each entry unlocks after the previous is CLAIMED
const CHAINS = {
  messages: [
    { id: 'msg_1',    title: 'First Words',       desc: 'Send your first message',      icon: '💬', nexals: 100000000000,   target: 1 },
    { id: 'msg_5',    title: 'Getting Started',   desc: 'Send 5 messages',               icon: '💬', nexals: 75,   target: 5 },
    { id: 'msg_20',   title: 'Regular',            desc: 'Send 20 messages',              icon: '🗣️', nexals: 100,  target: 20 },
    { id: 'msg_100',  title: 'Chatty',             desc: 'Send 100 messages',             icon: '🗣️', nexals: 200,  target: 100 },
    { id: 'msg_500',  title: 'Big Talker',         desc: 'Send 500 messages',             icon: '📢', nexals: 500,  target: 500 },
    { id: 'msg_1000', title: 'Legendary Chatter', desc: 'Send 1,000 messages',           icon: '🏆', nexals: 1200, target: 1000 },
  ],
  friends: [
    { id: 'fr_1',  title: 'Not Alone',         desc: 'Make your first friend',   icon: '🤝', nexals: 100, target: 1 },
    { id: 'fr_5',  title: 'Social Butterfly',  desc: 'Have 5 friends',           icon: '🦋', nexals: 350, target: 5 },
    { id: 'fr_10', title: 'Popular',           desc: 'Have 10 friends',          icon: '⭐', nexals: 800, target: 10 },
  ],
  dms: [
    { id: 'dm_1',   title: 'Inbox Zero',   desc: 'Send your first DM',  icon: '📩', nexals: 50,  target: 1 },
    { id: 'dm_50',  title: 'DM Veteran',   desc: 'Send 50 DMs',         icon: '📨', nexals: 150, target: 50 },
    { id: 'dm_200', title: 'DM Champion',  desc: 'Send 200 DMs',        icon: '📬', nexals: 400, target: 200 },
  ],
  servers: [
    { id: 'sv_join1',   title: 'Community Member', desc: 'Join a server',      icon: '🏠', nexals: 150, target: 1 },
    { id: 'sv_join3',   title: 'Explorer',          desc: 'Join 3 servers',     icon: '🗺️', nexals: 400, target: 3 },
    { id: 'sv_join10',  title: 'Server Hopper',     desc: 'Join 10 servers',    icon: '🚀', nexals: 900, target: 10 },
  ],
  channel_msgs: [
    { id: 'ch_10',  title: 'Breaking In',      desc: 'Send 10 channel messages',   icon: '📡', nexals: 100, target: 10 },
    { id: 'ch_50',  title: 'Channel Regular',  desc: 'Send 50 channel messages',   icon: '📡', nexals: 200, target: 50 },
    { id: 'ch_200', title: 'Channel Legend',   desc: 'Send 200 channel messages',  icon: '📡', nexals: 600, target: 200 },
  ],
  create: [
    { id: 'sv_create', title: 'Founder',    desc: 'Create your own server',     icon: '🏗️', nexals: 300, target: 1 },
  ],
  roles: [
    { id: 'role_1', title: 'Ranked Up',    desc: 'Receive a role in a server',  icon: '🎖️', nexals: 250, target: 1 },
  ],
  decos: [
    { id: 'deco_redeem', title: 'Code Hunter',    desc: 'Redeem an exclusive code',    icon: '🔑', nexals: 600,  target: 1 },
    { id: 'deco_equip',  title: 'Looking Fresh',  desc: 'Equip a decoration',          icon: '✨', nexals: 100,  target: 1 },
    { id: 'deco_3',      title: 'Decorator',      desc: 'Own 3 decorations',           icon: '🎨', nexals: 500,  target: 3 },
    { id: 'deco_5',      title: 'Connoisseur',    desc: 'Own 5 decorations',           icon: '💎', nexals: 1500, target: 5 },
  ],
  nexals: [
    { id: 'nex_1000', title: 'Thousandaire',    desc: 'Accumulate 1,000 nexals',   icon: '💰', nexals: 200,  target: 1000 },
    { id: 'nex_5000', title: 'Five-Figure Club', desc: 'Accumulate 5,000 nexals',  icon: '💵', nexals: 500,  target: 5000 },
    { id: 'nex_15000', title: 'Nexal Baron',    desc: 'Accumulate 15,000 nexals',  icon: '👑', nexals: 1000, target: 15000 },
  ],
};

// Category display names
const CHAIN_CATEGORIES = {
  messages: 'Messaging',
  friends: 'Friends',
  dms: 'Direct Messages',
  servers: 'Servers',
  channel_msgs: 'Channel Activity',
  create: 'Server Creation',
  roles: 'Roles',
  decos: 'Collector',
  nexals: 'Wealth',
};

// Flat list for lookups
const ALL_ACHIEVEMENTS = Object.values(CHAINS).flat();

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
  return {
    messages:     parseInt(msgRes.rows[0].count),
    friends:      parseInt(friendRes.rows[0].count),
    dms:          parseInt(msgRes.rows[0].count), // DMs = messages table
    servers:      parseInt(serverMemberRes.rows[0].count),
    channel_msgs: parseInt(chMsgRes.rows[0].count),
    create:       parseInt(serverOwnerRes.rows[0].count),
    roles:        parseInt(roleRes.rows[0].count) > 0 ? 1 : 0,
    decos_owned:  decoCount,
    decos_equip:  equippedRes.rows[0]?.active_decoration ? 1 : 0,
    decos_redeem: decoCount,
    nexals:       nexalsRes.rows[0]?.nexals || 0,
  };
}

// Map achievement id -> stat value
function getStatForAch(a, stats, chainKey) {
  if (chainKey === 'messages')     return stats.messages;
  if (chainKey === 'friends')      return stats.friends;
  if (chainKey === 'dms')          return stats.dms;
  if (chainKey === 'servers')      return stats.servers;
  if (chainKey === 'channel_msgs') return stats.channel_msgs;
  if (chainKey === 'create')       return stats.create;
  if (chainKey === 'roles')        return stats.roles;
  if (chainKey === 'decos') {
    if (a.id === 'deco_equip')  return stats.decos_equip;
    if (a.id === 'deco_redeem') return stats.decos_redeem;
    return stats.decos_owned;
  }
  if (chainKey === 'nexals')       return stats.nexals;
  return 0;
}

async function syncAll(userId) {
  const stats = await getUserStats(userId);
  const now = Math.floor(Date.now() / 1000);
  for (const a of ALL_ACHIEVEMENTS) {
    const chainKey = Object.keys(CHAINS).find(k => CHAINS[k].some(x => x.id === a.id));
    const progress = Math.min(getStatForAch(a, stats, chainKey), a.target);
    const completed = progress >= a.target;
    await pool.query(`
      INSERT INTO user_achievements (id, user_id, achievement_id, progress, completed_at)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (user_id, achievement_id) DO UPDATE
        SET progress = GREATEST(user_achievements.progress, $4),
            completed_at = CASE
              WHEN user_achievements.completed_at IS NULL AND $6 THEN $5
              ELSE user_achievements.completed_at END
    `, [uuidv4(), userId, a.id, progress, completed ? now : null, completed]);
  }
}

async function buildResponse(userId) {
  await syncAll(userId);
  const stats = await getUserStats(userId);
  const nexalsRes = await pool.query('SELECT nexals FROM users WHERE id=$1', [userId]);
  const ua = await pool.query('SELECT achievement_id, progress, completed_at, claimed_at FROM user_achievements WHERE user_id=$1', [userId]);
  const uaMap = {};
  ua.rows.forEach(r => { uaMap[r.achievement_id] = r; });

  const categories = Object.entries(CHAINS).map(([chainKey, chain]) => {
    // Find the first unclaimed+incomplete OR first unclaimed+complete in the chain
    // Show: all claimed + first unclaimed (whether complete or not)
    const visible = [];
    let unclaimedShown = false;
    for (const a of chain) {
      const row = uaMap[a.id];
      const claimed = !!row?.claimed_at;
      if (claimed) {
        visible.push({ ...a, claimed: true, completed: true, progress: a.target });
      } else if (!unclaimedShown) {
        const chainStat = getStatForAch(a, stats, chainKey);
        const progress = Math.min(chainStat, a.target);
        const completed = progress >= a.target;
        visible.push({ ...a, claimed: false, completed, progress });
        unclaimedShown = true;
      }
    }
    return { key: chainKey, label: CHAIN_CATEGORIES[chainKey], achievements: visible };
  });

  return { categories, nexals: nexalsRes.rows[0]?.nexals || 0 };
}

router.get('/', async (req, res) => {
  res.json(await buildResponse(req.session.userId));
});

router.post('/sync', async (req, res) => {
  res.json(await buildResponse(req.session.userId));
});

router.post('/claim/:achievementId', async (req, res) => {
  const { achievementId } = req.params;
  const userId = req.session.userId;
  const achievement = ALL_ACHIEVEMENTS.find(a => a.id === achievementId);
  if (!achievement) return res.status(404).json({ error: 'Achievement not found' });

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
module.exports.ALL_ACHIEVEMENTS = ALL_ACHIEVEMENTS;
module.exports.syncAll = syncAll;
