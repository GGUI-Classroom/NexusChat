# Decoration Rendering - Quick Reference & Fixes

## The Problem

Decorations are not showing in friend lists, search results, friend requests, and user profiles.

**Root Cause:** 5 API endpoints don't include `active_decoration` in their SQL queries or responses.

---

## Quick Fix Summary

### 5 Files to Update:

| File | Line | Change |
|------|------|--------|
| src/routes/friends.js | 110 | Add `u.active_decoration` to SELECT |
| src/routes/friends.js | 13 | Add `u.active_decoration` to SELECT |
| src/routes/friends.js | 52 | Add `u.active_decoration` to SELECT |
| src/routes/friends.js | 66 | Add `u.active_decoration` to SELECT |
| src/routes/users.js | 34 | Add `u.active_decoration` to SELECT |

---

## Detailed Fixes

### 1. Fix Friend List (Line 110)

**File:** `src/routes/friends.js`

**Current Code (Lines 108-120):**
```javascript
router.get('/', async (req, res) => {
  const r = await pool.query(
    `SELECT u.id, u.username, u.display_name, u.avatar_data, u.avatar_mime, u.status
     FROM friendships f
     JOIN users u ON u.id = CASE WHEN f.user1_id=$1 THEN f.user2_id ELSE f.user1_id END
     WHERE f.user1_id=$1 OR f.user2_id=$1`,
    [req.session.userId]
  );
  res.json({ friends: r.rows.map(u => ({
    id: u.id, username: u.username, displayName: u.display_name, status: u.status,
    avatarDataUrl: u.avatar_data ? `data:${u.avatar_mime};base64,${u.avatar_data}` : null
  }))});
});
```

**Fix:**
```javascript
router.get('/', async (req, res) => {
  const r = await pool.query(
    `SELECT u.id, u.username, u.display_name, u.avatar_data, u.avatar_mime, u.status, u.active_decoration
     FROM friendships f
     JOIN users u ON u.id = CASE WHEN f.user1_id=$1 THEN f.user2_id ELSE f.user1_id END
     WHERE f.user1_id=$1 OR f.user2_id=$1`,
    [req.session.userId]
  );
  res.json({ friends: r.rows.map(u => ({
    id: u.id, username: u.username, displayName: u.display_name, status: u.status,
    avatarDataUrl: u.avatar_data ? `data:${u.avatar_mime};base64,${u.avatar_data}` : null,
    activeDecoration: u.active_decoration || null
  }))});
});
```

**Changes:**
- Line 110: Add `, u.active_decoration` after `u.status`
- Line 118: Add `, activeDecoration: u.active_decoration || null`

---

### 2. Fix Friend Search (Line 13)

**File:** `src/routes/friends.js`

**Current Code (Lines 9-21):**
```javascript
router.get('/search', async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json({ users: [] });
  const r = await pool.query(
    `SELECT id, username, display_name, avatar_data, avatar_mime FROM users
     WHERE LOWER(username) LIKE LOWER($1) AND id != $2 LIMIT 10`,
    [`%${q}%`, req.session.userId]
  );
  res.json({ users: r.rows.map(u => ({
    id: u.id, username: u.username, displayName: u.display_name,
    avatarDataUrl: u.avatar_data ? `data:${u.avatar_mime};base64,${u.avatar_data}` : null
  }))});
});
```

**Fix:**
```javascript
router.get('/search', async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json({ users: [] });
  const r = await pool.query(
    `SELECT id, username, display_name, avatar_data, avatar_mime, active_decoration FROM users
     WHERE LOWER(username) LIKE LOWER($1) AND id != $2 LIMIT 10`,
    [`%${q}%`, req.session.userId]
  );
  res.json({ users: r.rows.map(u => ({
    id: u.id, username: u.username, displayName: u.display_name,
    avatarDataUrl: u.avatar_data ? `data:${u.avatar_mime};base64,${u.avatar_data}` : null,
    activeDecoration: u.active_decoration || null
  }))});
});
```

**Changes:**
- Line 13: Add `, active_decoration` to SELECT
- Line 19: Add `, activeDecoration: u.active_decoration || null`

---

### 3. Fix Incoming Friend Requests (Line 52)

**File:** `src/routes/friends.js`

**Current Code (Lines 50-61):**
```javascript
router.get('/requests/incoming', async (req, res) => {
  const r = await pool.query(
    `SELECT fr.id, fr.from_id, fr.created_at, u.username, u.display_name, u.avatar_data, u.avatar_mime
     FROM friend_requests fr JOIN users u ON u.id=fr.from_id
     WHERE fr.to_id=$1 AND fr.status='pending'`,
    [req.session.userId]
  );
  res.json({ requests: r.rows.map(r => ({
    id: r.id, fromId: r.from_id, username: r.username, displayName: r.display_name,
    avatarDataUrl: r.avatar_data ? `data:${r.avatar_mime};base64,${r.avatar_data}` : null,
    createdAt: r.created_at
  }))});
});
```

**Fix:**
```javascript
router.get('/requests/incoming', async (req, res) => {
  const r = await pool.query(
    `SELECT fr.id, fr.from_id, fr.created_at, u.username, u.display_name, u.avatar_data, u.avatar_mime, u.active_decoration
     FROM friend_requests fr JOIN users u ON u.id=fr.from_id
     WHERE fr.to_id=$1 AND fr.status='pending'`,
    [req.session.userId]
  );
  res.json({ requests: r.rows.map(r => ({
    id: r.id, fromId: r.from_id, username: r.username, displayName: r.display_name,
    avatarDataUrl: r.avatar_data ? `data:${r.avatar_mime};base64,${r.avatar_data}` : null,
    createdAt: r.created_at,
    activeDecoration: r.active_decoration || null
  }))});
});
```

**Changes:**
- Line 52: Add `, u.active_decoration` at the end of SELECT
- Line 59: Add `, activeDecoration: r.active_decoration || null`

---

### 4. Fix Outgoing Friend Requests (Line 66)

**File:** `src/routes/friends.js`

**Current Code (Lines 64-75):**
```javascript
router.get('/requests/outgoing', async (req, res) => {
  const r = await pool.query(
    `SELECT fr.id, fr.to_id, fr.created_at, u.username, u.display_name, u.avatar_data, u.avatar_mime
     FROM friend_requests fr JOIN users u ON u.id=fr.to_id
     WHERE fr.from_id=$1 AND fr.status='pending'`,
    [req.session.userId]
  );
  res.json({ requests: r.rows.map(r => ({
    id: r.id, toId: r.to_id, username: r.username, displayName: r.display_name,
    avatarDataUrl: r.avatar_data ? `data:${r.avatar_mime};base64,${r.avatar_data}` : null,
    createdAt: r.created_at
  }))});
});
```

**Fix:**
```javascript
router.get('/requests/outgoing', async (req, res) => {
  const r = await pool.query(
    `SELECT fr.id, fr.to_id, fr.created_at, u.username, u.display_name, u.avatar_data, u.avatar_mime, u.active_decoration
     FROM friend_requests fr JOIN users u ON u.id=fr.to_id
     WHERE fr.from_id=$1 AND fr.status='pending'`,
    [req.session.userId]
  );
  res.json({ requests: r.rows.map(r => ({
    id: r.id, toId: r.to_id, username: r.username, displayName: r.display_name,
    avatarDataUrl: r.avatar_data ? `data:${r.avatar_mime};base64,${r.avatar_data}` : null,
    createdAt: r.created_at,
    activeDecoration: r.active_decoration || null
  }))});
});
```

**Changes:**
- Line 66: Add `, u.active_decoration` at the end of SELECT
- Line 73: Add `, activeDecoration: r.active_decoration || null`

---

### 5. Fix User Profile (Line 34)

**File:** `src/routes/users.js`

**Current Code (Lines 32-43):**
```javascript
router.get('/profile/:userId', requireAuth, async (req, res) => {
  const r = await pool.query(
    'SELECT id, username, display_name, avatar_data, avatar_mime, bio FROM users WHERE id=$1',
    [req.params.userId]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  const u = r.rows[0];
  res.json({
    id: u.id, username: u.username, displayName: u.display_name,
    avatarDataUrl: u.avatar_data ? `data:${u.avatar_mime};base64,${u.avatar_data}` : null,
    bio: u.bio || null
  });
});
```

**Fix:**
```javascript
router.get('/profile/:userId', requireAuth, async (req, res) => {
  const r = await pool.query(
    'SELECT id, username, display_name, avatar_data, avatar_mime, bio, active_decoration FROM users WHERE id=$1',
    [req.params.userId]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  const u = r.rows[0];
  res.json({
    id: u.id, username: u.username, displayName: u.display_name,
    avatarDataUrl: u.avatar_data ? `data:${u.avatar_mime};base64,${u.avatar_data}` : null,
    bio: u.bio || null,
    activeDecoration: u.active_decoration || null
  });
});
```

**Changes:**
- Line 34: Add `, active_decoration` to SELECT
- Line 42: Add `, activeDecoration: u.active_decoration || null`

---

## File-by-File Changes

### src/routes/friends.js
4 changes needed (search, incoming, outgoing, get):

```javascript
// Line 13: Search endpoint
SELECT id, username, display_name, avatar_data, avatar_mime, active_decoration FROM users

// Line 19: Search response
activeDecoration: u.active_decoration || null

// Line 52: Incoming requests
SELECT fr.id, fr.from_id, fr.created_at, u.username, u.display_name, u.avatar_data, u.avatar_mime, u.active_decoration

// Line 59: Incoming response
activeDecoration: r.active_decoration || null

// Line 66: Outgoing requests
SELECT fr.id, fr.to_id, fr.created_at, u.username, u.display_name, u.avatar_data, u.avatar_mime, u.active_decoration

// Line 73: Outgoing response
activeDecoration: r.active_decoration || null

// Line 110: Friends list
SELECT u.id, u.username, u.display_name, u.avatar_data, u.avatar_mime, u.status, u.active_decoration

// Line 118: Friends list response
activeDecoration: u.active_decoration || null
```

### src/routes/users.js
1 change needed:

```javascript
// Line 34: Profile endpoint
SELECT id, username, display_name, avatar_data, avatar_mime, bio, active_decoration FROM users

// Line 42: Profile response
activeDecoration: u.active_decoration || null
```

---

## Testing After Fixes

After making these changes, test:

1. **Friend List:** View friend list sidebar - avatars should show decorations ✅
2. **Friend Search:** Search for a user - search results should show decorations ✅
3. **Incoming Requests:** View incoming friend requests - avatars should show decorations ✅
4. **Outgoing Requests:** View outgoing friend requests - avatars should show decorations ✅
5. **User Profile:** Click on a username to open profile - avatar should show decorations ✅
6. **DMs:** Verify DM messages still show decorations ✅ (should not be affected)
7. **Channels:** Verify channel messages still show decorations ✅ (should not be affected)

---

## No Frontend Changes Needed

The frontend code is already complete and correct. `renderAvatar()` is called in all the right places with the correct data structure. It just needs the `activeDecoration` field from the API responses.
