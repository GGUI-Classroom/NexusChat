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
  await runSql(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS channel_type TEXT DEFAULT 'text'`, 'alter_channels_channel_type');
  await runSql(`UPDATE channels SET channel_type='text' WHERE channel_type IS NULL OR channel_type NOT IN ('text','voice')`, 'normalize_channels_channel_type');
  await runSql(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS topic TEXT DEFAULT NULL`, 'alter_channels_topic');
  await runSql(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS slowmode_seconds INTEGER DEFAULT 0`, 'alter_channels_slowmode');
  await runSql(`ALTER TABLE channel_messages ADD COLUMN IF NOT EXISTS reply_to_id TEXT DEFAULT NULL`, 'alter_channel_messages_reply_to');
  await runSql(`DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'channel_messages_reply_to_fk'
    ) THEN
      ALTER TABLE channel_messages
      ADD CONSTRAINT channel_messages_reply_to_fk
      FOREIGN KEY (reply_to_id) REFERENCES channel_messages(id) ON DELETE SET NULL;
    END IF;
  END $$;`, 'channel_messages_reply_to_fk');
  await runSql(`CREATE TABLE IF NOT EXISTS channel_pins (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE,
    pinned_by TEXT NOT NULL REFERENCES users(id),
    pinned_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    UNIQUE(channel_id, message_id)
  )`, 'channel_pins');
  await runSql(`CREATE TABLE IF NOT EXISTS channel_message_reactions (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    UNIQUE(message_id, user_id, emoji)
  )`, 'channel_message_reactions');
  await runSql(`CREATE INDEX IF NOT EXISTS idx_channel_messages_reply_to ON channel_messages(reply_to_id)`, 'idx_channel_messages_reply_to');
  await runSql(`CREATE INDEX IF NOT EXISTS idx_channel_pins_channel_time ON channel_pins(channel_id, pinned_at DESC)`, 'idx_channel_pins_channel_time');
  await runSql(`CREATE INDEX IF NOT EXISTS idx_channel_reactions_message ON channel_message_reactions(message_id)`, 'idx_channel_reactions_message');
  await runSql(`CREATE INDEX IF NOT EXISTS idx_channel_reactions_user ON channel_message_reactions(user_id)`, 'idx_channel_reactions_user');
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
  await runSql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS active_color TEXT DEFAULT NULL`, 'alter_users_color');
  await runSql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS active_font TEXT DEFAULT NULL`, 'alter_users_font');
  await runSql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS active_ringtone TEXT DEFAULT NULL`, 'alter_users_ringtone');
  await runSql(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS mod_log_channel_id TEXT DEFAULT NULL`, 'alter_servers_mod_log_channel');
  await runSql(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS bot_name TEXT DEFAULT 'NexusBot'`, 'alter_servers_bot_name');
  await runSql(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS bot_prefix TEXT DEFAULT '/'`, 'alter_servers_bot_prefix');
  await runSql(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS bot_enabled BOOLEAN DEFAULT TRUE`, 'alter_servers_bot_enabled');
  await runSql(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS bot_auto_mod BOOLEAN DEFAULT TRUE`, 'alter_servers_bot_automod');
  await runSql(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS bot_block_links BOOLEAN DEFAULT FALSE`, 'alter_servers_bot_block_links');
  await runSql(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS bot_caps_threshold INTEGER DEFAULT 90`, 'alter_servers_bot_caps_threshold');
  await runSql(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS bot_spam_window INTEGER DEFAULT 6`, 'alter_servers_bot_spam_window');
  await runSql(`CREATE TABLE IF NOT EXISTS user_fonts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    font_id TEXT NOT NULL,
    unlocked_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    UNIQUE(user_id, font_id)
  )`, 'user_fonts');
  await runSql(`CREATE TABLE IF NOT EXISTS user_colors (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    color_id TEXT NOT NULL,
    unlocked_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    UNIQUE(user_id, color_id)
  )`, 'user_colors');
  await runSql(`CREATE TABLE IF NOT EXISTS user_ringtones (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ringtone_id TEXT NOT NULL,
    unlocked_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    UNIQUE(user_id, ringtone_id)
  )`, 'user_ringtones');
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

  await runSql(`CREATE TABLE IF NOT EXISTS server_mutes (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    muted_by TEXT NOT NULL REFERENCES users(id),
    reason TEXT DEFAULT NULL,
    muted_until BIGINT NOT NULL,
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    UNIQUE(server_id, user_id)
  )`, 'server_mutes');

  await runSql(`CREATE TABLE IF NOT EXISTS moderation_logs (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    channel_id TEXT DEFAULT NULL REFERENCES channels(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    actor_user_id TEXT NOT NULL REFERENCES users(id),
    target_user_id TEXT DEFAULT NULL REFERENCES users(id),
    details TEXT DEFAULT NULL,
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
  )`, 'moderation_logs');

  await runSql(`CREATE INDEX IF NOT EXISTS idx_server_mutes_lookup ON server_mutes(server_id, user_id, muted_until)`, 'idx_server_mutes_lookup');
  await runSql(`CREATE INDEX IF NOT EXISTS idx_moderation_logs_server_time ON moderation_logs(server_id, created_at DESC)`, 'idx_moderation_logs_server_time');

  await runSql(`CREATE TABLE IF NOT EXISTS server_blocked_words (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    word TEXT NOT NULL,
    created_by TEXT DEFAULT NULL REFERENCES users(id),
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    UNIQUE(server_id, word)
  )`, 'server_blocked_words');
  await runSql(`CREATE INDEX IF NOT EXISTS idx_server_blocked_words_server ON server_blocked_words(server_id)`, 'idx_server_blocked_words_server');

  await runSql(`
    INSERT INTO users (id, username, display_name, password_hash, status, active_color)
    VALUES ('00000000-0000-0000-0000-000000000001', 'nexusbot', 'NexusBot', 'nexusbot-local-only', 'online', '#f4b942')
    ON CONFLICT (id) DO NOTHING
  `, 'seed_nexusbot_user');
  await runSql(`
    UPDATE users
    SET username='nexusguard',
        display_name='NexusGuard',
        status='online',
        active_color='#f4b942',
        avatar_mime='image/svg+xml',
        avatar_data='PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5NiA5NiI+PGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSJnIiB4MT0iMCIgeTE9IjAiIHgyPSIxIiB5Mj0iMSI+PHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjMGYxNzJhIi8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjMWUyOTNiIi8+PC9saW5lYXJHcmFkaWVudD48bGluZWFyR3JhZGllbnQgaWQ9ImEiIHgxPSIwIiB5MT0iMCIgeDI9IjEiIHkyPSIxIj48c3RvcCBvZmZzZXQ9IjAiIHN0b3AtY29sb3I9IiNmNTllMGIiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiNmOTczMTYiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz48Y2lyY2xlIGN4PSI0OCIgY3k9IjQ4IiByPSI0NiIgZmlsbD0idXJsKCNnKSIvPjxwYXRoIGQ9Ik00OCAxNmwyNCA4djIyYzAgMTgtMTAgMzAtMjQgMzYtMTQtNi0yNC0xOC0yNC0zNlYyNHoiIGZpbGw9InVybCgjYSkiLz48cGF0aCBkPSJNNDggMjZsMTQgNXYxNWMwIDExLTYgMTktMTQgMjMtOC00LTE0LTEyLTE0LTIzVjMxeiIgZmlsbD0iIzExMTgyNyIgb3BhY2l0eT0iLjY1Ii8+PGNpcmNsZSBjeD0iNDgiIGN5PSI0NSIgcj0iNyIgZmlsbD0iI2ZkZTY4YSIvPjxwYXRoIGQ9Ik0zNiA1OWgyNHY1SDM2eiIgZmlsbD0iI2ZkZTY4YSIvPjwvc3ZnPg=='
    WHERE id='00000000-0000-0000-0000-000000000001'
  `, 'normalize_nexusguard_user');

  await runSql(`
    DELETE FROM friend_requests
    WHERE from_id='00000000-0000-0000-0000-000000000001'
       OR to_id='00000000-0000-0000-0000-000000000001'
  `, 'cleanup_nexusguard_friend_requests');

  await runSql(`
    DELETE FROM friendships
    WHERE user1_id='00000000-0000-0000-0000-000000000001'
       OR user2_id='00000000-0000-0000-0000-000000000001'
  `, 'cleanup_nexusguard_friendships');

  console.log('Database initialized');
}

module.exports = { pool, initDb };
