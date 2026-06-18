# Use Supabase PostgreSQL

Nexus Chat can use Supabase free tier PostgreSQL as its database. The app still runs as a Node server; Supabase only provides the SQL database.

## 1. Create a Supabase project

1. Go to Supabase.
2. Create a new project.
3. Save your database password somewhere private.

## 2. Copy the database URL

In Supabase:

1. Open your project.
2. Go to **Project Settings**.
3. Go to **Database**.
4. Find **Connection string**.
5. Choose the URI format.
6. Replace `[YOUR-PASSWORD]` with your real database password.

It will look like:

```env
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@db.YOUR_PROJECT_REF.supabase.co:5432/postgres
```

## 3. Configure `.env`

Copy `.env.example` to `.env`, then fill in your Supabase URL:

```env
NODE_ENV=development
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

## 4. Run the app

```bash
npm install
npm start
```

Open:

```text
http://localhost:3000
```

The app creates its required tables automatically on startup.

## Notes

- Do not use Supabase API keys in `DATABASE_URL`; use the PostgreSQL connection string.
- Keep `DATABASE_SSL=true` for Supabase.
- `DB_POOL_MAX=5` keeps the app friendlier to free-tier connection limits.
- Redis is optional for one running Node server. Add `REDIS_URL` later only if you run multiple app instances.
