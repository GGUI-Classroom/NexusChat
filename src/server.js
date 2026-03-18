const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { pool, initDb } = require('./models/db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });

const isProd = process.env.NODE_ENV === 'production';
const SESSION_SECRET = process.env.SESSION_SECRET || 'nexus-dev-secret-change-in-prod';

// Trust Render's proxy so secure cookies work over HTTPS
if (isProd) app.set('trust proxy', 1);

const sessionMiddleware = session({
  store: new pgSession({ pool, createTableIfMissing: true }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'nexus.sid',
  cookie: {
    secure: isProd,       // true on Render (HTTPS), false locally
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
});

app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);
app.use((req, res, next) => { req.io = io; req.userSockets = userSockets; next(); });
app.use(express.static(path.join(__dirname, '../public')));

// Expose io so routes can emit socket events
app.set('io', io);

app.use('/api/auth', require('./routes/auth'));
app.use('/api/friends', require('./routes/friends'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/users', require('./routes/users'));
app.use('/api/servers', require('./routes/servers'));
app.use('/api/shop', require('./routes/shop'));
app.use('/api/achievements', require('./routes/achievements'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/colors', require('./routes/colors'));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

const userSockets = new Map();
const voiceRooms = new Map();
const userInCall = new Map();

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
      `SELECT u.username, u.display_name, u.avatar_data, u.avatar_mime, u.active_decoration, u.active_color,
        (SELECT id FROM friendships WHERE (user1_id=$1 AND user2_id=$2) OR (user1_id=$2 AND user2_id=$1) LIMIT 1) as friend_id
       FROM users u WHERE u.id=$1`,
      [userId, toId]
    );
    if (!check.rows.length || !check.rows[0].friend_id) return;
    const s = check.rows[0];
    const msgId = uuidv4();
    const now = Math.floor(Date.now() / 1000);
    // Build message object immediately — emit to sender first for instant feedback
    const msg = {
      id: msgId, fromId: userId, toId, content: trimmed, createdAt: now,
      author: {
        username: s.username, displayName: s.display_name,
        avatarDataUrl: s.avatar_data ? `data:${s.avatar_mime};base64,${s.avatar_data}` : null,
        activeDecoration: s.active_decoration || null,
        activeColor: s.active_color || null
      }
    };
    // Emit to sender immediately (no await before this)
    socket.emit('new_message', msg);
    // Emit to recipient
    io.to(`user:${toId}`).emit('new_message', msg);
    // Emit to sender's other tabs
    socket.to(`user:${userId}`).emit('new_message', msg);
    // Persist to DB (non-blocking for perceived speed)
    pool.query('INSERT INTO messages (id, from_id, to_id, content, created_at) VALUES ($1,$2,$3,$4,$5)',
      [msgId, userId, toId, trimmed, now]).catch(e => console.error('DM insert error:', e));

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

  socket.on('send_channel_message', async ({ serverId, channelId, content }) => {
    if (!content || typeof content !== 'string') return;
    const trimmed = content.trim().slice(0, 4000);
    if (!trimmed) return;

    // Single query: get member info, role info, channel validity, and permission check
    const check = await pool.query(
      `SELECT sm.role_id, sm.role AS member_role, sr.name as role_name, sr.color as role_color,
        sr.is_admin,
        u.username, u.display_name, u.avatar_data, u.avatar_mime, u.active_decoration,
        ch.id as ch_id, ch.locked, ch.private as ch_private,
        (SELECT allow_send FROM channel_permissions cp
         WHERE cp.channel_id=$2 AND (cp.role_id=sm.role_id OR cp.role_id IS NULL)
         ORDER BY cp.role_id NULLS LAST LIMIT 1) as perm_allow
       FROM server_members sm
       JOIN users u ON u.id=sm.user_id
       JOIN channels ch ON ch.id=$2 AND ch.server_id=$1
       LEFT JOIN server_roles sr ON sr.id=sm.role_id
       WHERE sm.server_id=$1 AND sm.user_id=$3`,
      [serverId, channelId, userId]
    );
    if (!check.rows.length) return; // not a member or channel doesn't belong to server
    const row = check.rows[0];

    // Check private channel visibility
    if (row.ch_private && !row.is_admin && row.member_role !== 'admin') {
      const viewPerm = await pool.query(
        `SELECT allow_view FROM channel_permissions WHERE channel_id=$1 AND role_id=$2`,
        [channelId, row.role_id]
      );
      if (!viewPerm.rows.length || !viewPerm.rows[0].allow_view) {
        socket.emit('channel_error', { channelId, error: 'You cannot access this channel' });
        return;
      }
    }
    // Check channel lock: if locked, only admins/roles with explicit allow_send=true can post
    if (row.locked && !row.is_admin && row.member_role !== 'admin') {
      const perm = await pool.query(
        `SELECT allow_send FROM channel_permissions WHERE channel_id=$1 AND role_id=$2`,
        [channelId, row.role_id]
      );
      if (!perm.rows.length || !perm.rows[0].allow_send) {
        socket.emit('channel_error', { channelId, error: 'You do not have permission to send messages in this channel' });
        return;
      }
    }

    const msgId = uuidv4();
    const now = Math.floor(Date.now() / 1000);
    const msg = {
      id: msgId, channelId, serverId, fromId: userId,
      content: trimmed, createdAt: now,
      author: {
        username: row.username, displayName: row.display_name,
        avatarDataUrl: row.avatar_data ? `data:${row.avatar_mime};base64,${row.avatar_data}` : null,
        roleColor: row.role_color || null, roleName: row.role_name || null,
        activeDecoration: row.active_decoration || null,
        activeColor: row.active_color || null
      }
    };
    // Resolve mentions for notification
    const userMentionMatches = [...trimmed.matchAll(/<@user:([a-f0-9-]+)>/g)];
    const roleMentionMatches = [...trimmed.matchAll(/<@role:([a-f0-9-]+)>/g)];

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

    // Emit to sender immediately, then rest of server room
    socket.emit('new_channel_message', msg);
    socket.to(`server:${serverId}`).emit('new_channel_message', msg);
    // Persist non-blocking
    pool.query(
      'INSERT INTO channel_messages (id, channel_id, from_id, content, created_at) VALUES ($1,$2,$3,$4,$5)',
      [msgId, channelId, userId, trimmed, now]
    ).catch(e => console.error('Channel msg insert error:', e));

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

  // Admin: force-suspend an active user
  socket.on('admin_suspend_user', async ({ targetUserId, suspendedUntil }) => {
    // Verify the requesting socket is an admin
    const { ADMIN_IDS } = require('./routes/admin');
    if (!ADMIN_IDS.has(userId)) return;
    // Emit suspended event to all of that user's sockets
    io.to(`user:${targetUserId}`).emit('account_suspended', { suspendedUntil });
  });

  socket.on('call_invite', async ({ toId }) => {
    if (userInCall.has(toId)) { socket.emit('call_busy', { userId: toId }); return; }
    const roomId = uuidv4();
    const caller = await pool.query('SELECT username, display_name, avatar_data, avatar_mime FROM users WHERE id=$1', [userId]);
    const c = caller.rows[0];
    io.to(`user:${toId}`).emit('incoming_call', {
      roomId, fromId: userId,
      caller: {
        username: c.username, displayName: c.display_name,
        avatarDataUrl: c.avatar_data ? `data:${c.avatar_mime};base64,${c.avatar_data}` : null
      }
    });
    socket.emit('call_ringing', { roomId, toId });
  });

  socket.on('call_accept', ({ roomId, toId }) => {
    voiceRooms.set(roomId, new Set([userId, toId]));
    userInCall.set(userId, roomId);
    userInCall.set(toId, roomId);
    socket.join(`call:${roomId}`);
    io.to(`user:${toId}`).emit('call_accepted', { roomId, byId: userId });
    socket.emit('call_joined', { roomId });
  });

  socket.on('call_decline', ({ roomId, toId }) => {
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

  socket.on('call_end', ({ roomId }) => {
    const room = voiceRooms.get(roomId);
    if (room) {
      room.forEach(uid => { userInCall.delete(uid); io.to(`user:${uid}`).emit('call_ended', { roomId }); });
      voiceRooms.delete(roomId);
    }
    socket.leave(`call:${roomId}`);
  });

  socket.on('call_cancel', ({ toId }) => {
    io.to(`user:${toId}`).emit('call_cancelled', { fromId: userId });
  });

  socket.on('screenshare_started', ({ roomId, toId }) => {
    io.to(`user:${toId}`).emit('screenshare_started', { fromId: userId });
  });

  socket.on('screenshare_stopped', ({ roomId, toId }) => {
    io.to(`user:${toId}`).emit('screenshare_stopped', { fromId: userId });
  });

  socket.on('disconnect', async () => {
    const sockets = userSockets.get(userId);
    if (sockets) {
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        userSockets.delete(userId);
        await pool.query("UPDATE users SET status='offline' WHERE id=$1", [userId]);
        broadcastStatusChange(userId, 'offline');
        const roomId = userInCall.get(userId);
        if (roomId) {
          const room = voiceRooms.get(roomId);
          if (room) {
            room.forEach(uid => { if (uid !== userId) { userInCall.delete(uid); io.to(`user:${uid}`).emit('call_ended', { roomId }); } });
            voiceRooms.delete(roomId);
          }
          userInCall.delete(userId);
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

initDb().then(() => {
  server.listen(PORT, () => console.log(`Nexus running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
