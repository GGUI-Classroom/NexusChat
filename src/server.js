const express = require('express');
const http = require('http');
const compression = require('compression');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { createClient } = require('redis');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { envFlag } = require('./config/env');
const { pool, initDb } = require('./models/db');
const { avatarUrl } = require('./utils/avatar');

const app = express();
const server = http.createServer(app);

const isProd = process.env.NODE_ENV === 'production';
const SESSION_SECRET = process.env.SESSION_SECRET || 'nexus-dev-secret-change-in-prod';
const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const COOKIE_SECURE = envFlag('COOKIE_SECURE', isProd);
const REQUIRE_REDIS = envFlag('REQUIRE_REDIS', false);
const TRUST_PROXY = process.env.TRUST_PROXY || (isProd ? '1' : '');
const ALLOW_FILE_CLIENTS = envFlag('ALLOW_FILE_CLIENTS', false);
const COOKIE_SAME_SITE = (process.env.COOKIE_SAME_SITE || (ALLOW_FILE_CLIENTS ? 'none' : 'lax')).toLowerCase();
const STATIC_CLIENT_ORIGINS = new Set(
  (process.env.STATIC_CLIENT_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
);

function isAllowedClientOrigin(origin) {
  if (!origin) return true;
  // With no explicit allow-list, the hosted app and local file client must both be able to connect.
  if (!STATIC_CLIENT_ORIGINS.size) return true;
  if (origin === 'null') return ALLOW_FILE_CLIENTS;
  return STATIC_CLIENT_ORIGINS.has(origin);
}

async function resolveDirectMentions(content, allowedUserIds) {
  const matches = [...String(content || '').matchAll(/<@user:([a-f0-9-]+)>/g)];
  const allowed = new Set(allowedUserIds.filter(Boolean));
  const ids = [...new Set(matches.map(match => match[1]).filter(id => allowed.has(id)))];
  const mentionData = { users: {}, roles: {} };
  if (!ids.length) return mentionData;
  const result = await pool.query('SELECT id, username, display_name FROM users WHERE id = ANY($1)', [ids]);
  result.rows.forEach(user => {
    mentionData.users[user.id] = { username: user.username, displayName: user.display_name };
  });
  return mentionData;
}

async function resolveChannelMentions(content, serverId) {
  const userMentions = [...String(content || '').matchAll(/<@user:([a-f0-9-]+)>/g)];
  const roleMentions = [...String(content || '').matchAll(/<@role:([a-f0-9-]+)>/g)];
  const mentionData = { users: {}, roles: {} };
  if (userMentions.length) {
    const ids = [...new Set(userMentions.map(match => match[1]))];
    const result = await pool.query('SELECT id, username, display_name FROM users WHERE id = ANY($1)', [ids]);
    result.rows.forEach(user => {
      mentionData.users[user.id] = { username: user.username, displayName: user.display_name };
    });
  }
  if (roleMentions.length) {
    const ids = [...new Set(roleMentions.map(match => match[1]))];
    const result = await pool.query('SELECT id, name, color FROM server_roles WHERE id = ANY($1) AND server_id = $2', [ids, serverId]);
    result.rows.forEach(role => {
      mentionData.roles[role.id] = { name: role.name, color: role.color };
    });
  }
  return mentionData;
}

const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      if (isAllowedClientOrigin(origin)) return callback(null, true);
      return callback(new Error('Origin not allowed'));
    },
    credentials: true
  }
});

if (TRUST_PROXY && !['0', 'false', 'no', 'off'].includes(TRUST_PROXY.toLowerCase())) {
  app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY);
}

const sessionMiddleware = session({
  store: new pgSession({ pool, createTableIfMissing: true }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'nexus.sid',
  cookie: {
    secure: COOKIE_SECURE,
    httpOnly: true,
    sameSite: COOKIE_SAME_SITE,
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
});

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedClientOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(compression({ threshold: 1024 }));
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);
app.use((req, res, next) => { req.io = io; req.userSockets = userSockets; next(); });
app.use(express.static(path.join(__dirname, '../public'), {
  etag: true,
  maxAge: isProd ? '1h' : 0
}));

// Expose io so routes can emit socket events
app.set('io', io);

app.use('/api/auth', require('./routes/auth'));
app.use('/api/friends', require('./routes/friends'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/users', require('./routes/users'));
app.use('/api/servers/:id/economy', require('./routes/economy'));
app.use('/api/servers', require('./routes/servers'));
app.use('/api/shop', require('./routes/shop'));
app.use('/api/achievements', require('./routes/achievements'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/colors', require('./routes/colors'));
app.use('/api/perks', require('./routes/perks'));
app.use('/api/ringtones', require('./routes/ringtones'));
app.use('/api/games', require('./routes/games'));
app.use('/api/auction', require('./routes/auction'));
app.use('/api/nexus-link', require('./routes/nexus-link'));

function validNexusLinkRequest(req) {
  return Boolean(process.env.NEXUS_LINK_SHARED_SECRET) && req.get('x-nexus-link-secret') === process.env.NEXUS_LINK_SHARED_SECRET;
}

// Receives a reply sent to Nexus LINK in Discord and creates the matching Nexus DM.
app.post('/api/nexus-link/inbound-dm', async (req, res) => {
  if (!validNexusLinkRequest(req)) return res.status(401).json({ error: 'Unauthorized Nexus LINK relay' });
  const fromId = String(req.body.nexusUserId || '');
  const toId = String(req.body.nexusPeerId || '');
  const content = String(req.body.content || '').trim().slice(0, 4000);
  if (!fromId || !toId || !content) return res.status(400).json({ error: 'A sender, recipient, and message are required' });
  const friendship = await pool.query(
    `SELECT id FROM friendships WHERE (user1_id=$1 AND user2_id=$2) OR (user1_id=$2 AND user2_id=$1) LIMIT 1`,
    [fromId, toId]
  );
  if (!friendship.rows.length) return res.status(403).json({ error: 'Nexus users must be friends to relay direct messages' });
  const sender = await pool.query(
    `SELECT u.username, u.display_name, (u.avatar_data IS NOT NULL) AS has_avatar, u.active_decoration, u.active_color, u.active_font,
      u.pro_expires_at, u.profile_gradient_start, u.profile_gradient_end, u.profile_name_effect,
      ats.id AS tag_server_id, ats.name AS tag_server_name, ats.invite_code AS tag_invite_code, ats.server_tag, ats.tag_background
     FROM users u LEFT JOIN servers ats ON ats.id=u.active_server_tag_id WHERE u.id=$1`,
    [fromId]
  );
  if (!sender.rows[0]) return res.status(404).json({ error: 'Nexus sender was not found' });
  const user = sender.rows[0];
  const msg = {
    id: uuidv4(), fromId, toId, content, createdAt: Math.floor(Date.now() / 1000),
    author: {
      username: user.username, displayName: user.display_name,
      avatarDataUrl: avatarUrl(fromId, !!user.has_avatar),
      activeDecoration: user.active_decoration || null, activeColor: user.active_color || null, activeFont: user.active_font || null,
      proActive: (user.pro_expires_at || 0) > Math.floor(Date.now() / 1000), proGradientStart: user.profile_gradient_start, proGradientEnd: user.profile_gradient_end, proNameEffect: user.profile_name_effect,
      activeServerTag: user.server_tag || null, activeServerTagBackground: user.tag_background || '#5865f2', activeServerTagServerId: user.tag_server_id || null, activeServerTagServerName: user.tag_server_name || null, activeServerTagInviteCode: user.tag_invite_code || null
    }
  };
  await pool.query('INSERT INTO messages (id, from_id, to_id, content, created_at) VALUES ($1,$2,$3,$4,$5)', [msg.id, fromId, toId, content, msg.createdAt]);
  io.to(`user:${fromId}`).emit('new_message', msg);
  io.to(`user:${toId}`).emit('new_message', msg);
  res.json({ success: true, nexusMessageId: msg.id });
});

// Explicit Discord /reply delivery. The Discord bot resolves a Nexus username,
// while Nexus remains the source of truth for friendship and message delivery.
app.post('/api/nexus-link/outbound-dm', async (req, res) => {
  if (!validNexusLinkRequest(req)) return res.status(401).json({ error: 'Unauthorized Nexus LINK relay' });
  const fromId = String(req.body.nexusUserId || '');
  const username = String(req.body.username || '').trim().replace(/^@/, '');
  const content = String(req.body.content || '').trim().slice(0, 4000);
  if (!fromId || !username || !content) return res.status(400).json({ error: 'A recipient and message are required' });

  const recipientResult = await pool.query(
    `SELECT id, username, display_name FROM users WHERE LOWER(username)=LOWER($1) LIMIT 1`,
    [username]
  );
  const recipient = recipientResult.rows[0];
  if (!recipient) return res.status(404).json({ error: 'No Nexus user has that username' });
  if (recipient.id === fromId) return res.status(400).json({ error: 'You cannot send a Nexus DM to yourself' });

  const senderResult = await pool.query(
    `SELECT u.username, u.display_name, u.avatar_data, u.avatar_mime, u.active_decoration, u.active_color, u.active_font,
      u.pro_expires_at, u.profile_gradient_start, u.profile_gradient_end, u.profile_name_effect,
      ats.id AS tag_server_id, ats.name AS tag_server_name, ats.invite_code AS tag_invite_code, ats.server_tag, ats.tag_background,
      EXISTS(SELECT 1 FROM friendships f WHERE (f.user1_id=u.id AND f.user2_id=$2) OR (f.user1_id=$2 AND f.user2_id=u.id)) AS friends
     FROM users u LEFT JOIN servers ats ON ats.id=u.active_server_tag_id WHERE u.id=$1`,
    [fromId, recipient.id]
  );
  const sender = senderResult.rows[0];
  if (!sender) return res.status(404).json({ error: 'Linked Nexus user was not found' });
  if (!sender.friends) return res.status(403).json({ error: 'You can only use /reply with Nexus friends' });

  const now = Math.floor(Date.now() / 1000);
  const msg = {
    id: uuidv4(), fromId, toId: recipient.id, content, createdAt: now,
    author: {
      username: sender.username, displayName: sender.display_name,
      avatarDataUrl: sender.avatar_data ? `data:${sender.avatar_mime};base64,${sender.avatar_data}` : null,
      activeDecoration: sender.active_decoration || null, activeColor: sender.active_color || null, activeFont: sender.active_font || null,
      proActive: (sender.pro_expires_at || 0) > now, proGradientStart: sender.profile_gradient_start, proGradientEnd: sender.profile_gradient_end, proNameEffect: sender.profile_name_effect,
      activeServerTag: sender.server_tag || null, activeServerTagBackground: sender.tag_background || '#5865f2', activeServerTagServerId: sender.tag_server_id || null, activeServerTagServerName: sender.tag_server_name || null, activeServerTagInviteCode: sender.tag_invite_code || null
    }
  };
  await pool.query('INSERT INTO messages (id, from_id, to_id, content, created_at) VALUES ($1,$2,$3,$4,$5)', [msg.id, fromId, recipient.id, content, now]);
  io.to(`user:${fromId}`).emit('new_message', msg);
  io.to(`user:${recipient.id}`).emit('new_message', msg);
  relayNexusDirectMessage({
    nexusRecipientId: recipient.id,
    nexusMessageId: msg.id,
    sender: { id: fromId, username: sender.username, displayName: sender.display_name, avatarDataUrl: msg.author.avatarDataUrl, activeServerTag: sender.server_tag || null },
    content
  }).catch(error => console.error('Nexus LINK explicit DM relay error:', error));
  res.json({ success: true, nexusMessageId: msg.id, recipient: { id: recipient.id, username: recipient.username, displayName: recipient.display_name } });
});

app.post('/api/nexus-link/inbound-channel', async (req, res) => {
  if (!validNexusLinkRequest(req)) return res.status(401).json({ error: 'Unauthorized Nexus LINK relay' });
  const userId = String(req.body.nexusUserId || '');
  const serverId = String(req.body.serverId || '');
  const channelId = String(req.body.channelId || '');
  const content = String(req.body.content || '').trim().slice(0, 4000);
  if (!userId || !serverId || !channelId || !content) return res.status(400).json({ error: 'A mapped Nexus channel and message are required' });
  const result = await pool.query(
    `SELECT u.username, u.display_name, (u.avatar_data IS NOT NULL) AS has_avatar, u.active_decoration,
      sm.role, sr.name AS role_name, sr.color AS role_color, sr.gradient_start, sr.gradient_end,
      ch.id AS valid_channel
     FROM server_members sm
     JOIN users u ON u.id=sm.user_id
     JOIN channels ch ON ch.id=$3 AND ch.server_id=$2 AND COALESCE(ch.channel_type, 'text')='text'
     LEFT JOIN server_roles sr ON sr.id=sm.role_id
     WHERE sm.server_id=$2 AND sm.user_id=$1`,
    [userId, serverId, channelId]
  );
  const row = result.rows[0];
  if (!row) return res.status(403).json({ error: 'The linked Nexus account cannot post in that mapped channel' });
  const now = Math.floor(Date.now() / 1000);
  const msg = {
    id: uuidv4(), serverId, channelId, fromId: userId, content, createdAt: now, isPinned: false,
    author: {
      username: row.username, displayName: row.display_name,
      avatarDataUrl: avatarUrl(userId, !!row.has_avatar),
      roleColor: row.role_color || null, roleName: row.role_name || null,
      roleGradientStart: row.gradient_start || null, roleGradientEnd: row.gradient_end || null,
      activeDecoration: row.active_decoration || null
    }
  };
  await pool.query('INSERT INTO channel_messages (id, channel_id, from_id, content, created_at) VALUES ($1,$2,$3,$4,$5)', [msg.id, channelId, userId, content, now]);
  io.to(`server:${serverId}`).emit('new_channel_message', msg);
  res.json({ success: true, nexusMessageId: msg.id });
});

app.post('/api/nexus-link/inbound-channel-reaction', async (req, res) => {
  if (!validNexusLinkRequest(req)) return res.status(401).json({ error: 'Unauthorized Nexus LINK relay' });
  const userId = String(req.body.nexusUserId || '');
  const messageId = String(req.body.nexusMessageId || '');
  const emoji = String(req.body.emoji || '').trim().slice(0, 16);
  if (!userId || !messageId || !emoji) return res.status(400).json({ error: 'A reaction is required' });
  const message = await pool.query(`SELECT cm.channel_id, ch.server_id FROM channel_messages cm JOIN channels ch ON ch.id=cm.channel_id JOIN server_members sm ON sm.server_id=ch.server_id AND sm.user_id=$2 WHERE cm.id=$1`, [messageId, userId]);
  if (!message.rows[0]) return res.status(403).json({ error: 'The linked account cannot react to that message' });
  await pool.query(`INSERT INTO channel_message_reactions (id, message_id, user_id, emoji) VALUES ($1,$2,$3,$4) ON CONFLICT (message_id, user_id, emoji) DO NOTHING`, [uuidv4(), messageId, userId, emoji]);
  const aggregate = await pool.query(`SELECT emoji, COUNT(*)::int AS count, BOOL_OR(user_id=$2) AS reacted FROM channel_message_reactions WHERE message_id=$1 GROUP BY emoji ORDER BY count DESC, emoji ASC`, [messageId, userId]);
  io.to(`server:${message.rows[0].server_id}`).emit('channel_message_reaction_updated', { channelId: message.rows[0].channel_id, messageId, reactions: aggregate.rows.map(row => ({ emoji: row.emoji, count: parseInt(row.count, 10) || 0, reacted: !!row.reacted })) });
  res.json({ success: true });
});

app.post('/api/nexus-link/friend-requests/:requestId/respond', async (req, res) => {
  if (!validNexusLinkRequest(req)) return res.status(401).json({ error: 'Unauthorized Nexus LINK relay' });
  const userId = String(req.body.nexusUserId || '');
  const action = req.body.action;
  if (!userId || !['accept', 'decline'].includes(action)) return res.status(400).json({ error: 'Invalid friend-request response' });
  const result = await pool.query(
    `SELECT * FROM friend_requests WHERE id=$1 AND to_id=$2 AND status='pending'`,
    [req.params.requestId, userId]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Friend request was not found or was already handled' });
  const request = result.rows[0];
  if (action === 'accept') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE friend_requests SET status='accepted' WHERE id=$1`, [request.id]);
      await client.query(`INSERT INTO friendships (id, user1_id, user2_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [uuidv4(), request.from_id, request.to_id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  } else {
    await pool.query(`UPDATE friend_requests SET status='declined' WHERE id=$1`, [request.id]);
  }
  res.json({ success: true, action: action === 'accept' ? 'accepted' : 'declined' });
});

app.post('/api/nexus-link/calls/:roomId/decline', (req, res) => {
  if (!validNexusLinkRequest(req)) return res.status(401).json({ error: 'Unauthorized Nexus LINK relay' });
  const invite = directCallInvites.get(req.params.roomId);
  const userId = String(req.body.nexusUserId || '');
  if (!invite || invite.toId !== userId) return res.status(404).json({ error: 'Call invitation was not found' });
  directCallInvites.delete(req.params.roomId);
  callTypes.delete(req.params.roomId);
  io.to(`user:${invite.fromId}`).emit('call_declined', { roomId: req.params.roomId, byId: userId });
  res.json({ success: true });
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

const userSockets = new Map();
const voiceRooms = new Map();
const callTypes = new Map();
const directCallInvites = new Map();
const userInCall = new Map();
const groupCallRooms = new Map(); // roomId -> Set<userId>
const userGroupCallRoom = new Map(); // userId -> roomId
const callGames = new Map(); // call/group room id -> shared card table
let redisClient = null;
const CALL_USER_KEY_PREFIX = 'nexus:call:user:';
const CALL_ROOM_KEY_PREFIX = 'nexus:call:room:';
const NEXUS_BOT_ID = '00000000-0000-0000-0000-000000000001';
const NEXUS_BOT_NAME = 'NexusGuard';
const NEXUS_BOT_AVATAR_DATA_URL = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5NiA5NiI+PGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSJnIiB4MT0iMCIgeTE9IjAiIHgyPSIxIiB5Mj0iMSI+PHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjMGYxNzJhIi8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjMWUyOTNiIi8+PC9saW5lYXJHcmFkaWVudD48bGluZWFyR3JhZGllbnQgaWQ9ImEiIHgxPSIwIiB5MT0iMCIgeDI9IjEiIHkyPSIxIj48c3RvcCBvZmZzZXQ9IjAiIHN0b3AtY29sb3I9IiNmNTllMGIiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiNmOTczMTYiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz48Y2lyY2xlIGN4PSI0OCIgY3k9IjQ4IiByPSI0NiIgZmlsbD0idXJsKCNnKSIvPjxwYXRoIGQ9Ik00OCAxNmwyNCA4djIyYzAgMTgtMTAgMzAtMjQgMzYtMTQtNi0yNC0xOC0yNC0zNlYyNHoiIGZpbGw9InVybCgjYSkiLz48cGF0aCBkPSJNNDggMjZsMTQgNXYxNWMwIDExLTYgMTktMTQgMjMtOC00LTE0LTEyLTE0LTIzVjMxeiIgZmlsbD0iIzExMTgyNyIgb3BhY2l0eT0iLjY1Ii8+PGNpcmNsZSBjeD0iNDgiIGN5PSI0NSIgcj0iNyIgZmlsbD0iI2ZkZTY4YSIvPjxwYXRoIGQ9Ik0zNiA1OWgyNHY1SDM2eiIgZmlsbD0iI2ZkZTY4YSIvPjwvc3ZnPg==';
const spamTracker = new Map();

function gameDeck() {
  return ['A','2','3','4','5','6','7','8','9','10','J','Q','K'].flatMap(rank => ['S','H','D','C'].map(suit => ({ rank, suit })));
}
function shuffle(cards) { for (let i = cards.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [cards[i], cards[j]] = [cards[j], cards[i]]; } return cards; }
function blackjackScore(cards) { let total = cards.reduce((sum, c) => sum + (c.rank === 'A' ? 11 : ['J','Q','K'].includes(c.rank) ? 10 : Number(c.rank)), 0); let aces = cards.filter(c => c.rank === 'A').length; while (total > 21 && aces--) total -= 10; return total; }
function gameStateFor(game, viewerId) {
  const revealDealer = game.type !== 'blackjack' || game.phase === 'complete';
  return { type: game.type, phase: game.phase, hostId: game.hostId, roundsTotal: game.roundsTotal || 1, roundNumber: game.roundNumber || 0, turnId: game.turnId || null, community: game.community || [], pot: game.pot || 0,
    dealer: game.type === 'blackjack' ? { hand: revealDealer ? game.dealer.hand : [game.dealer.hand[0], { hidden: true }], score: revealDealer ? blackjackScore(game.dealer.hand) : null } : null,
    players: game.players.map(p => ({ id: p.id, displayName: p.displayName, chips: p.chips, bet: p.bet || 0, folded: !!p.folded, standing: !!p.standing, hand: p.id === viewerId || game.phase === 'complete' ? p.hand : p.hand.map(() => ({ hidden: true })), score: game.type === 'blackjack' ? blackjackScore(p.hand) : null })), winnerId: game.winnerId || null, message: game.message || '' };
}
function beginCallGameRound(game) {
  game.deck = shuffle(gameDeck());
  game.phase = 'playing';
  game.message = '';
  game.players.forEach(player => {
    player.hand = [game.deck.pop(), game.deck.pop()];
    player.standing = false;
    player.folded = false;
    player.bet = 0;
  });
  if (game.type === 'blackjack') {
    game.dealer.hand = [game.deck.pop(), game.deck.pop()];
  } else {
    game.community = [game.deck.pop(), game.deck.pop(), game.deck.pop()];
    game.pot = 0;
    game.turnId = game.players[0].id;
  }
}
function emitGame(roomId) { const game = callGames.get(roomId); if (!game) return; for (const player of game.players) io.to(`user:${player.id}`).emit('call_game_state', { roomId, game: gameStateFor(game, player.id) }); }
async function isInGameRoom(userId, roomId) {
  if (userGroupCallRoom.get(userId) === roomId || groupCallRooms.get(roomId)?.has(userId)) return true;
  return (await getUserCallRoom(userId)) === roomId;
}
const NEXUS_BOT_AUTHOR = {
  username: 'nexusguard',
  displayName: NEXUS_BOT_NAME,
  avatarDataUrl: NEXUS_BOT_AVATAR_DATA_URL,
  roleColor: '#f4b942',
  roleName: 'Bot',
  activeDecoration: null,
  activeColor: '#f4b942',
  activeFont: null
};

async function ensureNexusGuardExists() {
  await pool.query(
    `INSERT INTO users (id, username, display_name, password_hash, status, active_color, avatar_mime, avatar_data)
     VALUES ($1,'nexusguard','NexusGuard','nexusguard-local-only','online','#f4b942','image/svg+xml',$2)
     ON CONFLICT (id) DO UPDATE SET
       username='nexusguard',
       display_name='NexusGuard',
       status='online',
       active_color='#f4b942',
       avatar_mime='image/svg+xml',
       avatar_data=$2`,
    [NEXUS_BOT_ID, NEXUS_BOT_AVATAR_DATA_URL.replace(/^data:image\/svg\+xml;base64,/, '')]
  );
}

async function getServerBotConfig(serverId) {
  const blockedWordsRes = await pool.query(
    'SELECT word FROM server_blocked_words WHERE server_id=$1 ORDER BY word ASC',
    [serverId]
  );
  const blockedWords = blockedWordsRes.rows.map(r => String(r.word || '').trim().toLowerCase()).filter(Boolean);

  const r = await pool.query(
    `SELECT bot_prefix, bot_enabled, bot_auto_mod, bot_block_links,
            bot_caps_threshold, bot_spam_window
     FROM servers WHERE id=$1`,
    [serverId]
  );
  if (!r.rows.length) {
    return {
      botName: NEXUS_BOT_NAME,
      botPrefix: '/',
      botEnabled: true,
      botAutoMod: true,
      botBlockLinks: false,
      botCapsThreshold: 90,
      botSpamWindow: 6,
      blockedWords
    };
  }
  const row = r.rows[0];
  const prefix = (row.bot_prefix || '/').toString();
  return {
    botName: NEXUS_BOT_NAME,
    botPrefix: prefix.length ? prefix.slice(0, 2) : '/',
    botEnabled: row.bot_enabled !== false,
    botAutoMod: row.bot_auto_mod !== false,
    botBlockLinks: !!row.bot_block_links,
    botCapsThreshold: Math.min(100, Math.max(50, parseInt(row.bot_caps_threshold, 10) || 90)),
    botSpamWindow: Math.min(20, Math.max(3, parseInt(row.bot_spam_window, 10) || 6)),
    blockedWords
  };
}

async function setupRedisBackplane() {
  if (!REDIS_URL) {
    console.warn('REDIS_URL not set, running without cross-instance realtime sync.');
    return;
  }

  try {
    const pubClient = createClient({ url: REDIS_URL });
    const subClient = pubClient.duplicate();
    await Promise.all([pubClient.connect(), subClient.connect()]);
    io.adapter(createAdapter(pubClient, subClient));
    redisClient = pubClient;
    console.log('Redis backplane connected for Socket.IO.');
  } catch (err) {
    console.error('Redis backplane unavailable, continuing in single-instance mode:', err.message);
  }
}

function getCallUserKey(userId) {
  return `${CALL_USER_KEY_PREFIX}${userId}`;
}

function getCallRoomKey(roomId) {
  return `${CALL_ROOM_KEY_PREFIX}${roomId}`;
}

function getGroupCallRoomId(serverId, channelId) {
  return `${serverId}:${channelId || 'general'}`;
}

function mapUserForClient(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarDataUrl: avatarUrl(row.from_id || row.user_id || row.id, !!row.avatar_data)
  };
}

async function getUserCallRoom(userId) {
  if (redisClient && redisClient.isOpen) {
    return redisClient.get(getCallUserKey(userId));
  }
  return userInCall.get(userId) || null;
}

async function setUserCallRoom(userId, roomId) {
  if (redisClient && redisClient.isOpen) {
    await redisClient.set(getCallUserKey(userId), roomId, { EX: 60 * 60 * 12 });
  }
  userInCall.set(userId, roomId);
}

async function clearUserCallRoom(userId) {
  if (redisClient && redisClient.isOpen) {
    await redisClient.del(getCallUserKey(userId));
  }
  userInCall.delete(userId);
}

async function setRoomParticipants(roomId, participants) {
  if (redisClient && redisClient.isOpen) {
    const roomKey = getCallRoomKey(roomId);
    await redisClient.del(roomKey);
    if (participants.length) {
      await redisClient.sAdd(roomKey, participants.map(String));
      await redisClient.expire(roomKey, 60 * 60 * 12);
    }
  }
  voiceRooms.set(roomId, new Set(participants));
}

async function getRoomParticipants(roomId) {
  if (redisClient && redisClient.isOpen) {
    const participants = await redisClient.sMembers(getCallRoomKey(roomId));
    return new Set(participants || []);
  }
  return voiceRooms.get(roomId) || new Set();
}

async function clearRoomParticipants(roomId) {
  if (redisClient && redisClient.isOpen) {
    await redisClient.del(getCallRoomKey(roomId));
  }
  voiceRooms.delete(roomId);
}

io.use((socket, next) => {
  const sess = socket.request.session;
  if (!sess || !sess.userId) return next(new Error('Unauthorized'));
  socket.userId = sess.userId;
  next();
});

// ---- Achievement auto-tracker ----
async function trackAchievement(userId, fields) {
  try {
    // Just sync — the achievements route handles the logic
    // We do a lightweight check: count messages/etc and upsert progress
    const { ACHIEVEMENTS } = require('./routes/achievements');
    for (const field of fields) {
      const relevant = ACHIEVEMENTS.filter(a => a.field === field);
      if (!relevant.length) continue;

      let count = 0;
      if (field === 'messages_sent' || field === 'dms_sent') {
        const r = await pool.query('SELECT COUNT(*) FROM messages WHERE from_id=$1', [userId]);
        count = parseInt(r.rows[0].count);
      } else if (field === 'channel_msgs') {
        const r = await pool.query('SELECT COUNT(*) FROM channel_messages WHERE from_id=$1', [userId]);
        count = parseInt(r.rows[0].count);
      }

      for (const a of relevant) {
        const progress = Math.min(count, a.target);
        const completed = count >= a.target;
        const now = Math.floor(Date.now() / 1000);
        const { v4: uuidv4 } = require('uuid');
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
  } catch(e) { console.error('Achievement track error:', e.message); }
}

function parseDurationToSeconds(raw) {
  const m = String(raw || '').trim().match(/^(\d+)([smhd])$/i);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  if (!n || n < 1) return 0;
  if (unit === 's') return n;
  if (unit === 'm') return n * 60;
  if (unit === 'h') return n * 60 * 60;
  return n * 60 * 60 * 24;
}

function humanDuration(seconds) {
  const s = Math.max(0, parseInt(seconds, 10) || 0);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.ceil(s / 60)}m`;
  if (s < 86400) return `${Math.ceil(s / 3600)}h`;
  return `${Math.ceil(s / 86400)}d`;
}

async function emitBotChannelMessage({ serverId, channelId, content, botName = null }) {
  let resolvedBotName = botName;
  if (!resolvedBotName) {
    const cfg = await getServerBotConfig(serverId);
    resolvedBotName = cfg.botName;
  }
  const now = Math.floor(Date.now() / 1000);
  const msg = {
    id: uuidv4(),
    serverId,
    channelId,
    fromId: NEXUS_BOT_ID,
    content,
    createdAt: now,
    author: {
      ...NEXUS_BOT_AUTHOR,
      displayName: resolvedBotName || NEXUS_BOT_NAME
    }
  };
  io.to(`server:${serverId}`).emit('new_channel_message', msg);
  pool.query(
    'INSERT INTO channel_messages (id, channel_id, from_id, content, created_at) VALUES ($1,$2,$3,$4,$5)',
    [msg.id, channelId, NEXUS_BOT_ID, content, now]
  ).catch(e => console.error('NexusBot msg insert error:', e));
}

async function sendBotDirectMessage({ toUserId, content }) {
  const trimmed = String(content || '').trim().slice(0, 4000);
  if (!trimmed || !toUserId) return;
  await ensureNexusGuardExists();
  const now = Math.floor(Date.now() / 1000);
  const msg = {
    id: uuidv4(),
    fromId: NEXUS_BOT_ID,
    toId: toUserId,
    content: trimmed,
    createdAt: now,
    author: {
      username: NEXUS_BOT_AUTHOR.username,
      displayName: NEXUS_BOT_NAME,
      avatarDataUrl: NEXUS_BOT_AVATAR_DATA_URL,
      activeDecoration: null,
      activeColor: '#f4b942',
      activeFont: null
    }
  };
  io.to(`user:${toUserId}`).emit('new_message', msg);
  await pool.query(
    'INSERT INTO messages (id, from_id, to_id, content, created_at) VALUES ($1,$2,$3,$4,$5)',
    [msg.id, NEXUS_BOT_ID, toUserId, trimmed, now]
  );
}

async function relayNexusDirectMessage({ nexusRecipientId, nexusMessageId, sender, content }) {
  const linkUrl = String(process.env.NEXUS_LINK_URL || '').replace(/\/$/, '');
  const secret = process.env.NEXUS_LINK_SHARED_SECRET;
  if (!linkUrl || !secret) return;
  const response = await fetch(`${linkUrl}/relay/nexus-dm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nexus-link-secret': secret },
    body: JSON.stringify({ nexusRecipientId, nexusMessageId, sender, content, attachments: [] })
  });
  if (!response.ok) throw new Error(`Nexus LINK DM relay returned ${response.status}`);
}

async function relayNexusCallInvite({ nexusRecipientId, roomId, callType, caller }) {
  const linkUrl = String(process.env.NEXUS_LINK_URL || '').replace(/\/$/, '');
  const secret = process.env.NEXUS_LINK_SHARED_SECRET;
  if (!linkUrl || !secret) return;
  const response = await fetch(`${linkUrl}/relay/call-invite`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nexus-link-secret': secret },
    body: JSON.stringify({ nexusRecipientId, roomId, callType, caller })
  });
  if (!response.ok) throw new Error(`Nexus LINK call relay returned ${response.status}`);
}

async function relayNexusChannelMessage({ serverId, channelId, nexusMessageId, sender, content, replyTo }) {
  const linkUrl = String(process.env.NEXUS_LINK_URL || '').replace(/\/$/, '');
  const secret = process.env.NEXUS_LINK_SHARED_SECRET;
  if (!linkUrl || !secret) return;
  const response = await fetch(`${linkUrl}/relay/nexus-channel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nexus-link-secret': secret },
    body: JSON.stringify({ serverId, channelId, nexusMessageId, sender, content, replyTo })
  });
  if (!response.ok) throw new Error(`Nexus LINK channel relay returned ${response.status}`);
}

async function relayNexusChannelReaction({ nexusMessageId, emoji }) {
  const linkUrl = String(process.env.NEXUS_LINK_URL || '').replace(/\/$/, '');
  const secret = process.env.NEXUS_LINK_SHARED_SECRET;
  if (!linkUrl || !secret) return;
  const response = await fetch(`${linkUrl}/relay/nexus-channel-reaction`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nexus-link-secret': secret },
    body: JSON.stringify({ nexusMessageId, emoji })
  });
  if (!response.ok) throw new Error(`Nexus LINK reaction relay returned ${response.status}`);
}

async function logModerationAction({ serverId, channelId, action, actorUserId, targetUserId = null, details = null }) {
  const now = Math.floor(Date.now() / 1000);
  await pool.query(
    `INSERT INTO moderation_logs (id, server_id, channel_id, action, actor_user_id, target_user_id, details, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [uuidv4(), serverId, channelId || null, action, actorUserId, targetUserId, details, now]
  );
}

async function getServerActorPerms(serverId, actorUserId) {
  const r = await pool.query(
    `SELECT s.owner_id,
            sm.role as member_role,
            sm.role_id,
            sr.is_admin,
            sr.can_delete_messages,
            u.username,
            u.display_name
     FROM servers s
     LEFT JOIN server_members sm ON sm.server_id=s.id AND sm.user_id=$2
     LEFT JOIN server_roles sr ON sr.id=sm.role_id
     LEFT JOIN users u ON u.id=$2
     WHERE s.id=$1`,
    [serverId, actorUserId]
  );
  if (!r.rows.length || !r.rows[0].member_role) return null;
  const row = r.rows[0];
  const isOwner = row.owner_id === actorUserId;
  const isAdmin = isOwner || row.member_role === 'admin' || !!row.is_admin;
  const canModerate = isAdmin || !!row.can_delete_messages;
  return {
    row,
    isOwner,
    isAdmin,
    canModerate,
    actorName: row.display_name || row.username || 'Unknown'
  };
}

async function getMuteState(serverId, userId) {
  const r = await pool.query(
    'SELECT id, muted_until FROM server_mutes WHERE server_id=$1 AND user_id=$2',
    [serverId, userId]
  );
  if (!r.rows.length) return null;
  const mute = r.rows[0];
  const now = Math.floor(Date.now() / 1000);
  if (parseInt(mute.muted_until, 10) <= now) {
    await pool.query('DELETE FROM server_mutes WHERE id=$1', [mute.id]);
    return null;
  }
  return { id: mute.id, mutedUntil: parseInt(mute.muted_until, 10) };
}

async function runChannelCommand({ socket, serverId, channelId, actorUserId, actorDisplayName, input, botConfig }) {
  const raw = String(input || '').trim();
  const prefix = (botConfig?.botPrefix || '/').toString();
  if (!raw.startsWith(prefix)) return false;
  const cmdToken = raw.split(/\s+/)[0].toLowerCase();
  const cmd = cmdToken.slice(prefix.length);
  const perms = await getServerActorPerms(serverId, actorUserId);
  if (!perms) return true;

  const targetFromMention = raw.match(/<@user:([a-f0-9-]+)>/i)?.[1] || null;
  const serverMeta = await pool.query('SELECT owner_id, mod_log_channel_id FROM servers WHERE id=$1', [serverId]);
  const ownerId = serverMeta.rows[0]?.owner_id;
  const modLogChannelId = serverMeta.rows[0]?.mod_log_channel_id || null;

  if (cmd === 'help') {
    await emitBotChannelMessage({
      serverId,
      channelId,
      botName: botConfig?.botName,
      content: [
        `**${NEXUS_BOT_NAME} Commands**`,
        `\`${prefix}help\` \`${prefix}serverstats\` \`${prefix}poll question | option1 | option2 ...\``,
        `\`${prefix}warn @user reason\` \`${prefix}mute @user 10m reason\` \`${prefix}unmute @user\``,
        `\`${prefix}kick @user reason\` \`${prefix}ban @user reason\` \`${prefix}unban @user\``,
        `\`${prefix}setmodlog\` (sets current channel as moderation log)`,
        `\`${prefix}modlog 10\` (show recent moderation actions)`,
        `\`${prefix}botconfig show|prefix|enabled|automod|links|caps|spam|words\``
      ].join('\n')
    });
    return true;
  }

  if (cmd === 'serverstats') {
    const [memberCount, channelCount, banCount] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM server_members WHERE server_id=$1', [serverId]),
      pool.query('SELECT COUNT(*) FROM channels WHERE server_id=$1', [serverId]),
      pool.query('SELECT COUNT(*) FROM server_bans WHERE server_id=$1', [serverId])
    ]);
    await emitBotChannelMessage({
      serverId,
      channelId,
      botName: botConfig?.botName,
      content: `**Server Stats**\nMembers: ${memberCount.rows[0].count}\nChannels: ${channelCount.rows[0].count}\nBanned users: ${banCount.rows[0].count}`
    });
    return true;
  }

  if (cmd === 'poll') {
    const pollPayload = raw.replace(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}poll\\s+`, 'i'), '');
    const parts = pollPayload.split('|').map(p => p.trim()).filter(Boolean);
    if (parts.length < 3) {
      socket.emit('channel_error', { channelId, error: `Usage: ${prefix}poll Question | Option 1 | Option 2` });
      return true;
    }
    const question = parts[0];
    const options = parts.slice(1, 7);
    const lines = options.map((opt, i) => `${i + 1}. ${opt}`);
    await emitBotChannelMessage({
      serverId,
      channelId,
      botName: botConfig?.botName,
      content: `**Poll by ${perms.actorName || actorDisplayName || 'member'}**\n${question}\n${lines.join('\n')}`
    });
    return true;
  }

  if (cmd === 'setmodlog') {
    if (!perms.isAdmin) {
      socket.emit('channel_error', { channelId, error: 'Admins only' });
      return true;
    }
    await pool.query('UPDATE servers SET mod_log_channel_id=$1 WHERE id=$2', [channelId, serverId]);
    await emitBotChannelMessage({ serverId, channelId, botName: botConfig?.botName, content: 'Moderation log channel set to this channel.' });
    await logModerationAction({ serverId, channelId, action: 'set_mod_log', actorUserId, details: `channel:${channelId}` });
    return true;
  }

  if (cmd === 'botconfig') {
    if (!perms.isAdmin) {
      socket.emit('channel_error', { channelId, error: 'Admins only' });
      return true;
    }
    const tokens = raw.split(/\s+/).slice(1);
    const action = (tokens[0] || 'show').toLowerCase();
    const value = tokens.slice(1).join(' ').trim();

    if (action === 'show') {
      await emitBotChannelMessage({
        serverId,
        channelId,
        botName: botConfig?.botName,
        content: [
          '**Bot Config**',
          `Name: ${NEXUS_BOT_NAME} (locked)`,
          `Prefix: ${prefix}`,
          `Enabled: ${botConfig?.botEnabled ? 'on' : 'off'}`,
          `Automod: ${botConfig?.botAutoMod ? 'on' : 'off'}`,
          `Block links: ${botConfig?.botBlockLinks ? 'on' : 'off'}`,
          `Caps threshold: ${botConfig?.botCapsThreshold || 90}%`,
          `Spam window: ${botConfig?.botSpamWindow || 6} msgs/6s`,
          `Blocked words: ${(botConfig?.blockedWords || []).length}`
        ].join('\n')
      });
      return true;
    }

    if (action === 'name') {
      await emitBotChannelMessage({ serverId, channelId, botName: NEXUS_BOT_NAME, content: `Bot name is locked to ${NEXUS_BOT_NAME}.` });
      return true;
    }

    if (action === 'prefix') {
      const nextPrefix = (value || '/').trim().slice(0, 2);
      if (!nextPrefix) {
        socket.emit('channel_error', { channelId, error: `Usage: ${prefix}botconfig prefix !` });
        return true;
      }
      await pool.query('UPDATE servers SET bot_prefix=$1 WHERE id=$2', [nextPrefix, serverId]);
      await logModerationAction({ serverId, channelId, action: 'bot_config_prefix', actorUserId, details: nextPrefix });
      await emitBotChannelMessage({ serverId, channelId, botName: botConfig?.botName, content: `Bot prefix updated to ${nextPrefix}` });
      return true;
    }

    if (['enabled', 'automod', 'links'].includes(action)) {
      const on = ['on', 'true', '1', 'yes'].includes((tokens[1] || '').toLowerCase());
      const off = ['off', 'false', '0', 'no'].includes((tokens[1] || '').toLowerCase());
      if (!on && !off) {
        socket.emit('channel_error', { channelId, error: `Usage: ${prefix}botconfig ${action} on|off` });
        return true;
      }
      if (action === 'enabled') await pool.query('UPDATE servers SET bot_enabled=$1 WHERE id=$2', [on, serverId]);
      if (action === 'automod') await pool.query('UPDATE servers SET bot_auto_mod=$1 WHERE id=$2', [on, serverId]);
      if (action === 'links') await pool.query('UPDATE servers SET bot_block_links=$1 WHERE id=$2', [on, serverId]);
      await logModerationAction({ serverId, channelId, action: `bot_config_${action}`, actorUserId, details: on ? 'on' : 'off' });
      await emitBotChannelMessage({ serverId, channelId, botName: botConfig?.botName, content: `${action} is now ${on ? 'on' : 'off'}.` });
      return true;
    }

    if (action === 'caps') {
      const pct = parseInt(tokens[1], 10);
      if (!pct || pct < 50 || pct > 100) {
        socket.emit('channel_error', { channelId, error: `Usage: ${prefix}botconfig caps 50-100` });
        return true;
      }
      await pool.query('UPDATE servers SET bot_caps_threshold=$1 WHERE id=$2', [pct, serverId]);
      await logModerationAction({ serverId, channelId, action: 'bot_config_caps', actorUserId, details: String(pct) });
      await emitBotChannelMessage({ serverId, channelId, botName: botConfig?.botName, content: `Caps threshold set to ${pct}%` });
      return true;
    }

    if (action === 'spam') {
      const count = parseInt(tokens[1], 10);
      if (!count || count < 3 || count > 20) {
        socket.emit('channel_error', { channelId, error: `Usage: ${prefix}botconfig spam 3-20` });
        return true;
      }
      await pool.query('UPDATE servers SET bot_spam_window=$1 WHERE id=$2', [count, serverId]);
      await logModerationAction({ serverId, channelId, action: 'bot_config_spam', actorUserId, details: String(count) });
      await emitBotChannelMessage({ serverId, channelId, botName: botConfig?.botName, content: `Spam threshold set to ${count} messages/6s` });
      return true;
    }

    if (action === 'words') {
      const sub = (tokens[1] || '').toLowerCase();
      const word = (tokens[2] || '').trim().toLowerCase();
      if (sub === 'list') {
        const words = botConfig?.blockedWords || [];
        await emitBotChannelMessage({
          serverId,
          channelId,
          botName: NEXUS_BOT_NAME,
          content: words.length
            ? `**Blocked words**\n${words.map(w => `- ${w}`).join('\n')}`
            : 'No blocked words configured.'
        });
        return true;
      }
      if (sub === 'clear') {
        await pool.query('DELETE FROM server_blocked_words WHERE server_id=$1', [serverId]);
        await logModerationAction({ serverId, channelId, action: 'bot_config_words_clear', actorUserId });
        await emitBotChannelMessage({ serverId, channelId, botName: NEXUS_BOT_NAME, content: 'Blocked words list cleared.' });
        return true;
      }
      if ((sub === 'add' || sub === 'remove') && (!word || word.length < 2 || word.length > 40)) {
        socket.emit('channel_error', { channelId, error: `Usage: ${prefix}botconfig words add|remove <word>` });
        return true;
      }
      if (sub === 'add') {
        await pool.query(
          `INSERT INTO server_blocked_words (id, server_id, word, created_by)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (server_id, word) DO NOTHING`,
          [uuidv4(), serverId, word, actorUserId]
        );
        await logModerationAction({ serverId, channelId, action: 'bot_config_words_add', actorUserId, details: word });
        await emitBotChannelMessage({ serverId, channelId, botName: NEXUS_BOT_NAME, content: `Added blocked word: ${word}` });
        return true;
      }
      if (sub === 'remove') {
        await pool.query('DELETE FROM server_blocked_words WHERE server_id=$1 AND word=$2', [serverId, word]);
        await logModerationAction({ serverId, channelId, action: 'bot_config_words_remove', actorUserId, details: word });
        await emitBotChannelMessage({ serverId, channelId, botName: NEXUS_BOT_NAME, content: `Removed blocked word: ${word}` });
        return true;
      }
      socket.emit('channel_error', { channelId, error: `Usage: ${prefix}botconfig words add|remove|list|clear` });
      return true;
    }

    socket.emit('channel_error', { channelId, error: `Usage: ${prefix}botconfig show|prefix|enabled|automod|links|caps|spam|words` });
    return true;
  }

  if (cmd === 'modlog') {
    if (!perms.canModerate) {
      socket.emit('channel_error', { channelId, error: 'Moderators only' });
      return true;
    }
    const n = Math.min(20, Math.max(1, parseInt(raw.split(/\s+/)[1], 10) || 8));
    const r = await pool.query(
      `SELECT ml.action, ml.details, ml.created_at,
              au.display_name as actor_display, au.username as actor_username,
              tu.display_name as target_display, tu.username as target_username
       FROM moderation_logs ml
       LEFT JOIN users au ON au.id=ml.actor_user_id
       LEFT JOIN users tu ON tu.id=ml.target_user_id
       WHERE ml.server_id=$1
       ORDER BY ml.created_at DESC
       LIMIT $2`,
      [serverId, n]
    );
    if (!r.rows.length) {
      await emitBotChannelMessage({ serverId, channelId, botName: botConfig?.botName, content: 'No moderation logs yet.' });
      return true;
    }
    const lines = r.rows.map(l => {
      const actor = l.actor_display || l.actor_username || 'unknown';
      const target = l.target_display || l.target_username ? ` -> ${l.target_display || l.target_username}` : '';
      const details = l.details ? ` (${l.details})` : '';
      return `- ${l.action}${target} by ${actor}${details}`;
    });
    await emitBotChannelMessage({ serverId, channelId, botName: botConfig?.botName, content: `**Recent Mod Actions**\n${lines.join('\n')}` });
    return true;
  }

  if (['warn', 'mute', 'unmute', 'kick', 'ban', 'unban'].includes(cmd) && !perms.canModerate) {
    socket.emit('channel_error', { channelId, error: 'Moderators only' });
    return true;
  }

  if (['warn', 'mute', 'unmute', 'kick', 'ban', 'unban'].includes(cmd) && !targetFromMention) {
    socket.emit('channel_error', { channelId, error: 'Mention a user like <@user:...>' });
    return true;
  }

  if (targetFromMention && targetFromMention === ownerId && !perms.isOwner) {
    socket.emit('channel_error', { channelId, error: 'Only the owner can moderate the owner.' });
    return true;
  }

  if (cmd === 'warn') {
    const reason = raw.replace(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}warn\\s+<@user:[a-f0-9-]+>\\s*`, 'i'), '').trim() || 'No reason provided';
    await logModerationAction({ serverId, channelId, action: 'warn', actorUserId, targetUserId: targetFromMention, details: reason });
    await emitBotChannelMessage({ serverId, channelId, botName: botConfig?.botName, content: `Warned <@user:${targetFromMention}>. Reason: ${reason}` });
    await sendBotDirectMessage({
      toUserId: targetFromMention,
      content: `[${NEXUS_BOT_NAME}] You were warned in server ${serverId}. Reason: ${reason}`
    });
    if (modLogChannelId && modLogChannelId !== channelId) {
      await emitBotChannelMessage({ serverId, channelId: modLogChannelId, botName: botConfig?.botName, content: `[MOD LOG] ${perms.actorName} warned <@user:${targetFromMention}> (${reason})` });
    }
    return true;
  }

  if (cmd === 'mute') {
    const durationRaw = raw.match(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}mute\\s+<@user:[a-f0-9-]+>\\s+(\\S+)`, 'i'))?.[1];
    const durationSeconds = parseDurationToSeconds(durationRaw);
    if (!durationSeconds) {
      socket.emit('channel_error', { channelId, error: `Usage: ${prefix}mute <@user:id> 10m optional reason` });
      return true;
    }
    const reason = raw.replace(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}mute\\s+<@user:[a-f0-9-]+>\\s+\\S+\\s*`, 'i'), '').trim() || 'No reason provided';
    const mutedUntil = Math.floor(Date.now() / 1000) + durationSeconds;
    await pool.query(
      `INSERT INTO server_mutes (id, server_id, user_id, muted_by, reason, muted_until)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (server_id, user_id) DO UPDATE SET muted_by=$4, reason=$5, muted_until=$6`,
      [uuidv4(), serverId, targetFromMention, actorUserId, reason, mutedUntil]
    );
    await logModerationAction({ serverId, channelId, action: 'mute', actorUserId, targetUserId: targetFromMention, details: `${humanDuration(durationSeconds)} | ${reason}` });
    await emitBotChannelMessage({ serverId, channelId, botName: botConfig?.botName, content: `Muted <@user:${targetFromMention}> for ${humanDuration(durationSeconds)}. Reason: ${reason}` });
    await sendBotDirectMessage({
      toUserId: targetFromMention,
      content: `[${NEXUS_BOT_NAME}] You were muted in server ${serverId} for ${humanDuration(durationSeconds)}. Reason: ${reason}`
    });
    if (modLogChannelId && modLogChannelId !== channelId) {
      await emitBotChannelMessage({ serverId, channelId: modLogChannelId, botName: botConfig?.botName, content: `[MOD LOG] ${perms.actorName} muted <@user:${targetFromMention}> for ${humanDuration(durationSeconds)} (${reason})` });
    }
    return true;
  }

  if (cmd === 'unmute') {
    await pool.query('DELETE FROM server_mutes WHERE server_id=$1 AND user_id=$2', [serverId, targetFromMention]);
    await logModerationAction({ serverId, channelId, action: 'unmute', actorUserId, targetUserId: targetFromMention });
    await emitBotChannelMessage({ serverId, channelId, botName: botConfig?.botName, content: `Unmuted <@user:${targetFromMention}>.` });
    await sendBotDirectMessage({
      toUserId: targetFromMention,
      content: `[${NEXUS_BOT_NAME}] You were unmuted in server ${serverId}.`
    });
    if (modLogChannelId && modLogChannelId !== channelId) {
      await emitBotChannelMessage({ serverId, channelId: modLogChannelId, botName: botConfig?.botName, content: `[MOD LOG] ${perms.actorName} unmuted <@user:${targetFromMention}>` });
    }
    return true;
  }

  if (cmd === 'kick') {
    if (targetFromMention === actorUserId) {
      socket.emit('channel_error', { channelId, error: 'You cannot kick yourself.' });
      return true;
    }
    const reason = raw.replace(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}kick\\s+<@user:[a-f0-9-]+>\\s*`, 'i'), '').trim() || 'No reason provided';
    await pool.query('DELETE FROM server_members WHERE server_id=$1 AND user_id=$2', [serverId, targetFromMention]);
    io.to(`user:${targetFromMention}`).emit('kicked_from_server', { serverId });
    await logModerationAction({ serverId, channelId, action: 'kick', actorUserId, targetUserId: targetFromMention, details: reason });
    await emitBotChannelMessage({ serverId, channelId, botName: botConfig?.botName, content: `Kicked <@user:${targetFromMention}>. Reason: ${reason}` });
    await sendBotDirectMessage({
      toUserId: targetFromMention,
      content: `[${NEXUS_BOT_NAME}] You were kicked from server ${serverId}. Reason: ${reason}`
    });
    if (modLogChannelId && modLogChannelId !== channelId) {
      await emitBotChannelMessage({ serverId, channelId: modLogChannelId, botName: botConfig?.botName, content: `[MOD LOG] ${perms.actorName} kicked <@user:${targetFromMention}> (${reason})` });
    }
    return true;
  }

  if (cmd === 'ban') {
    if (targetFromMention === actorUserId) {
      socket.emit('channel_error', { channelId, error: 'You cannot ban yourself.' });
      return true;
    }
    const reason = raw.replace(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}ban\\s+<@user:[a-f0-9-]+>\\s*`, 'i'), '').trim() || 'No reason provided';
    await pool.query('DELETE FROM server_members WHERE server_id=$1 AND user_id=$2', [serverId, targetFromMention]);
    await pool.query(
      `INSERT INTO server_bans (id, server_id, user_id, banned_by, reason)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (server_id, user_id) DO UPDATE SET banned_by=$4, reason=$5`,
      [uuidv4(), serverId, targetFromMention, actorUserId, reason]
    );
    io.to(`user:${targetFromMention}`).emit('banned_from_server', { serverId });
    await logModerationAction({ serverId, channelId, action: 'ban', actorUserId, targetUserId: targetFromMention, details: reason });
    await emitBotChannelMessage({ serverId, channelId, botName: botConfig?.botName, content: `Banned <@user:${targetFromMention}>. Reason: ${reason}` });
    await sendBotDirectMessage({
      toUserId: targetFromMention,
      content: `[${NEXUS_BOT_NAME}] You were banned from server ${serverId}. Reason: ${reason}`
    });
    if (modLogChannelId && modLogChannelId !== channelId) {
      await emitBotChannelMessage({ serverId, channelId: modLogChannelId, botName: botConfig?.botName, content: `[MOD LOG] ${perms.actorName} banned <@user:${targetFromMention}> (${reason})` });
    }
    return true;
  }

  if (cmd === 'unban') {
    await pool.query('DELETE FROM server_bans WHERE server_id=$1 AND user_id=$2', [serverId, targetFromMention]);
    await logModerationAction({ serverId, channelId, action: 'unban', actorUserId, targetUserId: targetFromMention });
    await emitBotChannelMessage({ serverId, channelId, botName: botConfig?.botName, content: `Unbanned <@user:${targetFromMention}>.` });
    await sendBotDirectMessage({
      toUserId: targetFromMention,
      content: `[${NEXUS_BOT_NAME}] You were unbanned in server ${serverId}.`
    });
    if (modLogChannelId && modLogChannelId !== channelId) {
      await emitBotChannelMessage({ serverId, channelId: modLogChannelId, botName: botConfig?.botName, content: `[MOD LOG] ${perms.actorName} unbanned <@user:${targetFromMention}>` });
    }
    return true;
  }

  socket.emit('channel_error', { channelId, error: `Unknown command. Try ${prefix}help` });
  return true;
}

io.on('connection', (socket) => {
  const userId = socket.userId;
  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId).add(socket.id);

  pool.query("UPDATE users SET status='online' WHERE id=$1", [userId])
    .then(() => broadcastStatusChange(userId, 'online'));

  socket.join(`user:${userId}`);

  socket.on('send_message', async ({ toId, content }) => {
    if (!toId || !content || typeof content !== 'string') return;
    const trimmed = content.trim().slice(0, 4000);
    if (!trimmed) return;
    // Single query: check friendship AND get sender info at once
    const check = await pool.query(
      `SELECT u.username, u.display_name, u.avatar_data, u.avatar_mime, u.active_decoration, u.active_color, u.active_font, u.pro_expires_at, u.profile_gradient_start, u.profile_gradient_end, u.profile_name_effect, ats.id AS tag_server_id, ats.name AS tag_server_name, ats.invite_code AS tag_invite_code, ats.server_tag, ats.tag_background,
        (SELECT id FROM friendships WHERE (user1_id=$1 AND user2_id=$2) OR (user1_id=$2 AND user2_id=$1) LIMIT 1) as friend_id
       FROM users u LEFT JOIN servers ats ON ats.id=u.active_server_tag_id WHERE u.id=$1`,
      [userId, toId]
    );
    if (!check.rows.length || !check.rows[0].friend_id) return;
    const s = check.rows[0];
    const msgId = uuidv4();
    const now = Math.floor(Date.now() / 1000);
    const mentions = await resolveDirectMentions(trimmed, [userId, toId]);
    // Build message object immediately — emit to sender first for instant feedback
    const msg = {
      id: msgId, fromId: userId, toId, content: trimmed, createdAt: now,
      mentions,
      author: {
        username: s.username, displayName: s.display_name,
        avatarDataUrl: avatarUrl(userId, !!s.avatar_data),
        activeDecoration: s.active_decoration || null,
        activeColor: s.active_color || null,
        activeFont: s.active_font || null, proActive: (s.pro_expires_at || 0) > Math.floor(Date.now() / 1000), proGradientStart: s.profile_gradient_start, proGradientEnd: s.profile_gradient_end, proNameEffect: s.profile_name_effect,
        activeServerTag: s.server_tag || null, activeServerTagBackground: s.tag_background || '#5865f2', activeServerTagServerId: s.tag_server_id || null, activeServerTagServerName: s.tag_server_name || null, activeServerTagInviteCode: s.tag_invite_code || null
      }
    };
    // Emit to sender immediately (no await before this)
    socket.emit('new_message', msg);
    // Emit to recipient
    io.to(`user:${toId}`).emit('new_message', msg);
    if (trimmed.includes(`<@user:${toId}>`)) {
      io.to(`user:${toId}`).emit('mentioned', {
        type: 'dm',
        fromUser: { displayName: s.display_name, username: s.username },
        preview: trimmed.replace(/<@user:[a-f0-9-]+>/g, '@...').slice(0, 80)
      });
    }
    // Emit to sender's other tabs
    socket.to(`user:${userId}`).emit('new_message', msg);
    // Persist to DB (non-blocking for perceived speed)
    pool.query('INSERT INTO messages (id, from_id, to_id, content, created_at) VALUES ($1,$2,$3,$4,$5)',
      [msgId, userId, toId, trimmed, now]).catch(e => console.error('DM insert error:', e));
    relayNexusDirectMessage({
      nexusRecipientId: toId,
      nexusMessageId: msgId,
      sender: {
        id: userId,
        username: s.username,
        displayName: s.display_name,
        avatarDataUrl: s.avatar_data ? `data:${s.avatar_mime};base64,${s.avatar_data}` : null,
        activeServerTag: s.server_tag || null
      },
      content: trimmed
    }).catch(error => console.error('Nexus LINK DM relay error:', error));

    // Achievement tracking — message count & DM
    trackAchievement(userId, ['messages_sent', 'dms_sent']);
  });

  socket.on('typing_start', async ({ toId }) => {
    const u = await pool.query('SELECT username FROM users WHERE id=$1', [userId]);
    io.to(`user:${toId}`).emit('user_typing', { fromId: userId, username: u.rows[0]?.username });
  });

  socket.on('typing_stop', ({ toId }) => {
    io.to(`user:${toId}`).emit('user_stop_typing', { fromId: userId });
  });

  // Join server socket rooms on connect
  pool.query(
    'SELECT server_id FROM server_members WHERE user_id=$1',
    [userId]
  ).then(r => {
    r.rows.forEach(({ server_id }) => socket.join(`server:${server_id}`));
  });

  socket.on('join_server_room', ({ serverId }) => {
    socket.join(`server:${serverId}`);
  });

  socket.on('send_channel_message', async ({ serverId, channelId, content, replyToMessageId }) => {
    if (!content || typeof content !== 'string') return;
    const trimmed = content.trim().slice(0, 4000);
    const normalizedReplyId = typeof replyToMessageId === 'string' && replyToMessageId.trim() ? replyToMessageId.trim() : null;
    if (!trimmed) return;

    const botConfig = await getServerBotConfig(serverId);

    if (trimmed.startsWith(botConfig.botPrefix || '/')) {
      const handled = await runChannelCommand({
        socket,
        serverId,
        channelId,
        actorUserId: userId,
        actorDisplayName: null,
        input: trimmed,
        botConfig
      });
      if (handled) return;
    }

    // Single query: get member info, role info, channel validity, and permission check
    const check = await pool.query(
      `SELECT sm.role_id, sm.role AS member_role, sr.name as role_name, sr.color as role_color, sr.gradient_start as role_gradient_start, sr.gradient_end as role_gradient_end,
        sr.is_admin, sr.can_delete_messages,
        u.username, u.display_name, u.avatar_data, u.avatar_mime, u.active_decoration, u.active_color, u.active_font, u.pro_expires_at, u.profile_gradient_start, u.profile_gradient_end, u.profile_name_effect, ats.id AS tag_server_id, ats.name AS tag_server_name, ats.invite_code AS tag_invite_code, ats.server_tag, ats.tag_background,
        ch.id as ch_id, ch.locked, ch.private as ch_private, ch.slowmode_seconds, ch.channel_type,
        (SELECT allow_send FROM channel_permissions cp
         WHERE cp.channel_id=$2 AND (cp.role_id=sm.role_id OR cp.role_id IS NULL)
         ORDER BY cp.role_id NULLS LAST LIMIT 1) as perm_allow
       FROM server_members sm
       JOIN users u ON u.id=sm.user_id
       JOIN channels ch ON ch.id=$2 AND ch.server_id=$1
       LEFT JOIN server_roles sr ON sr.id=sm.role_id
       LEFT JOIN servers ats ON ats.id=u.active_server_tag_id
       WHERE sm.server_id=$1 AND sm.user_id=$3`,
      [serverId, channelId, userId]
    );
    if (!check.rows.length) return; // not a member or channel doesn't belong to server
    const row = check.rows[0];

    if ((row.channel_type || 'text') === 'voice') {
      socket.emit('channel_error', { channelId, error: 'This is a voice channel. Join voice to communicate here.' });
      return;
    }

    // Check send permission (already fetched in initial query as perm_allow)
    if (row.locked && !row.is_admin && row.member_role !== 'admin' && !row.perm_allow) {
      socket.emit('channel_error', { channelId, error: 'You do not have permission to send messages in this channel' });
      return;
    }

    const slowmodeSeconds = Math.max(0, parseInt(row.slowmode_seconds, 10) || 0);
    const bypassSlowmode = row.is_admin || row.member_role === 'admin';
    if (slowmodeSeconds > 0 && !bypassSlowmode) {
      const lastMsg = await pool.query(
        `SELECT created_at FROM channel_messages
         WHERE channel_id=$1 AND from_id=$2
         ORDER BY created_at DESC
         LIMIT 1`,
        [channelId, userId]
      );
      if (lastMsg.rows.length) {
        const nowSec = Math.floor(Date.now() / 1000);
        const elapsed = nowSec - parseInt(lastMsg.rows[0].created_at, 10);
        if (elapsed < slowmodeSeconds) {
          socket.emit('channel_error', {
            channelId,
            error: `Slowmode is enabled. Wait ${slowmodeSeconds - elapsed}s before sending again.`
          });
          return;
        }
      }
    }

    const mute = await getMuteState(serverId, userId);
    if (mute) {
      const secondsLeft = Math.max(0, mute.mutedUntil - Math.floor(Date.now() / 1000));
      socket.emit('channel_error', {
        channelId,
        error: `You are muted in this server for ${humanDuration(secondsLeft)} more.`
      });
      return;
    }

    if (botConfig.botEnabled && botConfig.botAutoMod) {
      const lower = trimmed.toLowerCase();
      const blockedWord = (botConfig.blockedWords || []).find(w => lower.includes(w));
      if (blockedWord) {
        socket.emit('channel_error', { channelId, error: `Message blocked: contains blocked word "${blockedWord}".` });
        await sendBotDirectMessage({
          toUserId: userId,
          content: `[${NEXUS_BOT_NAME}] Your message in server ${serverId} was blocked for using a filtered word: ${blockedWord}`
        });
        return;
      }

      const linkHit = botConfig.botBlockLinks && /(https?:\/\/|www\.)/i.test(trimmed);
      if (linkHit) {
        socket.emit('channel_error', { channelId, error: 'Links are blocked by server automod.' });
        await emitBotChannelMessage({
          serverId,
          channelId,
          botName: botConfig.botName,
          content: `<@user:${userId}> message blocked: links are not allowed here.`
        });
        return;
      }

      const lettersOnly = trimmed.replace(/[^a-z]/gi, '');
      const upperOnly = trimmed.replace(/[^A-Z]/g, '');
      if (lettersOnly.length >= 12) {
        const capsPct = Math.round((upperOnly.length / lettersOnly.length) * 100);
        if (capsPct >= botConfig.botCapsThreshold) {
          socket.emit('channel_error', { channelId, error: `Message blocked: too much caps (${capsPct}%).` });
          return;
        }
      }

      const spamKey = `${serverId}:${userId}`;
      const nowMs = Date.now();
      const prev = spamTracker.get(spamKey) || [];
      const recent = prev.filter(ts => nowMs - ts < 6000);
      recent.push(nowMs);
      spamTracker.set(spamKey, recent);
      if (recent.length > botConfig.botSpamWindow) {
        socket.emit('channel_error', { channelId, error: 'Slow down. Automod detected message spam.' });
        return;
      }
    }

    let replyTo = null;
    if (normalizedReplyId) {
      const replyRes = await pool.query(
        `SELECT cm.id, cm.from_id, cm.content, u.display_name, u.username
         FROM channel_messages cm
         JOIN users u ON u.id=cm.from_id
         WHERE cm.id=$1 AND cm.channel_id=$2`,
        [normalizedReplyId, channelId]
      );
      if (!replyRes.rows.length) {
        socket.emit('channel_error', { channelId, error: 'Reply target was not found in this channel.' });
        return;
      }
      const r = replyRes.rows[0];
      replyTo = {
        id: r.id,
        fromId: r.from_id,
        displayName: r.display_name || r.username,
        content: String(r.content || '').slice(0, 160)
      };
    }

    const msgId = uuidv4();
    const now = Math.floor(Date.now() / 1000);
    const mentions = await resolveChannelMentions(trimmed, serverId);
    const msg = {
      id: msgId, channelId, serverId, fromId: userId,
      content: trimmed, createdAt: now,
      isPinned: false,
      replyTo,
      mentions,
      author: {
        username: row.username, displayName: row.display_name,
        avatarDataUrl: avatarUrl(userId, !!row.avatar_data),
        roleColor: row.role_color || null, roleName: row.role_name || null, roleGradientStart: row.role_gradient_start || null, roleGradientEnd: row.role_gradient_end || null,
        activeDecoration: row.active_decoration || null,
        activeColor: row.active_color || null,
        activeFont: row.active_font || null, proActive: (row.pro_expires_at || 0) > Math.floor(Date.now() / 1000), proGradientStart: row.profile_gradient_start, proGradientEnd: row.profile_gradient_end, proNameEffect: row.profile_name_effect,
        activeServerTag: row.server_tag || null, activeServerTagBackground: row.tag_background || '#5865f2', activeServerTagServerId: row.tag_server_id || null, activeServerTagServerName: row.tag_server_name || null, activeServerTagInviteCode: row.tag_invite_code || null
      }
    };
    // Resolve mentions for notification
    const userMentionMatches = [...trimmed.matchAll(/<@user:([a-f0-9-]+)>/g)];
    const roleMentionMatches = [...trimmed.matchAll(/<@role:([a-f0-9-]+)>/g)];
    const specialMentionMatches = [...new Set([...trimmed.matchAll(/<@(everyone|here)>/g)].map(m => m[1]))];

    // Notify mentioned users
    userMentionMatches.forEach(m => {
      const mentionedId = m[1];
      if (mentionedId !== userId) {
        io.to(`user:${mentionedId}`).emit('mentioned', {
          type: 'channel', serverId, channelId,
          fromUser: { displayName: row.display_name, username: row.username },
          preview: trimmed.replace(/<@(user|role):[a-f0-9-]+>/g, '@...').slice(0, 80)
        });
      }
    });

    // Notify mentioned role members
    if (roleMentionMatches.length) {
      const roleIds = roleMentionMatches.map(m => m[1]);
      pool.query(
        `SELECT user_id FROM server_members WHERE server_id=$1 AND role_id = ANY($2)`,
        [serverId, roleIds]
      ).then(r => {
        r.rows.forEach(({ user_id }) => {
          if (user_id !== userId) {
            io.to(`user:${user_id}`).emit('mentioned', {
              type: 'channel', serverId, channelId,
              fromUser: { displayName: row.display_name, username: row.username },
              preview: trimmed.replace(/<@(user|role):[a-f0-9-]+>/g, '@...').slice(0, 80)
            });
          }
        });
      });
    }

    if (specialMentionMatches.length) {
      socket.to(`server:${serverId}`).emit('mentioned', {
        type: 'channel', serverId, channelId,
        special: specialMentionMatches.includes('everyone') ? 'everyone' : 'here',
        fromUser: { displayName: row.display_name, username: row.username },
        preview: trimmed.replace(/<@(user|role):[a-f0-9-]+>/g, '@...').replace(/<@(everyone|here)>/g, '@$1').slice(0, 80)
      });
    }

    // Emit to sender immediately, then rest of server room
    socket.emit('new_channel_message', msg);
    socket.to(`server:${serverId}`).emit('new_channel_message', msg);
    // Persist non-blocking
    pool.query(
      'INSERT INTO channel_messages (id, channel_id, from_id, content, created_at, reply_to_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [msgId, channelId, userId, trimmed, now, normalizedReplyId]
    ).catch(e => console.error('Channel msg insert error:', e));
    relayNexusChannelMessage({
      serverId,
      channelId,
      nexusMessageId: msgId,
      sender: { id: userId, username: row.username, displayName: row.display_name, avatarDataUrl: row.avatar_data ? `data:${row.avatar_mime};base64,${row.avatar_data}` : null },
      content: trimmed,
      replyTo
    }).catch(error => console.error('Nexus LINK channel relay error:', error));

    // Achievement tracking
    trackAchievement(userId, ['messages_sent', 'channel_msgs']);
  });

  socket.on('channel_typing_start', ({ serverId, channelId }) => {
    pool.query('SELECT username FROM users WHERE id=$1', [userId]).then(r => {
      socket.to(`server:${serverId}`).emit('channel_user_typing', {
        channelId, userId, username: r.rows[0]?.username
      });
    });
  });

  socket.on('channel_typing_stop', ({ serverId, channelId }) => {
    socket.to(`server:${serverId}`).emit('channel_user_stop_typing', { channelId, userId });
  });

  socket.on('channel_message_deleted', ({ serverId, channelId, messageId }) => {
    // Broadcast deletion to all server members
    io.to(`server:${serverId}`).emit('channel_message_deleted', { channelId, messageId });
  });

  socket.on('toggle_channel_reaction', async ({ serverId, channelId, messageId, emoji }) => {
    const normalizedEmoji = String(emoji || '').trim().slice(0, 16);
    if (!normalizedEmoji) return;

    const member = await pool.query(
      'SELECT id FROM server_members WHERE server_id=$1 AND user_id=$2',
      [serverId, userId]
    );
    if (!member.rows.length) return;

    const msg = await pool.query(
      `SELECT cm.id
       FROM channel_messages cm
       JOIN channels ch ON ch.id=cm.channel_id
       WHERE cm.id=$1 AND cm.channel_id=$2 AND ch.server_id=$3`,
      [messageId, channelId, serverId]
    );
    if (!msg.rows.length) return;

    const existing = await pool.query(
      `SELECT id FROM channel_message_reactions
       WHERE message_id=$1 AND user_id=$2 AND emoji=$3
       LIMIT 1`,
      [messageId, userId, normalizedEmoji]
    );

    if (existing.rows.length) {
      await pool.query('DELETE FROM channel_message_reactions WHERE id=$1', [existing.rows[0].id]);
    } else {
      await pool.query(
        `INSERT INTO channel_message_reactions (id, message_id, user_id, emoji)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (message_id, user_id, emoji) DO NOTHING`,
        [uuidv4(), messageId, userId, normalizedEmoji]
      );
    }

    const agg = await pool.query(
      `SELECT emoji, COUNT(*)::int as count, BOOL_OR(user_id=$2) as reacted
       FROM channel_message_reactions
       WHERE message_id=$1
       GROUP BY emoji
       ORDER BY count DESC, emoji ASC`,
      [messageId, userId]
    );

    io.to(`server:${serverId}`).emit('channel_message_reaction_updated', {
      channelId,
      messageId,
      reactions: agg.rows.map(r => ({
        emoji: r.emoji,
        count: parseInt(r.count, 10) || 0,
        reacted: !!r.reacted
      }))
    });
    relayNexusChannelReaction({ nexusMessageId: messageId, emoji: normalizedEmoji })
      .catch(error => console.error('Nexus LINK reaction relay error:', error));
  });

  // Admin: force-suspend an active user
  socket.on('admin_suspend_user', async ({ targetUserId, suspendedUntil, reason }) => {
    // Verify the requesting socket is an admin
    const { isGlobalAdmin } = require('./routes/admin');
    if (!(await isGlobalAdmin(userId))) return;
    // Emit suspended event to all of that user's sockets
    io.to(`user:${targetUserId}`).emit('account_suspended', { suspendedUntil, reason: reason || null });
  });

  socket.on('call_invite', async ({ toId, callType }) => {
    const targetRoom = await getUserCallRoom(toId);
    if (targetRoom) { socket.emit('call_busy', { userId: toId }); return; }
    const roomId = uuidv4();
    const normalizedCallType = callType === 'video' ? 'video' : 'voice';
    callTypes.set(roomId, normalizedCallType);
    directCallInvites.set(roomId, { fromId: userId, toId, callType: normalizedCallType });
    const caller = await pool.query(
      `SELECT u.username, u.display_name, u.avatar_data, u.avatar_mime, ats.server_tag
       FROM users u LEFT JOIN servers ats ON ats.id=u.active_server_tag_id WHERE u.id=$1`, [userId]
    );
    const c = caller.rows[0];
    io.to(`user:${toId}`).emit('incoming_call', {
      roomId, fromId: userId,
      callType: normalizedCallType,
      caller: {
        username: c.username, displayName: c.display_name,
        avatarDataUrl: avatarUrl(userId, !!c.avatar_data)
      }
    });
    relayNexusCallInvite({
      nexusRecipientId: toId,
      roomId,
      callType: normalizedCallType,
      caller: {
        id: userId,
        username: c.username,
        displayName: c.display_name,
        avatarDataUrl: avatarUrl(userId, !!c.avatar_data),
        activeServerTag: c.server_tag || null
      }
    }).catch(error => console.error('Nexus LINK call relay error:', error));
    socket.emit('call_ringing', { roomId, toId, callType: normalizedCallType });
  });

  socket.on('call_accept', async ({ roomId, toId }) => {
    const invite = directCallInvites.get(roomId);
    if (!invite || invite.fromId !== toId || invite.toId !== userId) return;
    directCallInvites.delete(roomId);
    const callType = callTypes.get(roomId) || 'voice';
    await setRoomParticipants(roomId, [userId, toId]);
    await setUserCallRoom(userId, roomId);
    await setUserCallRoom(toId, roomId);
    socket.join(`call:${roomId}`);
    io.to(`user:${toId}`).emit('call_accepted', { roomId, byId: userId, callType });
    socket.emit('call_joined', { roomId, callType });
  });

  socket.on('call_decline', ({ roomId, toId }) => {
    const invite = directCallInvites.get(roomId);
    if (!invite || invite.fromId !== toId || invite.toId !== userId) return;
    directCallInvites.delete(roomId);
    callTypes.delete(roomId);
    io.to(`user:${toId}`).emit('call_declined', { roomId, byId: userId });
  });

  socket.on('join_call', ({ roomId }) => {
    socket.join(`call:${roomId}`);
    socket.to(`call:${roomId}`).emit('peer_joined', { userId });
  });

  socket.on('webrtc_offer', ({ roomId, toId, offer }) => {
    io.to(`user:${toId}`).emit('webrtc_offer', { roomId, fromId: userId, offer });
  });
  socket.on('webrtc_answer', ({ roomId, toId, answer }) => {
    io.to(`user:${toId}`).emit('webrtc_answer', { roomId, fromId: userId, answer });
  });
  socket.on('webrtc_ice', ({ roomId, toId, candidate }) => {
    io.to(`user:${toId}`).emit('webrtc_ice', { roomId, fromId: userId, candidate });
  });

  socket.on('call_end', async ({ roomId }) => {
    if (callGames.delete(roomId)) {
      io.to(`call:${roomId}`).emit('call_game_closed', { roomId });
      io.to(`groupcall:${roomId}`).emit('call_game_closed', { roomId });
    }
    const room = await getRoomParticipants(roomId);
    if (room && room.size) {
      for (const uid of room) {
        await clearUserCallRoom(uid);
        io.to(`user:${uid}`).emit('call_ended', { roomId });
      }
      await clearRoomParticipants(roomId);
      callTypes.delete(roomId);
    }
    socket.leave(`call:${roomId}`);
  });

  socket.on('call_cancel', ({ toId, roomId }) => {
    if (roomId) { callTypes.delete(roomId); directCallInvites.delete(roomId); }
    // Receiver will ignore if there is no pending call.
    io.to(`user:${toId}`).emit('call_cancelled', { fromId: userId });
  });

  socket.on('screenshare_started', ({ roomId, toId }) => {
    io.to(`user:${toId}`).emit('screenshare_started', { fromId: userId });
  });

  socket.on('screenshare_stopped', ({ roomId, toId }) => {
    io.to(`user:${toId}`).emit('screenshare_stopped', { fromId: userId });
  });

  socket.on('join_group_call', async ({ serverId, channelId }) => {
    if (!serverId || !channelId) return;

    const member = await pool.query(
      'SELECT id FROM server_members WHERE server_id=$1 AND user_id=$2',
      [serverId, userId]
    );
    if (!member.rows.length) return;

    const channel = await pool.query(
      `SELECT id, channel_type FROM channels WHERE id=$1 AND server_id=$2`,
      [channelId, serverId]
    );
    if (!channel.rows.length) return;
    if ((channel.rows[0].channel_type || 'text') !== 'voice') return;

    const roomId = getGroupCallRoomId(serverId, channelId);
    const previousRoomId = userGroupCallRoom.get(userId);
    if (previousRoomId && previousRoomId !== roomId) {
      const prevRoom = groupCallRooms.get(previousRoomId);
      if (prevRoom) {
        prevRoom.delete(userId);
        io.to(`groupcall:${previousRoomId}`).emit('group_call_user_left', { roomId: previousRoomId, userId });
        if (!prevRoom.size) groupCallRooms.delete(previousRoomId);
      }
      userGroupCallRoom.delete(userId);
      socket.leave(`groupcall:${previousRoomId}`);
    }

    if (!groupCallRooms.has(roomId)) groupCallRooms.set(roomId, new Set());
    const roomSet = groupCallRooms.get(roomId);
    roomSet.add(userId);
    userGroupCallRoom.set(userId, roomId);
    socket.join(`groupcall:${roomId}`);

    const participantIds = [...roomSet];
    const users = await pool.query(
      `SELECT id, username, display_name, avatar_data, avatar_mime
       FROM users WHERE id = ANY($1)`,
      [participantIds]
    );
    const participantMap = new Map(users.rows.map(u => [u.id, mapUserForClient(u)]));
    const participants = participantIds.map(id => participantMap.get(id)).filter(Boolean);

    socket.emit('group_call_joined', {
      roomId,
      serverId,
      channelId,
      participants
    });

    const joinedUser = participantMap.get(userId);
    if (joinedUser) {
      socket.to(`groupcall:${roomId}`).emit('group_call_user_joined', {
        roomId,
        user: joinedUser
      });
    }
  });

  socket.on('leave_group_call', () => {
    const roomId = userGroupCallRoom.get(userId);
    if (!roomId) return;

    const roomSet = groupCallRooms.get(roomId);
    if (roomSet) {
      roomSet.delete(userId);
      io.to(`groupcall:${roomId}`).emit('group_call_user_left', { roomId, userId });
      if (!roomSet.size) groupCallRooms.delete(roomId);
    }
    userGroupCallRoom.delete(userId);
    socket.leave(`groupcall:${roomId}`);
  });

  socket.on('group_webrtc_offer', ({ roomId, toId, offer }) => {
    const myRoom = userGroupCallRoom.get(userId);
    const peerRoom = userGroupCallRoom.get(toId);
    if (!roomId || myRoom !== roomId || peerRoom !== roomId) return;
    io.to(`user:${toId}`).emit('group_webrtc_offer', { roomId, fromId: userId, offer });
  });

  socket.on('group_webrtc_answer', ({ roomId, toId, answer }) => {
    const myRoom = userGroupCallRoom.get(userId);
    const peerRoom = userGroupCallRoom.get(toId);
    if (!roomId || myRoom !== roomId || peerRoom !== roomId) return;
    io.to(`user:${toId}`).emit('group_webrtc_answer', { roomId, fromId: userId, answer });
  });

  socket.on('group_webrtc_ice', ({ roomId, toId, candidate }) => {
    const myRoom = userGroupCallRoom.get(userId);
    const peerRoom = userGroupCallRoom.get(toId);
    if (!roomId || myRoom !== roomId || peerRoom !== roomId) return;
    io.to(`user:${toId}`).emit('group_webrtc_ice', { roomId, fromId: userId, candidate });
  });

  socket.on('call_game_open', async ({ roomId, type }, ack = () => {}) => {
    if (!roomId || !['blackjack', 'poker'].includes(type)) return ack({ error: 'Choose a valid game.' });
    if (!await isInGameRoom(userId, roomId)) return ack({ error: 'Join the call before starting a game.' });
    let game = callGames.get(roomId);
    if (!game || game.phase === 'complete') {
      const me = await pool.query('SELECT display_name FROM users WHERE id=$1', [userId]);
      game = { type, phase: 'lobby', hostId: userId, roundsTotal: 3, roundNumber: 0, players: [{ id: userId, displayName: me.rows[0]?.display_name || 'Player', chips: 1000, hand: [] }], dealer: { hand: [] }, deck: [], community: [], pot: 0 };
      callGames.set(roomId, game);
      const host = { id: userId, displayName: me.rows[0]?.display_name || 'Player' };
      socket.to(`call:${roomId}`).emit('call_game_invite', { roomId, type, host });
      socket.to(`groupcall:${roomId}`).emit('call_game_invite', { roomId, type, host });
    }
    const hostName = game.players.find(player => player.id === game.hostId)?.displayName || 'A caller';
    io.to(`call:${roomId}`).emit('call_game_available', { roomId, type: game.type, hostName });
    io.to(`groupcall:${roomId}`).emit('call_game_available', { roomId, type: game.type, hostName });
    socket.emit('call_game_state', { roomId, game: gameStateFor(game, userId) });
    emitGame(roomId);
    ack({ success: true });
  });

  socket.on('call_game_join', async ({ roomId }) => {
    const game = callGames.get(roomId);
    if (!game || game.phase !== 'lobby' || !await isInGameRoom(userId, roomId) || game.players.some(p => p.id === userId) || game.players.length >= 6) return;
    const me = await pool.query('SELECT display_name FROM users WHERE id=$1', [userId]);
    game.players.push({ id: userId, displayName: me.rows[0]?.display_name || 'Player', chips: 1000, hand: [] });
    emitGame(roomId);
  });

  socket.on('call_game_start', async ({ roomId, rounds }) => {
    const game = callGames.get(roomId);
    if (!game || game.hostId !== userId || game.phase !== 'lobby' || !await isInGameRoom(userId, roomId)) return;
    if (game.players.length < 2) {
      socket.emit('call_game_error', { message: 'A call game needs the other person to join first.' });
      return;
    }
    game.roundsTotal = Math.max(1, Math.min(10, parseInt(rounds, 10) || game.roundsTotal || 3));
    game.roundNumber = 1;
    beginCallGameRound(game);
    emitGame(roomId);
  });

  socket.on('call_game_close', async ({ roomId }) => {
    const game = callGames.get(roomId);
    if (!game || game.hostId !== userId || !await isInGameRoom(userId, roomId)) return;
    callGames.delete(roomId);
    io.to(`call:${roomId}`).emit('call_game_closed', { roomId });
    io.to(`groupcall:${roomId}`).emit('call_game_closed', { roomId });
  });

  socket.on('call_game_leave', async ({ roomId }) => {
    const game = callGames.get(roomId);
    if (!game || !game.players.some(player => player.id === userId) || !await isInGameRoom(userId, roomId)) return;
    callGames.delete(roomId);
    io.to(`call:${roomId}`).emit('call_game_closed', { roomId, reason: 'A participant left the activity.' });
    io.to(`groupcall:${roomId}`).emit('call_game_closed', { roomId, reason: 'A participant left the activity.' });
  });

  socket.on('call_game_next_round', async ({ roomId }) => {
    const game = callGames.get(roomId);
    if (!game || game.hostId !== userId || game.phase !== 'round_complete' || !await isInGameRoom(userId, roomId)) return;
    game.roundNumber += 1;
    beginCallGameRound(game);
    emitGame(roomId);
  });

  socket.on('call_game_action', async ({ roomId, action }) => {
    const game = callGames.get(roomId);
    if (!game || game.phase !== 'playing' || !await isInGameRoom(userId, roomId)) return;
    const player = game.players.find(p => p.id === userId);
    if (!player) return;
    if (game.type === 'blackjack') {
      if (player.standing) return;
      if (action === 'hit') { player.hand.push(game.deck.pop()); if (blackjackScore(player.hand) >= 21) player.standing = true; }
      if (action === 'stand') player.standing = true;
      if (!['hit','stand'].includes(action)) return;
      if (game.players.every(p => p.standing || blackjackScore(p.hand) > 21)) {
        while (blackjackScore(game.dealer.hand) < 17) game.dealer.hand.push(game.deck.pop());
        const dealerScore = blackjackScore(game.dealer.hand);
        game.players.forEach(p => { const score = blackjackScore(p.hand); if (score <= 21 && (dealerScore > 21 || score > dealerScore)) p.chips += 100; else if (score > 21 || score < dealerScore) p.chips -= 50; });
        if (game.roundNumber >= game.roundsTotal) {
          game.phase = 'complete';
          game.message = dealerScore > 21 ? 'Match complete: dealer busts.' : 'Match complete.';
        } else {
          game.phase = 'round_complete';
          game.message = `Round ${game.roundNumber} complete. ${game.roundsTotal - game.roundNumber} round${game.roundsTotal - game.roundNumber === 1 ? '' : 's'} remaining.`;
        }
      }
    } else {
      if (game.turnId !== userId || !['check','call','fold'].includes(action)) return;
      if (action === 'fold') player.folded = true; else { player.bet += 20; player.chips -= 20; game.pot += 20; }
      const active = game.players.filter(p => !p.folded);
      const index = active.findIndex(p => p.id === userId);
      if (active.length === 1) { game.winnerId = active[0].id; active[0].chips += game.pot; game.phase = game.roundNumber >= game.roundsTotal ? 'complete' : 'round_complete'; game.message = game.phase === 'complete' ? 'Match complete: everyone else folded.' : `Round ${game.roundNumber} complete. Host can start the next round.`; }
      else if (index === active.length - 1) { game.community.push(game.deck.pop(), game.deck.pop()); const winner = active[Math.floor(Math.random() * active.length)]; winner.chips += game.pot; game.winnerId = winner.id; game.phase = game.roundNumber >= game.roundsTotal ? 'complete' : 'round_complete'; game.message = game.phase === 'complete' ? 'Match complete: showdown complete.' : `Round ${game.roundNumber} complete. Host can start the next round.`; }
      else game.turnId = active[index + 1].id;
    }
    emitGame(roomId);
  });

  socket.on('disconnect', async () => {
    const sockets = userSockets.get(userId);
    if (sockets) {
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        userSockets.delete(userId);
        await pool.query("UPDATE users SET status='offline' WHERE id=$1", [userId]);
        broadcastStatusChange(userId, 'offline');
        const roomId = await getUserCallRoom(userId);
        if (roomId) {
          const room = await getRoomParticipants(roomId);
          if (room && room.size) {
            for (const uid of room) {
              if (uid !== userId) {
                await clearUserCallRoom(uid);
                io.to(`user:${uid}`).emit('call_ended', { roomId });
              }
            }
            await clearRoomParticipants(roomId);
            callTypes.delete(roomId);
          }
          await clearUserCallRoom(userId);
        }

        const gRoomId = userGroupCallRoom.get(userId);
        if (gRoomId) {
          const gRoom = groupCallRooms.get(gRoomId);
          if (gRoom) {
            gRoom.delete(userId);
            io.to(`groupcall:${gRoomId}`).emit('group_call_user_left', { roomId: gRoomId, userId });
            if (!gRoom.size) groupCallRooms.delete(gRoomId);
          }
          userGroupCallRoom.delete(userId);
        }
      }
    }
  });
});

async function broadcastStatusChange(userId, status) {
  const friends = await pool.query(
    `SELECT CASE WHEN user1_id=$1 THEN user2_id ELSE user1_id END as fid
     FROM friendships WHERE user1_id=$1 OR user2_id=$1`,
    [userId]
  );
  friends.rows.forEach(({ fid }) => io.to(`user:${fid}`).emit('status_change', { userId, status }));
}

const PORT = process.env.PORT || 3000;

async function start() {
  const missing = [];
  if (!DATABASE_URL) missing.push('DATABASE_URL');
  if (REQUIRE_REDIS && !REDIS_URL) missing.push('REDIS_URL');
  if (missing.length) {
    console.error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
      'Configure these values in .env or your host secrets.'
    );
    process.exit(1);
  }

  await initDb();
  await setupRedisBackplane();
  server.listen(PORT, () => console.log(`Nexus running on port ${PORT}`));
}

start().catch(err => {
  console.error('Failed to initialize server:', err);
  process.exit(1);
});
