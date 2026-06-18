# Nexus Chat

A Discord-style real-time chat app with voice calls, DMs, servers, shop items, achievements, and friend requests.
Built with Node.js, Express, Socket.io, PostgreSQL, and WebRTC.

## Features

- Account creation with avatar upload stored in PostgreSQL as base64
- Friend requests, direct messages, server channels, and realtime typing
- Voice calls via WebRTC peer-to-peer audio
- Online/offline presence
- Shop decorations, packs, colors, fonts, ringtones, and Nexals
- Optional Redis backplane for multi-instance realtime sync

## Use Supabase Free Tier SQL

Create a free Supabase project, copy the PostgreSQL URI connection string into `.env`, then run:

```bash
npm install
npm start
```

Open:

```text
http://localhost:3000
```

See [SUPABASE_SETUP.md](./SUPABASE_SETUP.md) for exact setup steps.

## Required Environment

```env
NODE_ENV=production
PORT=3000
SESSION_SECRET=make-this-a-long-random-string
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@db.YOUR_PROJECT_REF.supabase.co:5432/postgres
DATABASE_SSL=true
DATABASE_SSL_REJECT_UNAUTHORIZED=false
DB_POOL_MAX=5
REDIS_URL=
REQUIRE_REDIS=false
COOKIE_SECURE=false
TRUST_PROXY=
```

The app creates its PostgreSQL tables automatically on startup.

## Deploy The Web App

You can host the Node app on Render, Railway, Fly.io, a VPS, or any Node-capable host while using Supabase as the SQL database.

For Render:

1. Connect this GitHub repo as a Web Service.
2. Build command: `npm install`
3. Start command: `npm start`
4. Set the environment variables from the table above.
5. Set `COOKIE_SECURE=true` when the public URL uses HTTPS.
6. Set `TRUST_PROXY=1` when your host terminates HTTPS before Node.

## Redis

Redis is optional. Leave `REDIS_URL` blank for one running Node server.

Add Redis only if you run multiple app instances and need Socket.IO events and call state to sync across all instances.

## Security

- Do not commit `.env`.
- Do not post `DATABASE_URL`, `SESSION_SECRET`, or `REDIS_URL` publicly.
- Use the Supabase PostgreSQL connection string, not Supabase API keys.
- Keep `DATABASE_SSL=true` for Supabase.
