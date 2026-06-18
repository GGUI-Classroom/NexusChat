NexusChat local file client

Open index.html directly in a browser to use NexusChat without running a local server.

This folder is only the frontend. It connects to the Render backend set in:

  js/local-config.js

If your Render URL is different, edit that file and replace:

  https://nexus-chat.onrender.com

with your real Render web service URL.

The Render backend still handles login, chat, shop packs, admin tools, and Supabase SQL.
Do not put any Supabase database password in these local files.
