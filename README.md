# Nexus Chat

A Discord-style real-time chat app with voice calls, DMs, and friend requests.
Built with Node.js, Express, Socket.io, PostgreSQL, and WebRTC.

## Features
- Account creation with avatar upload (stored in PostgreSQL as base64)
- Friend request system (send / accept / decline)
- Real-time direct messages with typing indicators
- Voice calls via WebRTC peer-to-peer audio
- Online/offline presence
- Dark themed UI
- Multi-instance realtime sync (messages + call signaling) via Redis backplane

## Local Development

You need a local PostgreSQL instance, then:

```bash
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/nexus npm run dev
# Open http://localhost:3000
```

## Deploy to Render (Free Tier) — Web Service

### 1. Create a free PostgreSQL database
- Render dashboard → **New → PostgreSQL**
- Name: `nexus-db` | Plan: **Free** | Click **Create**
- Copy the **Internal Database URL** once provisioned

### 2. Create a shared Redis service
- Render dashboard → **New → Redis**
- Name: `nexus-redis` | Plan: **Free** | Click **Create**
- Copy the **Internal Redis URL**

### 3. Push to GitHub
```bash
git init
git add .
git commit -m "init nexus chat"
# create a repo on github.com then:
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git branch -M main
git push -u origin main
```

### 4. Create the Web Service
- Render → **New → Web Service** → connect your repo
- Settings:
  - **Runtime**: Node
  - **Build Command**: `npm install`
  - **Start Command**: `npm start`
  - **Plan**: Free

### 5. Add Environment Variables
| Key | Value |
|-----|-------|
| `DATABASE_URL` | Internal DB URL from step 1 |
| `REDIS_URL` | Internal Redis URL from step 2 |
| `SESSION_SECRET` | Any long random string |
| `NODE_ENV` | `production` |

### 6. Deploy
Click **Create Web Service** — live in ~2 minutes.

## Multi-Webservice Interconnection (Render Clones)
- Every cloned web service must use the same `DATABASE_URL` and the same `REDIS_URL`.
- Redis is required for cross-instance Socket.IO fanout and call state sync.
- If `REDIS_URL` is missing, realtime works only inside a single web service instance.

## Shared Backend Across Render And Other Hosts
- Yes, this project can be cloned and deployed anywhere while using one shared backend.
- Requirement: every deployment (Render, Railway, Fly.io, VPS, etc.) must use the same `DATABASE_URL` and `REDIS_URL` values.
- Keep `SESSION_SECRET` private, but it can be different per deployment unless you need cross-domain session portability.

### Fast Setup For People Cloning
1. Create one managed PostgreSQL and one managed Redis service.
2. Keep these URLs in a password manager or secret manager.
3. In each deployment platform, set the same values for:
  - `DATABASE_URL`
  - `REDIS_URL`
4. Set a unique `SESSION_SECRET` for each deployment unless you intentionally need shared cookie validation.
5. Deploy.

### Security For Sharing URLs
- Do not post `DATABASE_URL` or `REDIS_URL` publicly (GitHub, screenshots, chat logs, client-side code).
- Share them only with trusted collaborators who are actually deploying a backend.
- Treat both as secrets because they grant direct backend access.
- Prefer creating separate credentials per collaborator/platform when your provider supports it, so access can be rotated/revoked safely.

### Why This Works
- PostgreSQL stores durable app data (users, messages, servers).
- Redis is the realtime backplane for Socket.IO, so events and call state sync across instances and hosts.
- With shared URLs, each clone is just another stateless app node connected to the same data and realtime bus.

### Clone-Friendly Files
- `render.yaml` includes `DATABASE_URL` and `REDIS_URL` as required sync-false environment variables.
- `.env.example` shows the minimum environment keys for local and non-Render hosts.

## Notes
- Free tier: 512 MB RAM, no persistent disk needed (everything in PostgreSQL)
- Avatar uploads capped at 2 MB (stored as base64 in DB)
- App spins down after 15 min idle on free tier (~30s cold start)
- Voice calls use Google STUN servers — works for most home/mobile networks
