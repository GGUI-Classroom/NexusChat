const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function runSql(sql, label) {
  try { await pool.query(sql); }
  catch(e) { console.error(`Migration failed [${label}]:`, e.message); }
}

async function initDb() {
  await runSql(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
    avatar_data TEXT DEFAULT NULL, avatar_mime TEXT DEFAULT NULL,
    status TEXT DEFAULT 'offline',
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
  )`, 'users');

  await runSql(`CREATE TABLE IF NOT EXISTS friend_requests (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL REFERENCES users(id),
    to_id TEXT NOT NULL REFERENCES users(id),
    status TEXT DEFAULT 'pending',
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    UNIQUE(from_id, to_id)
  )`, 'friend_requests');

  await runSql(`CREATE TABLE IF NOT EXISTS friendships (
    id TEXT PRIMARY KEY,
    user1_id TEXT NOT NULL REFERENCES users(id),
    user2_id TEXT NOT NULL REFERENCES users(id),
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
  )`, 'friendships');

  await runSql(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL REFERENCES users(id),
    to_id TEXT NOT NULL REFERENCES users(id),
    content TEXT NOT NULL,
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
  )`, 'messages');

  await runSql(`CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id),
    icon_data TEXT DEFAULT NULL, icon_mime TEXT DEFAULT NULL,
    invite_code TEXT UNIQUE NOT NULL,
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
  )`, 'servers');

  await runSql(`CREATE TABLE IF NOT EXISTS server_roles (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL, color TEXT DEFAULT '#8892a4',
    is_admin BOOLEAN DEFAULT FALSE, position INTEGER DEFAULT 0,
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
  )`, 'server_roles');

  await runSql(`CREATE TABLE IF NOT EXISTS server_members (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT DEFAULT 'member',
    role_id TEXT DEFAULT NULL REFERENCES server_roles(id) ON DELETE SET NULL,
    joined_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    UNIQUE(server_id, user_id)
  )`, 'server_members');

  await runSql(`CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL, position INTEGER DEFAULT 0,
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
  )`, 'channels');

  await runSql(`CREATE TABLE IF NOT EXISTS channel_messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    from_id TEXT NOT NULL REFERENCES users(id),
    content TEXT NOT NULL,
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
  )`, 'channel_messages');

  await runSql(`CREATE TABLE IF NOT EXISTS server_invites (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    from_id TEXT NOT NULL REFERENCES users(id),
    to_id TEXT NOT NULL REFERENCES users(id),
    status TEXT DEFAULT 'pending',
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    UNIQUE(server_id, to_id)
  )`, 'server_invites');

  await runSql(`CREATE TABLE IF NOT EXISTS server_bans (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    banned_by TEXT NOT NULL REFERENCES users(id),
    reason TEXT DEFAULT NULL,
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    UNIQUE(server_id, user_id)
  )`, 'server_bans');

  // Indexes
  await runSql(`CREATE INDEX IF NOT EXISTS idx_messages_convo ON messages(from_id, to_id, created_at)`, 'idx1');
  await runSql(`CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests(to_id, status)`, 'idx2');
  await runSql(`CREATE INDEX IF NOT EXISTS idx_username_lower ON users(LOWER(username))`, 'idx3');
  await runSql(`CREATE INDEX IF NOT EXISTS idx_channel_messages ON channel_messages(channel_id, created_at)`, 'idx4');
  await runSql(`CREATE INDEX IF NOT EXISTS idx_server_members ON server_members(user_id)`, 'idx5');
  await runSql(`CREATE INDEX IF NOT EXISTS idx_server_invites_to ON server_invites(to_id, status)`, 'idx6');

  // Add role_id column to server_members if it doesn't exist (for existing deployments)
  await runSql(`ALTER TABLE server_members ADD COLUMN IF NOT EXISTS role_id TEXT DEFAULT NULL`, 'alter_members_role_id');
  await runSql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT NULL`, 'alter_users_bio');

  // Channel permissions
  await runSql(`CREATE TABLE IF NOT EXISTS channel_permissions (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    role_id TEXT REFERENCES server_roles(id) ON DELETE CASCADE,
    allow_send BOOLEAN DEFAULT TRUE,
    UNIQUE(channel_id, role_id)
  )`, 'channel_permissions');

  await runSql(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS locked BOOLEAN DEFAULT FALSE`, 'alter_channels_locked');
  await runSql(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS private BOOLEAN DEFAULT FALSE`, 'alter_channels_private');
  await runSql(`ALTER TABLE channel_permissions ADD COLUMN IF NOT EXISTS allow_view BOOLEAN DEFAULT TRUE`, 'alter_cp_allow_view');
  await runSql(`ALTER TABLE server_roles ADD COLUMN IF NOT EXISTS can_delete_messages BOOLEAN DEFAULT FALSE`, 'alter_roles_delete');

  await runSql(`CREATE TABLE IF NOT EXISTS user_decorations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    decoration_id TEXT NOT NULL,
    unlocked_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    UNIQUE(user_id, decoration_id)
  )`, 'user_decorations');

  await runSql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS active_decoration TEXT DEFAULT NULL`, 'alter_users_decoration');
  await runSql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS nexals INTEGER DEFAULT 0`, 'alter_users_nexals');
  await runSql(`CREATE TABLE IF NOT EXISTS suspensions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    suspended_by TEXT NOT NULL REFERENCES users(id),
    reason TEXT DEFAULT NULL,
    suspended_until BIGINT NOT NULL,
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    active BOOLEAN DEFAULT TRUE
  )`, 'suspensions');

  await runSql(`CREATE TABLE IF NOT EXISTS code_redemptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    redeemed_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    UNIQUE(user_id, code)
  )`, 'code_redemptions');

  await runSql(`CREATE TABLE IF NOT EXISTS user_achievements (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    achievement_id TEXT NOT NULL,
    progress INTEGER DEFAULT 0,
    completed_at BIGINT DEFAULT NULL,
    claimed_at BIGINT DEFAULT NULL,
    UNIQUE(user_id, achievement_id)
  )`, 'user_achievements');

  console.log('Database initialized');
}

module.exports = { pool, initDb };
