const avatarCache = new Map();
const MAX_CACHE_ENTRIES = 500;

function avatarUrl(userId, hasAvatar) {
  return hasAvatar ? `/api/users/avatar/${encodeURIComponent(userId)}` : null;
}

function clearCachedAvatar(userId) {
  avatarCache.delete(userId);
}

function setCachedAvatar(userId, avatarData, avatarMime) {
  if (!userId) return;
  if (!avatarData) {
    clearCachedAvatar(userId);
    return;
  }
  if (avatarCache.size >= MAX_CACHE_ENTRIES && !avatarCache.has(userId)) {
    avatarCache.delete(avatarCache.keys().next().value);
  }
  avatarCache.set(userId, {
    data: Buffer.from(avatarData, 'base64'),
    mime: avatarMime || 'image/png'
  });
}

async function getAvatar(pool, userId) {
  const cached = avatarCache.get(userId);
  if (cached) return cached;
  const result = await pool.query('SELECT avatar_data, avatar_mime FROM users WHERE id=$1', [userId]);
  const user = result.rows[0];
  if (!user?.avatar_data) return null;
  setCachedAvatar(userId, user.avatar_data, user.avatar_mime);
  return avatarCache.get(userId) || null;
}

module.exports = { avatarUrl, clearCachedAvatar, getAvatar, setCachedAvatar };
