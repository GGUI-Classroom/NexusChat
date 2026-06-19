NexusChat local file client

Open NexusChat-OneFile.html directly in a browser to use NexusChat without running a local server and without needing the css/js folders.

You can also open index.html if you want the split-file version.

This folder is only the frontend. It connects to the Render backend set in:

  js/local-config.js

For NexusChat-OneFile.html, the Render URL is embedded inside that HTML file.

If your Render URL is different, edit js/local-config.js for the split-file version, or search for the same URL inside NexusChat-OneFile.html for the one-file version. Replace:

  https://nexus-chat-kzvx.onrender.com

with your real Render web service URL.

The Render backend still handles login, chat, shop packs, admin tools, and Supabase SQL.
Do not put any Supabase database password in these local files.
