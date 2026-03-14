const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('./models/db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const SESSION_SECRET = process.env.SESSION_SECRET || 'nexus-super-secret-key-change-in-prod';

const sessionMiddleware = session({
  store: new SQLiteStore({ dir: DATA_DIR, db: 'sessions.db' }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, '../public')));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/friends', require('./routes/friends'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/users', require('./routes/users'));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Share session with socket.io
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

// Track online users: userId -> Set<socketId>
const userSockets = new Map();
// Track voice calls: roomId -> Set<userId>
const voiceRooms = new Map();
// Active calls: userId -> roomId
const userInCall = new Map();

io.use((socket, next) => {
  const sess = socket.request.session;
  if (!sess || !sess.userId) return next(new Error('Unauthorized'));
  socket.userId = sess.userId;
  next();
});

io.on('connection', (socket) => {
  const userId = socket.userId;

  // Track socket
  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId).add(socket.id);

  // Update status to online
  db.prepare("UPDATE users SET status='online' WHERE id=?").run(userId);
  broadcastStatusChange(userId, 'online');

  // Join personal room
  socket.join(`user:${userId}`);

  // ---- MESSAGING ----
  socket.on('send_message', ({ toId, content }) => {
    if (!toId || !content || typeof content !== 'string') return;
    const trimmed = content.trim().slice(0, 4000);
    if (!trimmed) return;

    // Verify friendship
    const isFriend = db.prepare(
      `SELECT id FROM friendships WHERE (user1_id=? AND user2_id=?) OR (user1_id=? AND user2_id=?)`
    ).get(userId, toId, toId, userId);
    if (!isFriend) return;

    const msgId = uuidv4();
    const now = Math.floor(Date.now() / 1000);
    db.prepare('INSERT INTO messages (id, from_id, to_id, content, created_at) VALUES (?,?,?,?,?)')
      .run(msgId, userId, toId, trimmed, now);

    const sender = db.prepare('SELECT username, display_name, avatar FROM users WHERE id=?').get(userId);

    const msg = {
      id: msgId,
      fromId: userId,
      toId,
      content: trimmed,
      createdAt: now,
      author: { username: sender.username, displayName: sender.display_name, avatar: sender.avatar }
    };

    // Send to recipient
    io.to(`user:${toId}`).emit('new_message', msg);
    // Echo to sender (other tabs)
    socket.to(`user:${userId}`).emit('new_message', msg);
    // Ack to this socket
    socket.emit('message_sent', msg);
  });

  socket.on('typing_start', ({ toId }) => {
    const user = db.prepare('SELECT username FROM users WHERE id=?').get(userId);
    io.to(`user:${toId}`).emit('user_typing', { fromId: userId, username: user?.username });
  });

  socket.on('typing_stop', ({ toId }) => {
    io.to(`user:${toId}`).emit('user_stop_typing', { fromId: userId });
  });

  // ---- VOICE CALLS ----
  socket.on('call_invite', ({ toId }) => {
    if (userInCall.has(toId)) {
      socket.emit('call_busy', { userId: toId });
      return;
    }
    const roomId = uuidv4();
    const caller = db.prepare('SELECT username, display_name, avatar FROM users WHERE id=?').get(userId);
    io.to(`user:${toId}`).emit('incoming_call', {
      roomId,
      fromId: userId,
      caller: { username: caller.username, displayName: caller.display_name, avatar: caller.avatar }
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

  // WebRTC signaling
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
      room.forEach(uid => {
        userInCall.delete(uid);
        io.to(`user:${uid}`).emit('call_ended', { roomId });
      });
      voiceRooms.delete(roomId);
    }
    socket.leave(`call:${roomId}`);
  });

  socket.on('call_cancel', ({ toId }) => {
    io.to(`user:${toId}`).emit('call_cancelled', { fromId: userId });
  });

  // ---- DISCONNECT ----
  socket.on('disconnect', () => {
    const sockets = userSockets.get(userId);
    if (sockets) {
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        userSockets.delete(userId);
        db.prepare("UPDATE users SET status='offline' WHERE id=?").run(userId);
        broadcastStatusChange(userId, 'offline');

        // End any active calls
        const roomId = userInCall.get(userId);
        if (roomId) {
          const room = voiceRooms.get(roomId);
          if (room) {
            room.forEach(uid => {
              if (uid !== userId) {
                userInCall.delete(uid);
                io.to(`user:${uid}`).emit('call_ended', { roomId });
              }
            });
            voiceRooms.delete(roomId);
          }
          userInCall.delete(userId);
        }
      }
    }
  });
});

function broadcastStatusChange(userId, status) {
  // Notify all friends
  const friends = db.prepare(
    `SELECT CASE WHEN user1_id=? THEN user2_id ELSE user1_id END as fid
     FROM friendships WHERE user1_id=? OR user2_id=?`
  ).all(userId, userId, userId);

  friends.forEach(({ fid }) => {
    io.to(`user:${fid}`).emit('status_change', { userId, status });
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Nexus running on port ${PORT}`));
