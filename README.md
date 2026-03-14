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

### 2. Push to GitHub
```bash
git init
git add .
git commit -m "init nexus chat"
# create a repo on github.com then:
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git branch -M main
git push -u origin main
```

### 3. Create the Web Service
- Render → **New → Web Service** → connect your repo
- Settings:
  - **Runtime**: Node
  - **Build Command**: `npm install`
  - **Start Command**: `npm start`
  - **Plan**: Free

### 4. Add Environment Variables
| Key | Value |
|-----|-------|
| `DATABASE_URL` | Internal DB URL from step 1 |
| `SESSION_SECRET` | Any long random string |
| `NODE_ENV` | `production` |

### 5. Deploy
Click **Create Web Service** — live in ~2 minutes.

## Notes
- Free tier: 512 MB RAM, no persistent disk needed (everything in PostgreSQL)
- Avatar uploads capped at 2 MB (stored as base64 in DB)
- App spins down after 15 min idle on free tier (~30s cold start)
- Voice calls use Google STUN servers — works for most home/mobile networks
