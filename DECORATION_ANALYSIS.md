# Profile Decorations - Complete Codebase Analysis

## Executive Summary

The NexusChat application has a fully-functional decoration system for direct messages and channel messages. However, **5 API endpoints are missing decoration data**, preventing decorations from displaying in friend lists, search results, friend requests, and user profile popups.

- **✅ Working:** DMs, channel messages, message history, real-time messages
- **❌ Missing:** Friend lists, friend search, friend requests, user profiles

**Total Issues:** 5 endpoints missing `active_decoration` in SQL SELECT queries

---

## Decoration System Overview

### What Are Decorations?
User profile decorations are visual effects that appear around user avatars:
- Examples: glow effects, orbits, halos, neon, galaxies, fire, admin crowns
- Stored in database as: `active_decoration` field (TEXT)
- Applied in frontend via CSS classes: `.avatar-deco.deco-{decoration_id}`

### Frontend Rendering (✅ ALL WORKING)
The frontend can render decorations anywhere via the `renderAvatar()` function:
- **File:** [src/js/app.js](public/js/app.js#L41)
- **Lines:** 41-168
- **Function:** `renderAvatar(el, user, showDeco = true)`
- **Capability:** Renders avatars + decorations for any element
- **CSS Integration:** Automatically applies decoration-specific CSS classes

---

## PART 1: Working Decorations ✅

### 1. Direct Messages (DMs)

#### API Endpoint
**GET `/api/messages/:userId`**
- **File:** [src/routes/messages.js](src/routes/messages.js#L1-L45)
- **Lines:** 1-45

#### SQL Query
```sql
SELECT m.id, m.from_id, m.to_id, m.content, m.created_at,
  u.username, u.display_name, u.avatar_data, u.avatar_mime, 
  u.active_decoration, u.active_color, u.active_font
FROM messages m 
JOIN users u ON u.id=m.from_id
WHERE ((m.from_id=$1 AND m.to_id=$2) OR (m.from_id=$2 AND m.to_id=$1))
```
**Line:** 18

#### Response Mapping
```javascript
// Lines 32-38
author: {
  username: m.username,
  displayName: m.display_name,
  avatarDataUrl: m.avatar_data ? `data:${m.avatar_mime};base64,${m.avatar_data}` : null,
  activeDecoration: m.active_decoration || null,  // ✅ INCLUDES
  activeColor: m.active_color || null,
  activeFont: m.active_font || null
}
```

#### Frontend Handler
- **File:** [public/js/app.js](public/js/app.js#L2244)
- **Lines:** 2244-2291
- **Function:** `buildMessageEl(msg, prevEl)`
- **Renders:** Creates message DOM with avatar wrap
- **Avatar Rendering:** Line 2289 calls `renderAvatar(av, author)`

---

### 2. Real-Time DM Messages (Socket.IO)

#### Socket Event: `send_message`
- **File:** [src/server.js](src/server.js#L199-L243)
- **Lines:** 199-243

#### SQL Query
```sql
SELECT u.username, u.display_name, u.avatar_data, u.avatar_mime, 
  u.active_decoration, u.active_color, u.active_font,
  (SELECT id FROM friendships WHERE ...) as friend_id
FROM users u WHERE u.id=$1
```
**Line:** 205

#### Message Object
```javascript
// Lines 217-224
const msg = {
  id: msgId, fromId: userId, toId, content: trimmed, createdAt: now,
  author: {
    username: s.username, displayName: s.display_name,
    avatarDataUrl: s.avatar_data ? `data:${s.avatar_mime};base64,${s.avatar_data}` : null,
    activeDecoration: s.active_decoration || null,  // ✅ INCLUDES
    activeColor: s.active_color || null,
    activeFont: s.active_font || null
  }
};
```

#### Emission
```javascript
// Lines 226-230
socket.emit('new_message', msg);
io.to(`user:${toId}`).emit('new_message', msg);
socket.to(`user:${userId}`).emit('new_message', msg);
```

#### Frontend Handler
- **File:** [public/js/app.js](public/js/app.js#L2391-L2407)
- **Lines:** 2391-2407
- **Handler:** `socket.on('new_message', msg => ...)`
- **Calls:** `appendMessage(msg)` which calls `buildMessageEl()`

---

### 3. Channel Messages

#### API Endpoint
**GET `/api/servers/{serverId}/channels/{channelId}/messages`**
- **File:** [src/routes/messages.js](src/routes/messages.js#L1)
- **Lines:** 1-45

#### Similar structure to DM messages with `active_decoration` included

---

### 4. Real-Time Channel Messages (Socket.IO)

#### Socket Event: `send_channel_message`
- **File:** [src/server.js](src/server.js#L260-L349)
- **Lines:** 260-349

#### SQL Query
```sql
SELECT sm.role_id, sm.role AS member_role, sr.name as role_name, sr.color as role_color,
  sr.is_admin,
  u.username, u.display_name, u.avatar_data, u.avatar_mime, 
  u.active_decoration,
  ch.id as ch_id, ch.locked, ch.private as ch_private,
  (SELECT allow_send FROM channel_permissions ...) as perm_allow
FROM server_members sm
JOIN users u ON u.id=sm.user_id
JOIN channels ch ON ch.id=$2 AND ch.server_id=$1
LEFT JOIN server_roles sr ON sr.id=sm.role_id
WHERE sm.server_id=$1 AND sm.user_id=$3
```
**Lines:** 261-275

#### Message Object
```javascript
// Lines 285-297
const msg = {
  id: msgId, channelId, serverId, fromId: userId,
  content: trimmed, createdAt: now,
  author: {
    username: row.username, displayName: row.display_name,
    avatarDataUrl: row.avatar_data ? `data:${row.avatar_mime};base64,${row.avatar_data}` : null,
    roleColor: row.role_color || null, roleName: row.role_name || null,
    activeDecoration: row.active_decoration || null,  // ✅ INCLUDES
    activeColor: row.active_color || null,
    activeFont: row.active_font || null
  }
};
```

#### Emission
```javascript
// Lines 330-331
socket.emit('new_channel_message', msg);
socket.to(`server:${serverId}`).emit('new_channel_message', msg);
```

#### Frontend Handler
- **File:** [public/js/app.js](public/js/app.js#L2514-L2525)
- **Lines:** 2514-2525
- **Handler:** `socket.on('new_channel_message', msg => ...)`
- **Calls:** `appendChannelMessage(msg)` which calls `buildMessageEl()`

---

### 5. Server Members List

#### API Endpoint
**GET `/api/servers/{serverId}`**
- **File:** [src/server.js](src/server.js#L177-L232)
- **Lines:** 177-232 (loading)

#### SQL Query
```sql
SELECT u.id, u.username, u.display_name, u.avatar_data, u.avatar_mime, 
  u.status, u.active_decoration, u.active_color
FROM server_members sm
JOIN users u ON u.id=sm.user_id
WHERE sm.server_id=$1
```
**Line:** 194 and 521

#### Response Mapping
```javascript
// Lines 211-217
activeDecoration: m.active_decoration || null,  // ✅ INCLUDES
activeColor: m.active_color || null
```

---

## PART 2: Missing Decorations ❌

### Problem Areas

All 5 issues follow the same pattern:
1. SQL SELECT query doesn't fetch `u.active_decoration`
2. Response object doesn't include `activeDecoration`
3. Frontend calls `renderAvatar(av, user)` but `user.activeDecoration` is `undefined`

---

### Issue #1: Friend List ❌

#### What It Is
The list of all friends shown in the Friends sidebar.

#### API Endpoint
**GET `/api/friends`**
- **File:** [src/routes/friends.js](src/routes/friends.js#L108-L120)
- **Lines:** 108-120

#### Current SQL Query (❌ Missing decoration)
```sql
SELECT u.id, u.username, u.display_name, u.avatar_data, u.avatar_mime, u.status
FROM friendships f
JOIN users u ON u.id = CASE WHEN f.user1_id=$1 THEN f.user2_id ELSE f.user1_id END
WHERE f.user1_id=$1 OR f.user2_id=$1
```
**Line:** 110

#### Should Be
```sql
SELECT u.id, u.username, u.display_name, u.avatar_data, u.avatar_mime, 
  u.status, u.active_decoration  -- ← ADD THIS
FROM friendships f
...
```

#### Current Response (❌ Missing)
```javascript
// Lines 116-120
friends: r.rows.map(u => ({
  id: u.id, username: u.username, displayName: u.display_name, status: u.status,
  avatarDataUrl: u.avatar_data ? `data:${u.avatar_mime};base64,${u.avatar_data}` : null
  // Missing: activeDecoration
}))
```

#### Should Be
```javascript
friends: r.rows.map(u => ({
  id: u.id, username: u.username, displayName: u.display_name, status: u.status,
  avatarDataUrl: u.avatar_data ? `data:${u.avatar_mime};base64,${u.avatar_data}` : null,
  activeDecoration: u.active_decoration || null  // ← ADD THIS
}))
```

#### Frontend Impact
- **File:** [public/js/app.js](public/js/app.js#L2004-L2036)
- **Function:** `renderFriendsList()` (Lines 2009-2036)
- **Line 2034:** `renderAvatar(av, f)` - called for each friend
- **Problem:** `f.activeDecoration` is undefined, so no decoration renders
- **User Impact:** Friend avatars show no decorations

**Severity:** HIGH - Core feature, visible to all users

---

### Issue #2: Friend Search Results ❌

#### What It Is
Users shown when searching for friends to add.

#### API Endpoint
**GET `/api/friends/search?q={query}`**
- **File:** [src/routes/friends.js](src/routes/friends.js#L9-L21)
- **Lines:** 9-21

#### Current SQL Query (❌ Missing decoration)
```sql
SELECT id, username, display_name, avatar_data, avatar_mime FROM users
WHERE LOWER(username) LIKE LOWER($1) AND id != $2 LIMIT 10
```
**Line:** 13

#### Should Be
```sql
SELECT id, username, display_name, avatar_data, avatar_mime, 
  active_decoration  -- ← ADD THIS
FROM users
WHERE LOWER(username) LIKE LOWER($1) AND id != $2 LIMIT 10
```

#### Current Response (❌ Missing)
```javascript
// Lines 18-22
users: r.rows.map(u => ({
  id: u.id, username: u.username, displayName: u.display_name,
  avatarDataUrl: u.avatar_data ? `data:${u.avatar_mime};base64,${u.avatar_data}` : null
  // Missing: activeDecoration
}))
```

#### Frontend Impact
- **File:** [public/js/app.js](public/js/app.js#L1955-L1993)
- **Function:** `searchUsers(q)` (Lines 1966-1993)
- **Line 1992:** `renderAvatar(av, u)` - called for each search result
- **Problem:** `u.activeDecoration` is undefined
- **User Impact:** Search results show no decorations

**Severity:** HIGH - Core feature, frequently used

---

### Issue #3: Incoming Friend Requests ❌

#### What It Is
Friend requests received from other users.

#### API Endpoint
**GET `/api/friends/requests/incoming`**
- **File:** [src/routes/friends.js](src/routes/friends.js#L50-L61)
- **Lines:** 50-61

#### Current SQL Query (❌ Missing decoration)
```sql
SELECT fr.id, fr.from_id, fr.created_at, u.username, u.display_name, u.avatar_data, u.avatar_mime
FROM friend_requests fr 
JOIN users u ON u.id=fr.from_id
WHERE fr.to_id=$1 AND fr.status='pending'
```
**Line:** 52

#### Should Be
```sql
SELECT fr.id, fr.from_id, fr.created_at, u.username, u.display_name, 
  u.avatar_data, u.avatar_mime, u.active_decoration  -- ← ADD THIS
FROM friend_requests fr 
JOIN users u ON u.id=fr.from_id
WHERE fr.to_id=$1 AND fr.status='pending'
```

#### Current Response (❌ Missing)
```javascript
// Lines 58-61
requests: r.rows.map(r => ({
  id: r.id, fromId: r.from_id, username: r.username, displayName: r.display_name,
  avatarDataUrl: r.avatar_data ? `data:${r.avatar_mime};base64,${r.avatar_data}` : null,
  createdAt: r.created_at
  // Missing: activeDecoration
}))
```

#### Frontend Impact
- **File:** [public/js/app.js](public/js/app.js#L2063-L2099)
- **Function:** `loadPendingRequests()` (Lines 2063-2099)
- **Line 2083:** `renderAvatar(av, r)` - called for each incoming request
- **Problem:** `r.activeDecoration` is undefined
- **User Impact:** Request sender avatars show no decorations

**Severity:** MEDIUM - Social feature

---

### Issue #4: Outgoing Friend Requests ❌

#### What It Is
Friend requests sent to other users.

#### API Endpoint
**GET `/api/friends/requests/outgoing`**
- **File:** [src/routes/friends.js](src/routes/friends.js#L64-L75)
- **Lines:** 64-75

#### Current SQL Query (❌ Missing decoration)
```sql
SELECT fr.id, fr.to_id, fr.created_at, u.username, u.display_name, u.avatar_data, u.avatar_mime
FROM friend_requests fr 
JOIN users u ON u.id=fr.to_id
WHERE fr.from_id=$1 AND fr.status='pending'
```
**Line:** 66

#### Should Be
```sql
SELECT fr.id, fr.to_id, fr.created_at, u.username, u.display_name, 
  u.avatar_data, u.avatar_mime, u.active_decoration  -- ← ADD THIS
FROM friend_requests fr 
JOIN users u ON u.id=fr.to_id
WHERE fr.from_id=$1 AND fr.status='pending'
```

#### Current Response (❌ Missing)
```javascript
// Lines 72-75
requests: r.rows.map(r => ({
  id: r.id, toId: r.to_id, username: r.username, displayName: r.display_name,
  avatarDataUrl: r.avatar_data ? `data:${r.avatar_mime};base64,${r.avatar_data}` : null,
  createdAt: r.created_at
  // Missing: activeDecoration
}))
```

#### Frontend Impact
- **File:** [public/js/app.js](public/js/app.js#L2091-L2107)
- **Function:** `loadPendingRequests()` (Lines 2091-2107)
- **Line 2098:** `renderAvatar(av, r)` - called for each outgoing request
- **Problem:** `r.activeDecoration` is undefined
- **User Impact:** Request recipient avatars show no decorations

**Severity:** MEDIUM - Social feature

---

### Issue #5: User Profile Popup ❌

#### What It Is
Profile panel that appears when clicking on a username or member.

#### API Endpoint
**GET `/api/users/profile/{userId}`**
- **File:** [src/routes/users.js](src/routes/users.js#L32-L43)
- **Lines:** 32-43

#### Current SQL Query (❌ Missing decoration)
```sql
SELECT id, username, display_name, avatar_data, avatar_mime, bio FROM users WHERE id=$1
```
**Line:** 34

#### Should Be
```sql
SELECT id, username, display_name, avatar_data, avatar_mime, bio, 
  active_decoration  -- ← ADD THIS
FROM users WHERE id=$1
```

#### Current Response (❌ Missing)
```javascript
// Lines 40-44
res.json({
  id: u.id, username: u.username, displayName: u.display_name,
  avatarDataUrl: u.avatar_data ? `data:${u.avatar_mime};base64,${u.avatar_data}` : null,
  bio: u.bio || null
  // Missing: activeDecoration
});
```

#### Should Be
```javascript
res.json({
  id: u.id, username: u.username, displayName: u.display_name,
  avatarDataUrl: u.avatar_data ? `data:${u.avatar_mime};base64,${u.avatar_data}` : null,
  bio: u.bio || null,
  activeDecoration: u.active_decoration || null  // ← ADD THIS
});
```

#### Frontend Impact
- **File:** [public/js/app.js](public/js/app.js#L3745-L3787)
- **Function:** `showProfilePopup()` (Lines 3745-3787)
- **Line 3751:** `renderAvatar($('popup-avatar'), data)` - renders initial avatar
- **Line 3777:** Fetches profile but only for bio, not decoration
- **Problem:** `data.activeDecoration` is undefined from initial render, never updated
- **User Impact:** Profile popup avatars show no decorations

**Severity:** HIGH - Core feature, all profiles

---

## Summary Table

| Feature | Endpoint | File | Line | Issue | Fix |
|---------|----------|------|------|-------|-----|
| DMs | GET /api/messages/:userId | messages.js | 18 | ✅ Working | - |
| DM Real-time | Socket: send_message | server.js | 205 | ✅ Working | - |
| Channels | GET /api/servers/.../messages | messages.js | 18 | ✅ Working | - |
| Channel Real-time | Socket: send_channel_message | server.js | 269 | ✅ Working | - |
| Server Members | GET /api/servers/:id | server.js | 194, 521 | ✅ Working | - |
| **Friends** | **GET /api/friends** | **friends.js** | **110** | ❌ Missing `active_decoration` | Add to SELECT & response |
| **Friend Search** | **GET /api/friends/search** | **friends.js** | **13** | ❌ Missing `active_decoration` | Add to SELECT & response |
| **Req. Incoming** | **GET /api/friends/requests/incoming** | **friends.js** | **52** | ❌ Missing `active_decoration` | Add to SELECT & response |
| **Req. Outgoing** | **GET /api/friends/requests/outgoing** | **friends.js** | **66** | ❌ Missing `active_decoration` | Add to SELECT & response |
| **User Profile** | **GET /api/users/profile/:id** | **users.js** | **34** | ❌ Missing `active_decoration` | Add to SELECT & response |

---

## Quick Reference: Where renderAvatar() Is Called

The frontend is ready to render decorations everywhere. It just needs the data:

1. **buildMessageEl** - [public/js/app.js:2289](public/js/app.js#L2289) - DM/channel messages
2. **renderFriendsList** - [public/js/app.js:2034](public/js/app.js#L2034) - Friend list ❌
3. **loadPendingRequests (incoming)** - [public/js/app.js:2083](public/js/app.js#L2083) - Incoming requests ❌
4. **loadPendingRequests (outgoing)** - [public/js/app.js:2098](public/js/app.js#L2098) - Outgoing requests ❌
5. **searchUsers** - [public/js/app.js:1992](public/js/app.js#L1992) - Search results ❌
6. **showProfilePopup** - [public/js/app.js:3751](public/js/app.js#L3751) - Profile popup ❌
7. **openDm** - [public/js/app.js:2167](public/js/app.js#L2167) - DM header avatar ✅ (data from friend list)

---

## Decoration CSS Classes

Available decorations (all working in renderAvatar function):

**Glow effects:** glow_blue, glow_green
**Orbit effects:** orbit_white, orbit_gold  
**Other effects:** halo_gold, neon_pink, galaxy, fire, rainbow, frost, pulse_teal, spark_red, haze_purple
**Special:** nexus_admin (red energy ring), storm (canvas-based)

---

## Conclusion

**The entire decoration rendering system is functional.** The problem is not with the frontend code or the decoration system itself, but with **5 specific API endpoints that don't return the required `active_decoration` field**.

**Fix Required:** Add `u.active_decoration` to the SELECT clause and include `activeDecoration` in the response objects for all 5 endpoints listed above.
