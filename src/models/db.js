const { Pool } = require('pg');
const { envFlag } = require('../config/env');

const databaseSsl = process.env.DATABASE_SSL === undefined
  ? process.env.NODE_ENV === 'production'
  : envFlag('DATABASE_SSL', false);
const rejectUnauthorized = envFlag('DATABASE_SSL_REJECT_UNAUTHORIZED', false);
const poolMax = Math.max(1, parseInt(process.env.DB_POOL_MAX, 10) || 10);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: databaseSsl ? { rejectUnauthorized } : false,
  max: poolMax
});

async function runSql(sql, label) {
  try { await pool.query(sql); }
  catch(e) { console.error(`Migration failed [${label}]:`, e.message); }
}

async function runOnceMigration(id, sql, label = id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const applied = await client.query('SELECT 1 FROM app_migrations WHERE id=$1 FOR UPDATE', [id]);
    if (applied.rows.length) {
      await client.query('COMMIT');
      return;
    }
    await client.query(sql);
    await client.query(
      `INSERT INTO app_migrations (id, applied_at)
       VALUES ($1, EXTRACT(EPOCH FROM NOW())::BIGINT)`,
      [id]
    );
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error(`Migration failed [${label}]:`, e.message);
  } finally {
    client.release();
  }
}

async function initDb() {
  await runSql(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
    avatar_data TEXT DEFAULT NULL, avatar_mime TEXT DEFAULT NULL,
    status TEXT DEFAULT 'offline',
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
  )`, 'users');
  await runSql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS accepted_tos_version INTEGER NOT NULL DEFAULT 0`, 'alter_users_accepted_tos_version');
  await runSql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS accepted_tos_at BIGINT DEFAULT NULL`, 'alter_users_accepted_tos_at');
  await runSql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS developer_mode BOOLEAN DEFAULT FALSE`, 'alter_users_developer_mode');

  await runSql(`CREATE TABLE IF NOT EXISTS terms_of_service (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 1,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    updated_by TEXT DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    updated_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
  )`, 'terms_of_service');
  await runSql(`
    INSERT INTO terms_of_service (id, version, title, content)
    VALUES (
      'current',
      1,
      'Nexus Terms of Service',
      'By using Nexus, you agree to use the service lawfully and respectfully.

1. Accounts: Keep your account secure and provide accurate registration information. You are responsible for activity performed through your account.

2. Safety: Discriminatory harassment, threats, sexual exploitation, child sexual abuse material, grooming, and attempts to evade safety systems are prohibited.

3. Content: You are responsible for content you send or upload. Nexus may block, remove, preserve, or review content when necessary for safety, moderation, legal compliance, or operation of the service.

4. Communities: Server owners and moderators may establish additional rules, but those rules cannot override Nexus-wide safety requirements.

5. Virtual Items: Nexals, decorations, boosts, and other virtual items have no cash value unless Nexus explicitly states otherwise. Features and balances may be adjusted to protect the service.

6. Enforcement: Nexus may warn, restrict, suspend, or terminate accounts that violate these terms or create risk for users or the service.

7. Availability: Nexus may change, interrupt, or discontinue features. The service is provided as available without a guarantee of uninterrupted operation.

8. Updates: These terms may be updated. When a new version is published, you must review and accept it before continuing to use Nexus.'
    )
    ON CONFLICT (id) DO NOTHING
  `, 'seed_terms_of_service');
  await runSql(`CREATE TABLE IF NOT EXISTS tos_acceptances (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    accepted_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    UNIQUE(user_id, version)
  )`, 'tos_acceptances');
  await runSql(`CREATE INDEX IF NOT EXISTS idx_tos_acceptances_user ON tos_acceptances(user_id, version DESC)`, 'idx_tos_acceptances_user');

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
  await runSql(`CREATE TABLE IF NOT EXISTS server_member_roles (
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id TEXT NOT NULL REFERENCES server_roles(id) ON DELETE CASCADE,
    assigned_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    PRIMARY KEY(server_id, user_id, role_id)
  )`, 'server_member_roles');

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
  await runSql(`UPDATE channels SET channel_type='text' WHERE channel_type IS NULL OR channel_type NOT IN ('text','voice','forum')`, 'normalize_channels_channel_type');
  await runSql(`CREATE TABLE IF NOT EXISTS forum_posts (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    updated_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
  )`, 'forum_posts');
  await runSql(`CREATE TABLE IF NOT EXISTS forum_replies (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL REFERENCES forum_posts(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
  )`, 'forum_replies');
  await runSql(`CREATE INDEX IF NOT EXISTS idx_forum_posts_channel ON forum_posts(channel_id, updated_at DESC)`, 'idx_forum_posts_channel');
  await runSql(`CREATE INDEX IF NOT EXISTS idx_forum_replies_post ON forum_replies(post_id, created_at ASC)`, 'idx_forum_replies_post');
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
  // Pack drops are inventory entries, so a user may hold duplicate decorations.
  await runSql(`ALTER TABLE user_decorations DROP CONSTRAINT IF EXISTS user_decorations_user_id_decoration_id_key`, 'drop_deco_unique');
  await runSql(`CREATE INDEX IF NOT EXISTS idx_user_decorations_user_deco ON user_decorations(user_id, decoration_id)`, 'idx_user_decorations_user_deco');
  await runSql(`CREATE TABLE IF NOT EXISTS user_nameplates (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nameplate_id TEXT NOT NULL,
    unlocked_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
  )`, 'user_nameplates');
  await runSql(`CREATE INDEX IF NOT EXISTS idx_user_nameplates_user_plate ON user_nameplates(user_id, nameplate_id)`, 'idx_user_nameplates_user_plate');
  await runSql(`CREATE TABLE IF NOT EXISTS decoration_auctions (
    id TEXT PRIMARY KEY,
    seller_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    decoration_row_id TEXT NOT NULL REFERENCES user_decorations(id) ON DELETE CASCADE,
    decoration_id TEXT NOT NULL,
    price INTEGER NOT NULL CHECK (price > 0),
    status TEXT NOT NULL DEFAULT 'active',
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    sold_at BIGINT DEFAULT NULL,
    buyer_id TEXT DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL
  )`, 'decoration_auctions');
  await runSql(`CREATE INDEX IF NOT EXISTS idx_decoration_auctions_active ON decoration_auctions(status, created_at DESC)`, 'idx_decoration_auctions_active');
  await runSql(`CREATE UNIQUE INDEX IF NOT EXISTS idx_decoration_auction_one_active_row ON decoration_auctions(decoration_row_id) WHERE status='active'`, 'idx_decoration_auction_one_active_row');
  await runSql(`CREATE TABLE IF NOT EXISTS user_gifts (
    id TEXT PRIMARY KEY,
    from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    gift_type TEXT NOT NULL,
    nexal_amount INTEGER DEFAULT NULL,
    decoration_id TEXT DEFAULT NULL,
    decoration_row_id TEXT DEFAULT NULL REFERENCES user_decorations(id) ON DELETE SET NULL,
    claimed BOOLEAN DEFAULT FALSE,
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    claimed_at BIGINT DEFAULT NULL
  )`, 'user_gifts');
  await runSql(`CREATE INDEX IF NOT EXISTS idx_user_gifts_to_claimed ON user_gifts(to_user_id, claimed, created_at DESC)`, 'idx_user_gifts_to_claimed');
  await runSql(`CREATE TABLE IF NOT EXISTS user_pack_stats (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    openings INTEGER NOT NULL DEFAULT 0
  )`, 'user_pack_stats');
  await runSql(`CREATE TABLE IF NOT EXISTS app_migrations (
    id TEXT PRIMARY KEY,
    applied_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
  )`, 'app_migrations');
  await runOnceMigration(
    'seed_server_member_roles_v1',
    `INSERT INTO server_member_roles (server_id, user_id, role_id)
     SELECT server_id, user_id, role_id FROM server_members WHERE role_id IS NOT NULL
     ON CONFLICT DO NOTHING`,
    'seed_server_member_roles'
  );
  await runOnceMigration(
    'reserve_mod_server_tag_v1',
    `UPDATE servers SET server_tag=NULL
     WHERE UPPER(COALESCE(server_tag,''))='MOD' AND invite_code<>'02UAG7CR'`,
    'reserve_mod_server_tag'
  );

  await runSql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS active_decoration TEXT DEFAULT NULL`, 'alter_users_decoration');
  await runSql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS active_nameplate TEXT DEFAULT NULL`, 'alter_users_nameplate');
  await runOnceMigration('remove_existing_singularity_decorations_v1', `
    UPDATE users SET active_decoration=NULL WHERE active_decoration='singularity';
    DELETE FROM user_decorations WHERE decoration_id='singularity';
  `, 'remove_existing_singularity_decorations');
  await runOnceMigration('remove_existing_apex_storm_decorations_v1', `
    UPDATE users SET active_decoration=NULL WHERE active_decoration='apex_storm';
    DELETE FROM user_decorations WHERE decoration_id='apex_storm';
  `, 'remove_existing_apex_storm_decorations');
  await runSql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS active_color TEXT DEFAULT NULL`, 'alter_users_color');
  await runSql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS active_font TEXT DEFAULT NULL`, 'alter_users_font');
  await runSql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS pro_expires_at BIGINT DEFAULT 0`, 'alter_users_pro_expires');
  await runSql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_card_style TEXT DEFAULT NULL`, 'alter_users_profile_card_style');
  await runSql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_gradient_start TEXT DEFAULT '#5865f2'`, 'alter_users_profile_gradient_start');
  await runSql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_gradient_end TEXT DEFAULT '#a855f7'`, 'alter_users_profile_gradient_end');
  await runSql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_name_effect TEXT DEFAULT NULL`, 'alter_users_profile_name_effect');
  await runSql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_effect TEXT DEFAULT 'none'`, 'alter_users_profile_effect');
  await runSql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_banner_data TEXT DEFAULT NULL`, 'alter_users_profile_banner_data');
  await runSql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_banner_mime TEXT DEFAULT NULL`, 'alter_users_profile_banner_mime');
  await runSql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS active_server_tag_id TEXT DEFAULT NULL`, 'alter_users_active_server_tag');
  await runSql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS active_ringtone TEXT DEFAULT NULL`, 'alter_users_ringtone');
  await runSql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_status TEXT DEFAULT 'offline'`, 'alter_users_discord_status');
  await runSql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_activity TEXT DEFAULT NULL`, 'alter_users_discord_activity');
  await runSql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_ip TEXT DEFAULT NULL`, 'alter_users_last_ip');
  await runSql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_device_id TEXT DEFAULT NULL`, 'alter_users_last_device_id');
  await runSql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tutorial_completed BOOLEAN DEFAULT TRUE`, 'alter_users_tutorial_completed');
  await runSql(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS mod_log_channel_id TEXT DEFAULT NULL`, 'alter_servers_mod_log_channel');
  await runSql(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS bot_name TEXT DEFAULT 'NexusBot'`, 'alter_servers_bot_name');
  await runSql(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS bot_prefix TEXT DEFAULT '/'`, 'alter_servers_bot_prefix');
  await runSql(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS bot_enabled BOOLEAN DEFAULT TRUE`, 'alter_servers_bot_enabled');
  await runSql(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS bot_auto_mod BOOLEAN DEFAULT TRUE`, 'alter_servers_bot_automod');
  await runSql(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS bot_block_links BOOLEAN DEFAULT FALSE`, 'alter_servers_bot_block_links');
  await runSql(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS bot_caps_threshold INTEGER DEFAULT 90`, 'alter_servers_bot_caps_threshold');
  await runSql(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS server_tag TEXT DEFAULT NULL`, 'alter_servers_server_tag');
  await runSql(`ALTER TABLE server_roles ADD COLUMN IF NOT EXISTS gradient_start TEXT DEFAULT NULL`, 'alter_roles_gradient_start');
  await runSql(`ALTER TABLE server_roles ADD COLUMN IF NOT EXISTS gradient_end TEXT DEFAULT NULL`, 'alter_roles_gradient_end');
  await runSql(`ALTER TABLE server_roles ADD COLUMN IF NOT EXISTS gradient_animated BOOLEAN DEFAULT FALSE`, 'alter_roles_gradient_animated');
  await runSql(`ALTER TABLE server_roles ADD COLUMN IF NOT EXISTS display_separately BOOLEAN DEFAULT FALSE`, 'alter_roles_display_separately');
  await runSql(`ALTER TABLE server_roles ADD COLUMN IF NOT EXISTS can_manage_channels BOOLEAN DEFAULT FALSE`, 'alter_roles_manage_channels');
  await runSql(`ALTER TABLE server_roles ADD COLUMN IF NOT EXISTS can_manage_roles BOOLEAN DEFAULT FALSE`, 'alter_roles_manage_roles');
  await runSql(`ALTER TABLE server_roles ADD COLUMN IF NOT EXISTS can_kick_members BOOLEAN DEFAULT FALSE`, 'alter_roles_kick_members');
  await runSql(`ALTER TABLE server_roles ADD COLUMN IF NOT EXISTS can_ban_members BOOLEAN DEFAULT FALSE`, 'alter_roles_ban_members');
  await runSql(`ALTER TABLE server_roles ADD COLUMN IF NOT EXISTS can_manage_messages BOOLEAN DEFAULT FALSE`, 'alter_roles_manage_messages');
  await runSql(`ALTER TABLE server_roles ADD COLUMN IF NOT EXISTS can_mention_everyone BOOLEAN DEFAULT FALSE`, 'alter_roles_mention_everyone');
  await runSql(`ALTER TABLE server_roles ADD COLUMN IF NOT EXISTS can_create_invites BOOLEAN DEFAULT FALSE`, 'alter_roles_create_invites');
  await runSql(`ALTER TABLE server_roles ADD COLUMN IF NOT EXISTS can_connect_voice BOOLEAN DEFAULT TRUE`, 'alter_roles_connect_voice');
  await runSql(`ALTER TABLE server_roles ADD COLUMN IF NOT EXISTS can_create_forum_posts BOOLEAN DEFAULT TRUE`, 'alter_roles_create_forum_posts');
  await runSql(`ALTER TABLE server_roles ADD COLUMN IF NOT EXISTS can_reply_forum_posts BOOLEAN DEFAULT TRUE`, 'alter_roles_reply_forum_posts');
  await runSql(`ALTER TABLE server_roles ADD COLUMN IF NOT EXISTS can_lock_forum_posts BOOLEAN DEFAULT FALSE`, 'alter_roles_lock_forum_posts');
  await runSql(`ALTER TABLE forum_posts ADD COLUMN IF NOT EXISTS replies_locked BOOLEAN DEFAULT FALSE`, 'alter_forum_posts_replies_locked');
  await runOnceMigration(
    'default_member_invites_v1',
    `UPDATE server_roles SET can_create_invites=TRUE WHERE is_admin=FALSE`,
    'default_member_invites'
  );
  await runOnceMigration(
    'group_existing_admin_roles_v1',
    `UPDATE server_roles SET display_separately=TRUE WHERE is_admin=TRUE`,
    'group_existing_admin_roles'
  );
  await runSql(`CREATE TABLE IF NOT EXISTS server_boosts (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL,
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
  )`, 'server_boosts');
  await runSql(`CREATE INDEX IF NOT EXISTS idx_server_boosts_active ON server_boosts(server_id, expires_at)`, 'idx_server_boosts_active');
  await runSql(`CREATE TABLE IF NOT EXISTS server_boost_allocations (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    feature TEXT NOT NULL,
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    UNIQUE(server_id, feature)
  )`, 'server_boost_allocations');
  await runSql(`CREATE TABLE IF NOT EXISTS server_economy_items (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    price INTEGER NOT NULL CHECK (price > 0),
    reward_role_id TEXT DEFAULT NULL REFERENCES server_roles(id) ON DELETE SET NULL,
    active BOOLEAN DEFAULT TRUE,
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
  )`, 'server_economy_items');
  await runSql(`ALTER TABLE server_economy_items ADD COLUMN IF NOT EXISTS reward_role_id TEXT DEFAULT NULL REFERENCES server_roles(id) ON DELETE SET NULL`, 'alter_economy_reward_role');
  await runSql(`CREATE INDEX IF NOT EXISTS idx_server_economy_items_server ON server_economy_items(server_id, active, created_at DESC)`, 'idx_server_economy_items_server');
  await runSql(`CREATE TABLE IF NOT EXISTS server_economy_purchases (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES server_economy_items(id) ON DELETE CASCADE,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    buyer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    price INTEGER NOT NULL,
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
  )`, 'server_economy_purchases');
  await runSql(`CREATE INDEX IF NOT EXISTS idx_server_economy_purchases_item ON server_economy_purchases(item_id)`, 'idx_server_economy_purchases_item');
  await runSql(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS tag_background TEXT DEFAULT '#5865f2'`, 'alter_servers_tag_background');
  await runSql(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS tag_private BOOLEAN DEFAULT FALSE`, 'alter_servers_tag_private');
  await runSql(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS invite_description TEXT DEFAULT NULL`, 'alter_servers_invite_description');
  await runSql(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS invite_tags TEXT DEFAULT ''`, 'alter_servers_invite_tags');
  await runSql(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS invite_banner_mode TEXT DEFAULT 'solid'`, 'alter_servers_invite_banner_mode');
  await runSql(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS invite_banner_start TEXT DEFAULT '#5865f2'`, 'alter_servers_invite_banner_start');
  await runSql(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS invite_banner_end TEXT DEFAULT '#a855f7'`, 'alter_servers_invite_banner_end');
  await runSql(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS invite_banner_image TEXT DEFAULT NULL`, 'alter_servers_invite_banner_image');
  await runSql(`UPDATE users SET active_color=NULL, active_font=NULL WHERE active_color IS NOT NULL OR active_font IS NOT NULL`, 'clear_retired_color_font');
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

  await runSql(`CREATE TABLE IF NOT EXISTS ip_bans (
    id TEXT PRIMARY KEY,
    ip_address TEXT NOT NULL,
    device_id TEXT DEFAULT NULL,
    username TEXT DEFAULT NULL,
    user_id TEXT DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    banned_by TEXT NOT NULL REFERENCES users(id),
    reason TEXT DEFAULT NULL,
    active BOOLEAN DEFAULT TRUE,
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
  )`, 'ip_bans');
  await runSql(`ALTER TABLE ip_bans ADD COLUMN IF NOT EXISTS device_id TEXT DEFAULT NULL`, 'alter_ip_bans_device_id');
  await runSql(`CREATE INDEX IF NOT EXISTS idx_ip_bans_active_ip ON ip_bans(ip_address, active)`, 'idx_ip_bans_active_ip');
  await runSql(`CREATE INDEX IF NOT EXISTS idx_ip_bans_active_device ON ip_bans(device_id, active)`, 'idx_ip_bans_active_device');

  await runSql(`CREATE TABLE IF NOT EXISTS limited_nfc_tags (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    label TEXT DEFAULT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    max_nexals INTEGER NOT NULL DEFAULT 1000000,
    max_pro_days INTEGER NOT NULL DEFAULT 365,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    reserved_by TEXT DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    reserved_until BIGINT DEFAULT NULL,
    consumed_by TEXT DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    consumed_at BIGINT DEFAULT NULL
  )`, 'limited_nfc_tags');
  await runSql(`CREATE INDEX IF NOT EXISTS idx_limited_nfc_tags_hash ON limited_nfc_tags(token_hash)`, 'idx_limited_nfc_tags_hash');

  await runSql(`CREATE TABLE IF NOT EXISTS limited_claim_sessions (
    id TEXT PRIMARY KEY,
    tag_id TEXT NOT NULL REFERENCES limited_nfc_tags(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL,
    completed_at BIGINT DEFAULT NULL,
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
  )`, 'limited_claim_sessions');
  await runSql(`CREATE INDEX IF NOT EXISTS idx_limited_claim_sessions_user ON limited_claim_sessions(user_id, expires_at)`, 'idx_limited_claim_sessions_user');

  await runSql(`CREATE TABLE IF NOT EXISTS limited_redemption_codes (
    id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reward_type TEXT NOT NULL,
    reward_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    expires_at BIGINT NOT NULL,
    redeemed_at BIGINT DEFAULT NULL,
    redeemed_by TEXT DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
  )`, 'limited_redemption_codes');
  await runSql(`ALTER TABLE limited_redemption_codes ADD COLUMN IF NOT EXISTS redeemed_by TEXT DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL`, 'alter_limited_redemption_redeemed_by');
  await runSql(`ALTER TABLE limited_redemption_codes ADD COLUMN IF NOT EXISTS label TEXT DEFAULT NULL`, 'alter_limited_redemption_label');
  await runSql(`ALTER TABLE limited_redemption_codes ADD COLUMN IF NOT EXISTS code_hint TEXT DEFAULT NULL`, 'alter_limited_redemption_code_hint');
  await runSql(`ALTER TABLE limited_redemption_codes ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE`, 'alter_limited_redemption_active');
  await runSql(`ALTER TABLE limited_redemption_codes ADD COLUMN IF NOT EXISTS max_uses INTEGER DEFAULT 1`, 'alter_limited_redemption_max_uses');
  await runSql(`ALTER TABLE limited_redemption_codes ADD COLUMN IF NOT EXISTS use_count INTEGER NOT NULL DEFAULT 0`, 'alter_limited_redemption_use_count');
  await runSql(`UPDATE limited_redemption_codes SET use_count=1 WHERE redeemed_at IS NOT NULL AND use_count=0`, 'normalize_limited_redemption_use_count');
  await runSql(`CREATE INDEX IF NOT EXISTS idx_limited_redemption_user ON limited_redemption_codes(user_id, expires_at)`, 'idx_limited_redemption_user');

  await runSql(`CREATE TABLE IF NOT EXISTS limited_code_uses (
    id TEXT PRIMARY KEY,
    code_id TEXT NOT NULL REFERENCES limited_redemption_codes(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reward_type TEXT NOT NULL,
    reward_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    UNIQUE(code_id, user_id)
  )`, 'limited_code_uses');
  await runSql(`CREATE INDEX IF NOT EXISTS idx_limited_code_uses_code ON limited_code_uses(code_id, created_at DESC)`, 'idx_limited_code_uses_code');

  await runSql(`CREATE TABLE IF NOT EXISTS user_achievements (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    achievement_id TEXT NOT NULL,
    progress INTEGER DEFAULT 0,
    completed_at BIGINT DEFAULT NULL,
    claimed_at BIGINT DEFAULT NULL,
    UNIQUE(user_id, achievement_id)
  )`, 'user_achievements');

  await runSql(`CREATE TABLE IF NOT EXISTS admin_users (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    added_by TEXT NOT NULL REFERENCES users(id),
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    UNIQUE(user_id)
  )`, 'admin_users');

  await runSql(`CREATE TABLE IF NOT EXISTS user_client_state (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    is_paused BOOLEAN DEFAULT FALSE,
    pause_message TEXT DEFAULT NULL,
    updated_by TEXT DEFAULT NULL REFERENCES users(id),
    updated_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    UNIQUE(user_id)
  )`, 'user_client_state');

  await runSql(`CREATE TABLE IF NOT EXISTS system_reports (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    active BOOLEAN DEFAULT TRUE,
    published_by TEXT NOT NULL REFERENCES users(id),
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    cleared_at BIGINT DEFAULT NULL,
    cleared_by TEXT DEFAULT NULL REFERENCES users(id)
  )`, 'system_reports');
  await runSql(`CREATE UNIQUE INDEX IF NOT EXISTS idx_system_reports_one_active ON system_reports(active) WHERE active=TRUE`, 'idx_system_reports_one_active');
  await runSql(`CREATE INDEX IF NOT EXISTS idx_system_reports_created ON system_reports(created_at DESC)`, 'idx_system_reports_created');
  await runSql(`CREATE TABLE IF NOT EXISTS system_report_acknowledgements (
    id TEXT PRIMARY KEY,
    report_id TEXT NOT NULL REFERENCES system_reports(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    acknowledged_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    UNIQUE(report_id, user_id)
  )`, 'system_report_acknowledgements');
  await runSql(`CREATE INDEX IF NOT EXISTS idx_system_report_acks_user_report ON system_report_acknowledgements(user_id, report_id)`, 'idx_system_report_acks_user_report');

  await runSql(`CREATE TABLE IF NOT EXISTS user_reports (
    id TEXT PRIMARY KEY,
    reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    report_type TEXT NOT NULL,
    reason TEXT DEFAULT NULL,
    message_type TEXT DEFAULT NULL,
    message_id TEXT DEFAULT NULL,
    message_content TEXT DEFAULT NULL,
    server_id TEXT DEFAULT NULL REFERENCES servers(id) ON DELETE SET NULL,
    channel_id TEXT DEFAULT NULL REFERENCES channels(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    resolved_at BIGINT DEFAULT NULL,
    resolved_by TEXT DEFAULT NULL REFERENCES users(id)
  )`, 'user_reports');
  await runSql(`CREATE INDEX IF NOT EXISTS idx_user_reports_status_created ON user_reports(status, created_at DESC)`, 'idx_user_reports_status_created');

  await runSql(`CREATE TABLE IF NOT EXISTS global_safety_terms (
    id TEXT PRIMARY KEY,
    term TEXT NOT NULL,
    normalized_term TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL DEFAULT 'discriminatory',
    created_by TEXT DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
  )`, 'global_safety_terms');
  await runSql(`ALTER TABLE global_safety_terms ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'discriminatory'`, 'alter_global_safety_terms_category');
  await runSql(`CREATE INDEX IF NOT EXISTS idx_global_safety_terms_normalized ON global_safety_terms(normalized_term)`, 'idx_global_safety_terms_normalized');
  await runSql(`
    INSERT INTO global_safety_terms (id, term, normalized_term)
    SELECT seed.id, seed.term, seed.normalized_term
    FROM (VALUES
      ('safety-default-1', 'nigger', 'nigger'),
      ('safety-default-2', 'nigga', 'nigga'),
      ('safety-default-3', 'faggot', 'faggot'),
      ('safety-default-4', 'kike', 'kike'),
      ('safety-default-5', 'chink', 'chink'),
      ('safety-default-6', 'spic', 'spic'),
      ('safety-default-7', 'wetback', 'wetback')
    ) AS seed(id, term, normalized_term)
    WHERE NOT EXISTS (SELECT 1 FROM global_safety_terms)
    ON CONFLICT (normalized_term) DO NOTHING
  `, 'seed_global_safety_terms');
  await runSql(`
    INSERT INTO global_safety_terms (id, term, normalized_term, category)
    SELECT seed.id, seed.term, seed.normalized_term, 'nsfw'
    FROM (VALUES
      ('safety-nsfw-1', 'send nudes', 'sendnudes'),
      ('safety-nsfw-2', 'nude pics', 'nudepics'),
      ('safety-nsfw-3', 'explicit photos', 'explicitphotos'),
      ('safety-nsfw-4', 'porn link', 'pornlink'),
      ('safety-nsfw-5', 'sexual content', 'sexualcontent')
    ) AS seed(id, term, normalized_term)
    WHERE NOT EXISTS (SELECT 1 FROM global_safety_terms WHERE category='nsfw')
    ON CONFLICT (normalized_term) DO NOTHING
  `, 'seed_global_safety_terms_nsfw');
  await runSql(`
    INSERT INTO global_safety_terms (id, term, normalized_term, category)
    SELECT seed.id, seed.term, seed.normalized_term, 'child_safety'
    FROM (VALUES
      ('safety-child-1', 'child porn', 'childporn'),
      ('safety-child-2', 'underage nudes', 'underagenudes'),
      ('safety-child-3', 'minor nudes', 'minornudes'),
      ('safety-child-4', 'sexualize minors', 'sexualizeminors'),
      ('safety-child-5', 'explicit minor', 'explicitminor')
    ) AS seed(id, term, normalized_term)
    WHERE NOT EXISTS (SELECT 1 FROM global_safety_terms WHERE category='child_safety')
    ON CONFLICT (normalized_term) DO NOTHING
  `, 'seed_global_safety_terms_child_safety');

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
