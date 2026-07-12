async function getChannelAccess(pool, serverId, channelId, userId) {
  if (!serverId || !channelId || !userId) return null;
  const result = await pool.query(
    `SELECT c.id, c.channel_type, c.private, c.locked
     FROM channels c
     JOIN server_members sm ON sm.server_id=c.server_id AND sm.user_id=$3
     WHERE c.server_id=$1 AND c.id=$2
       AND (
         c.private=FALSE
         OR sm.role='admin'
         OR EXISTS (
           SELECT 1
           FROM server_roles primary_role
           WHERE primary_role.id=sm.role_id AND primary_role.is_admin=TRUE
         )
         OR EXISTS (
           SELECT 1
           FROM server_member_roles smr
           JOIN server_roles sr ON sr.id=smr.role_id
           WHERE smr.server_id=sm.server_id
             AND smr.user_id=sm.user_id
             AND sr.is_admin=TRUE
         )
         OR EXISTS (
           SELECT 1
           FROM channel_permissions cp
           WHERE cp.channel_id=c.id
             AND cp.allow_view=TRUE
             AND (
               cp.role_id=sm.role_id
               OR EXISTS (
                 SELECT 1
                 FROM server_member_roles smr
                 WHERE smr.server_id=sm.server_id
                   AND smr.user_id=sm.user_id
                   AND smr.role_id=cp.role_id
               )
             )
         )
       )
     LIMIT 1`,
    [serverId, channelId, userId]
  );
  return result.rows[0] || null;
}

async function canAccessChannel(pool, serverId, channelId, userId) {
  return Boolean(await getChannelAccess(pool, serverId, channelId, userId));
}

async function getChannelAccessibleUserIds(pool, serverId, channelId, userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean).map(String))];
  if (!ids.length) return [];
  const result = await pool.query(
    `SELECT sm.user_id
     FROM server_members sm
     JOIN channels c ON c.server_id=sm.server_id AND c.id=$2
     WHERE sm.server_id=$1 AND sm.user_id = ANY($3)
       AND (
         c.private=FALSE
         OR sm.role='admin'
         OR EXISTS (
           SELECT 1 FROM server_roles primary_role
           WHERE primary_role.id=sm.role_id AND primary_role.is_admin=TRUE
         )
         OR EXISTS (
           SELECT 1 FROM server_member_roles smr
           JOIN server_roles sr ON sr.id=smr.role_id
           WHERE smr.server_id=sm.server_id AND smr.user_id=sm.user_id AND sr.is_admin=TRUE
         )
         OR EXISTS (
           SELECT 1 FROM channel_permissions cp
           WHERE cp.channel_id=c.id AND cp.allow_view=TRUE
             AND (
               cp.role_id=sm.role_id
               OR EXISTS (
                 SELECT 1 FROM server_member_roles smr
                 WHERE smr.server_id=sm.server_id AND smr.user_id=sm.user_id AND smr.role_id=cp.role_id
               )
             )
         )
       )`,
    [serverId, channelId, ids]
  );
  return result.rows.map(row => row.user_id);
}

module.exports = { getChannelAccess, canAccessChannel, getChannelAccessibleUserIds };
