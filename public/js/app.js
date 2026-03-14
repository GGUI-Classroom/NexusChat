/* ===== NEXUS APP.JS ===== */
(function () {
  'use strict';

  // ---- State ----
  let currentUser = null;
  let socket = null;
  let activeView = 'friends';
  let activeDmUserId = null;
  let activeDmUser = null;
  let friends = [];
  let typingTimer = null;
  let isTyping = false;

  // Call state
  let callState = null; // { roomId, peerId, peerUser, peerConnection, localStream, timerInterval }
  let pendingCallData = null; // incoming call data before answering
  let ringtoneCtx = null;
  let ringtoneNodes = [];
  let isScreenSharing = false;
  let screenStream = null;
  let outgoingCallTo = null;
  let remoteScreenActive = false; // true when peer is sharing their screen

  // Server state
  let servers = [];
  let activeServerId = null;
  let activeChannelId = null;
  let activeServerData = null; // { server, channels, members }
  let channelTypingTimer = null;
  let isChannelTyping = false;

  // ---- Helpers ----
  const $ = id => document.getElementById(id);
  const qs = sel => document.querySelector(sel);

  function renderAvatar(el, user) {
    const url = user && user.avatarDataUrl;
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%';
      img.onerror = function() {
        el.textContent = (user.displayName || user.username || '?')[0].toUpperCase();
      };
      el.innerHTML = '';
      el.appendChild(img);
    } else {
      el.textContent = (user && (user.displayName || user.username) || '?')[0].toUpperCase();
    }
  }

  function toast(msg, type = 'info', duration = 3500) {
    const c = $('toast-container');
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(() => {
      t.style.animation = 'none';
      t.style.opacity = '0';
      t.style.transform = 'translateX(20px)';
      t.style.transition = '0.3s';
      setTimeout(() => t.remove(), 300);
    }, duration);
  }

  function showError(id, msg) {
    const el = $(id);
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('visible', !!msg);
  }

  function formatTime(ts) {
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function formatCallTimer(secs) {
    const m = Math.floor(secs / 60), s = secs % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  // ---- Auth ----
  async function api(method, path, data) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    };
    if (data) opts.body = JSON.stringify(data);
    try {
      const res = await fetch(path, opts);
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch (e) {
        console.error('Non-JSON response:', text);
        return { error: 'Server returned invalid response: ' + text.slice(0, 100) };
      }
    } catch (e) {
      console.error('Fetch error:', e);
      return { error: 'Network error: ' + e.message };
    }
  }

  async function checkAuth() {
    const r = await api('GET', '/api/auth/me');
    return r.user;
  }

  async function init() {
    const user = await checkAuth();
    if (user) {
      currentUser = user;
      enterApp();
    } else {
      showScreen('auth-screen');
    }
  }

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    $(id).classList.add('active');
  }

  // ---- Auth Form Handling ----
  $('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    showError('login-error', '');
    const btn = e.target.querySelector('button');
    btn.disabled = true; btn.textContent = 'Signing in…';
    const r = await api('POST', '/api/auth/login', {
      username: $('login-username').value.trim(),
      password: $('login-password').value
    });
    btn.disabled = false; btn.textContent = 'Sign In';
    if (r.error) return showError('login-error', r.error);
    if (!r.user) return showError('login-error', 'Unexpected response — check browser console');
    currentUser = r.user;
    enterApp();
  });

  $('register-form').addEventListener('submit', async e => {
    e.preventDefault();
    showError('register-error', '');
    const btn = e.target.querySelector('button');
    btn.disabled = true; btn.textContent = 'Creating account…';
    const r = await api('POST', '/api/auth/register', {
      username: $('reg-username').value.trim(),
      displayName: $('reg-displayname').value.trim(),
      password: $('reg-password').value
    });
    btn.disabled = false; btn.textContent = 'Create Account';
    if (r.error) return showError('register-error', r.error);
    if (!r.user) return showError('register-error', 'Unexpected response — check browser console');
    currentUser = r.user;
    enterApp();
  });

  // ---- App Entry ----
  function enterApp() {
    try {
      updateSelfCard();
      showScreen('main-screen');
      connectSocket();
      loadFriends();
      loadPendingRequests();
      loadServers();
      switchView('friends');
    } catch(e) {
      console.error('enterApp crash:', e);
      alert('Login succeeded but app failed to load: ' + e.message);
    }
  }

  function updateSelfCard() {
    if (!currentUser) return;
    $('self-display-name').textContent = currentUser.displayName;
    $('self-username').textContent = '@' + currentUser.username;
    const el = $('self-avatar-display');
    renderAvatar(el, currentUser);
  }

  // ---- Navigation ----
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      switchView(btn.dataset.view);
    });
  });

  // ---- Servers ----
  async function loadServers() {
    const r = await api('GET', '/api/servers');
    servers = r.servers || [];
    renderServerRail();
  }

  function renderServerRail() {
    const container = $('server-icons');
    container.innerHTML = servers.map(s => {
      const abbr = s.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
      return `<button class="rail-btn" data-server-id="${s.id}" title="${esc(s.name)}" onclick="railSelect('${s.id}')">
        ${s.iconDataUrl
          ? `<img src="${s.iconDataUrl}" alt="${esc(s.name)}">`
          : `<span class="rail-initial">${abbr}</span>`}
      </button>`;
    }).join('');
  }

  async function loadServerSidebar(serverId) {
    const r = await api('GET', `/api/servers/${serverId}`);
    if (r.error) return toast(r.error, 'error');
    activeServerId = serverId;
    activeServerData = r;

    $('server-sidebar-name').textContent = r.server.name;

    // Show settings + add-channel only for admin/owner
    const me = r.members.find(m => m.id === currentUser.id);
    const isAdmin = me && me.role === 'admin';
    $('server-settings-btn').style.display = isAdmin ? 'flex' : 'none';
    $('add-channel-btn').style.display = isAdmin ? 'flex' : 'none';

    renderChannelList(r.channels, isAdmin);
    renderMemberList(r.members);

    // Join socket room
    if (socket) socket.emit('join_server_room', { serverId });

    // Open first channel
    if (r.channels.length) openChannel(r.channels[0]);
  }

  function renderChannelList(channels, isAdmin) {
    $('channel-list').innerHTML = channels.map(c => `
      <div class="channel-item ${activeChannelId === c.id ? 'active' : ''}" data-channel-id="${c.id}" onclick="openChannel({id:'${c.id}',name:'${esc(c.name)}'})">
        <span class="ch-hash">#</span>
        <span class="ch-name">${esc(c.name)}</span>
        ${isAdmin ? `<button class="ch-delete" onclick="deleteChannel(event,'${c.id}')" title="Delete channel"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg></button>` : ''}
      </div>
    `).join('');
  }

  function renderMemberList(members) {
    $('server-member-list').innerHTML = members.map(m => `
      <div class="server-member-item">
        <div class="avatar-wrap" style="flex-shrink:0">
          <div class="avatar sm" id="smav-${m.id}"></div>
          <div class="status-dot ${m.status==='online'?'online':''}" style="border-color:var(--bg-surface)"></div>
        </div>
        <span class="member-name">${esc(m.displayName)}</span>
        ${m.role === 'admin' ? '<span class="member-role">Admin</span>' : ''}
      </div>
    `).join('');
    members.forEach(m => { const el = $(`smav-${m.id}`); if (el) renderAvatar(el, m); });
  }

  window.openChannel = function(channel) {
    activeChannelId = channel.id;
    // Update active state in sidebar
    document.querySelectorAll('.channel-item').forEach(el => {
      el.classList.toggle('active', el.dataset.channelId === channel.id);
    });
    $('channel-name-header').textContent = channel.name;
    $('channel-message-input').placeholder = 'Message #' + channel.name + '…';
    $('channel-placeholder').style.display = 'none';
    $('channel-container').style.display = 'flex';
    loadChannelMessages(channel.id);
    $('channel-message-input').focus();
  };

  window.deleteChannel = async function(e, channelId) {
    e.stopPropagation();
    if (!confirm('Delete this channel?')) return;
    const r = await api('DELETE', `/api/servers/${activeServerId}/channels/${channelId}`);
    if (r.error) return toast(r.error, 'error');
    const s = await api('GET', `/api/servers/${activeServerId}`);
    activeServerData = s;
    const me = s.members.find(m => m.id === currentUser.id);
    renderChannelList(s.channels, me && me.role === 'admin');
    if (activeChannelId === channelId) {
      activeChannelId = null;
      $('channel-placeholder').style.display = 'flex';
      $('channel-container').style.display = 'none';
    }
  };

  async function loadChannelMessages(channelId, prepend = false) {
    const list = $('channel-messages-list');
    const wrap = $('channel-messages-wrap');
    const oldest = list.querySelector('.message');
    const beforeTs = prepend && oldest ? oldest.dataset.ts : undefined;
    const url = `/api/servers/${activeServerId}/channels/${channelId}/messages${beforeTs?`?before=${beforeTs}`:''}`;
    const r = await api('GET', url);
    if (!r.messages) return;
    if (!prepend) {
      list.innerHTML = '';
      r.messages.forEach(m => appendChannelMessage(m, false));
      wrap.scrollTop = wrap.scrollHeight;
    } else {
      const prev = wrap.scrollHeight;
      r.messages.forEach(m => prependChannelMessage(m));
      wrap.scrollTop = wrap.scrollHeight - prev;
    }
  }

  $('channel-messages-wrap').addEventListener('scroll', function() {
    if (this.scrollTop < 80 && activeChannelId) loadChannelMessages(activeChannelId, true);
  });

  function appendChannelMessage(msg, scroll=true) {
    const list = $('channel-messages-list');
    const el = buildMessageEl(msg, list.lastElementChild);
    list.appendChild(el);
    if (scroll) $('channel-messages-wrap').scrollTop = $('channel-messages-wrap').scrollHeight;
  }

  function prependChannelMessage(msg) {
    const list = $('channel-messages-list');
    const el = buildMessageEl(msg, null);
    list.prepend(el);
  }

  // Channel message input
  $('channel-message-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChannelMessage(); }
  });
  $('channel-message-input').addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 150) + 'px';
    handleChannelTyping();
  });
  $('channel-send-btn').addEventListener('click', sendChannelMessage);

  function sendChannelMessage() {
    const input = $('channel-message-input');
    const content = input.value.trim();
    if (!content || !activeChannelId || !activeServerId || !socket) return;
    socket.emit('send_channel_message', { serverId: activeServerId, channelId: activeChannelId, content });
    input.value = '';
    input.style.height = 'auto';
    stopChannelTyping();
  }

  function handleChannelTyping() {
    if (!activeChannelId || !socket) return;
    if (!isChannelTyping) { isChannelTyping = true; socket.emit('channel_typing_start', { serverId: activeServerId, channelId: activeChannelId }); }
    clearTimeout(channelTypingTimer);
    channelTypingTimer = setTimeout(stopChannelTyping, 2000);
  }

  function stopChannelTyping() {
    if (isChannelTyping && activeChannelId && socket) { isChannelTyping = false; socket.emit('channel_typing_stop', { serverId: activeServerId, channelId: activeChannelId }); }
    clearTimeout(channelTypingTimer);
  }

  // ---- Add Channel ----
  $('add-channel-btn').addEventListener('click', async () => {
    const name = prompt('Channel name:');
    if (!name || !name.trim()) return;
    const r = await api('POST', `/api/servers/${activeServerId}/channels`, { name: name.trim() });
    if (r.error) return toast(r.error, 'error');
    const s = await api('GET', `/api/servers/${activeServerId}`);
    activeServerData = s;
    renderChannelList(s.channels, true);
    openChannel(r.channel);
  });

  // ---- Create / Join Server ----
  $('add-server-rail-btn').addEventListener('click', () => {
    $('server-modal').classList.add('active');
  });
  $('server-modal-close').addEventListener('click', () => $('server-modal').classList.remove('active'));
  $('server-modal').addEventListener('click', e => { if (e.target === $('server-modal')) $('server-modal').classList.remove('active'); });

  // Server icon preview
  $('server-icon-input').addEventListener('change', e => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      $('server-icon-preview').innerHTML = `<img src="${ev.target.result}" alt="">`;
    };
    reader.readAsDataURL(file);
  });

  $('create-server-btn').addEventListener('click', async () => {
    const name = $('server-name-input').value.trim();
    if (!name) return showError('create-server-error', 'Name required');
    const fd = new FormData();
    fd.append('name', name);
    const iconFile = $('server-icon-input').files[0];
    if (iconFile) fd.append('icon', iconFile);
    const res = await fetch('/api/servers', { method: 'POST', body: fd, credentials: 'include' });
    const r = await res.json();
    if (r.error) return showError('create-server-error', r.error);
    servers.push(r.server);
    renderServerRail();
    $('server-modal').classList.remove('active');
    $('server-name-input').value = '';
    $('server-icon-input').value = '';
    $('server-icon-preview').innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="28" height="28"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
    showError('create-server-error', '');
    railSelect(r.server.id);
    toast('Server created!', 'success');
  });

  $('join-server-btn').addEventListener('click', async () => {
    const code = $('join-code-input').value.trim();
    if (!code) return showError('join-server-error', 'Enter a code');
    const r = await api('POST', `/api/servers/join/${code}`);
    if (r.error) return showError('join-server-error', r.error);
    if (!servers.find(s => s.id === r.server.id)) servers.push(r.server);
    renderServerRail();
    $('server-modal').classList.remove('active');
    $('join-code-input').value = '';
    showError('join-server-error', '');
    railSelect(r.server.id);
    toast(r.alreadyMember ? 'Already a member!' : 'Joined server!', 'success');
  });

  // ---- Server Settings ----
  $('server-settings-btn').addEventListener('click', () => {
    if (!activeServerData) return;
    const s = activeServerData.server;
    $('settings-server-name').value = s.name;
    $('settings-invite-code').value = s.inviteCode;
    if (s.iconDataUrl) {
      $('settings-icon-preview').innerHTML = `<img src="${s.iconDataUrl}" alt="">`;
    } else {
      $('settings-icon-preview').textContent = s.name[0].toUpperCase();
    }
    $('server-settings-modal').classList.add('active');
  });
  $('server-settings-close').addEventListener('click', () => $('server-settings-modal').classList.remove('active'));
  $('server-settings-modal').addEventListener('click', e => { if (e.target === $('server-settings-modal')) $('server-settings-modal').classList.remove('active'); });

  $('settings-icon-input').addEventListener('change', e => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => { $('settings-icon-preview').innerHTML = `<img src="${ev.target.result}" alt="">`; };
    reader.readAsDataURL(file);
  });

  $('copy-invite-btn').addEventListener('click', () => {
    navigator.clipboard.writeText($('settings-invite-code').value);
    toast('Invite code copied!', 'success');
  });

  $('save-server-btn').addEventListener('click', async () => {
    const name = $('settings-server-name').value.trim();
    if (!name) return showError('settings-server-error', 'Name required');
    const fd = new FormData();
    fd.append('name', name);
    const iconFile = $('settings-icon-input').files[0];
    if (iconFile) fd.append('icon', iconFile);
    const res = await fetch(`/api/servers/${activeServerId}`, { method: 'PATCH', body: fd, credentials: 'include' });
    const r = await res.json();
    if (r.error) return showError('settings-server-error', r.error);
    // Update local state
    const idx = servers.findIndex(s => s.id === activeServerId);
    if (idx >= 0) servers[idx] = r.server;
    activeServerData.server = r.server;
    $('server-sidebar-name').textContent = r.server.name;
    renderServerRail();
    $('server-settings-modal').classList.remove('active');
    toast('Server updated!', 'success');
  });

  $('delete-server-btn').addEventListener('click', async () => {
    if (!confirm('Delete this server? This cannot be undone.')) return;
    const r = await api('DELETE', `/api/servers/${activeServerId}`);
    if (r.error) return toast(r.error, 'error');
    servers = servers.filter(s => s.id !== activeServerId);
    activeServerId = null; activeChannelId = null; activeServerData = null;
    renderServerRail();
    $('server-settings-modal').classList.remove('active');
    railSelect('dms');
    toast('Server deleted', 'info');
  });

  // ---- Invite Friends to Server ----
  $('invite-btn').addEventListener('click', () => {
    if (!activeServerData) return;
    $('modal-invite-code').value = activeServerData.server.inviteCode;
    // Show friends who aren't members
    const memberIds = new Set(activeServerData.members.map(m => m.id));
    const nonMembers = friends.filter(f => !memberIds.has(f.id));
    $('invite-friends-list').innerHTML = nonMembers.length
      ? nonMembers.map(f => `
          <div class="invite-friend-row">
            <div class="avatar" id="invav-${f.id}" style="width:32px;height:32px;font-size:13px;flex-shrink:0"></div>
            <div class="person-info"><div class="display-name" style="font-size:13px">${esc(f.displayName)}</div><div class="username">@${esc(f.username)}</div></div>
            <button class="action-btn primary" onclick="inviteFriend('${f.id}', this)">Invite</button>
          </div>`).join('')
      : '<p style="font-size:13px;color:var(--text-muted)">All your friends are already members!</p>';
    nonMembers.forEach(f => { const el = $(`invav-${f.id}`); if (el) renderAvatar(el, f); });
    $('invite-modal').classList.add('active');
  });
  $('invite-modal-close').addEventListener('click', () => $('invite-modal').classList.remove('active'));
  $('invite-modal').addEventListener('click', e => { if (e.target === $('invite-modal')) $('invite-modal').classList.remove('active'); });
  $('modal-copy-invite-btn').addEventListener('click', () => { navigator.clipboard.writeText($('modal-invite-code').value); toast('Copied!', 'success'); });

  window.inviteFriend = async function(userId, btn) {
    btn.disabled = true; btn.textContent = 'Inviting…';
    const r = await api('POST', `/api/servers/${activeServerId}/invite`, { userId });
    if (r.error) { toast(r.error, 'error'); btn.disabled = false; btn.textContent = 'Invite'; return; }
    btn.textContent = 'Invited!';
    // Refresh member list
    const s = await api('GET', `/api/servers/${activeServerId}`);
    activeServerData = s;
    renderMemberList(s.members);
    toast('Friend invited!', 'success');
  };

  function switchView(view) {
    activeView = view;
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const el = $('view-' + view);
    if (el) el.classList.add('active');
  }

  // Rail selection: 'dms' or a server id
  window.railSelect = function(id) {
    document.querySelectorAll('.rail-btn').forEach(b => b.classList.remove('active'));
    if (id === 'dms') {
      $('rail-dms').classList.add('active');
      $('sidebar-dms').style.display = 'flex';
      $('sidebar-server').style.display = 'none';
      activeServerId = null;
      activeChannelId = null;
      switchView('friends');
    } else {
      const btn = document.querySelector(`.rail-btn[data-server-id="${id}"]`);
      if (btn) btn.classList.add('active');
      $('sidebar-dms').style.display = 'none';
      $('sidebar-server').style.display = 'flex';
      loadServerSidebar(id);
      switchView('channel');
    }
  };

  // ---- Friends Tab ----
  document.querySelectorAll('.ftab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ftab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.ftab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $(`ftab-${btn.dataset.ftab}`).classList.add('active');
      if (btn.dataset.ftab === 'pending') loadPendingRequests();
    });
  });

  // ---- User Search ----
  let searchTimeout;
  $('user-search').addEventListener('input', e => {
    clearTimeout(searchTimeout);
    const q = e.target.value.trim();
    if (!q || q.length < 2) {
      $('search-results').style.display = 'none';
      return;
    }
    searchTimeout = setTimeout(() => searchUsers(q), 300);
  });

  async function searchUsers(q) {
    const r = await api('GET', `/api/friends/search?q=${encodeURIComponent(q)}`);
    const sr = $('search-results');
    if (!r.users || !r.users.length) {
      sr.style.display = 'none';
      return;
    }
    sr.style.display = 'block';
    sr.innerHTML = r.users.map(u => {
      const isFriend = friends.some(f => f.id === u.id);
      return `
        <div class="search-result-item">
          <div class="avatar-wrap">
            <div class="avatar" id="search-av-${u.id}"></div>
          </div>
          <div class="person-info">
            <div class="display-name">${esc(u.displayName)}</div>
            <div class="username">@${esc(u.username)}</div>
          </div>
          ${isFriend
            ? '<span class="action-btn ghost" style="cursor:default">Friends</span>'
            : `<button class="action-btn primary" onclick="sendFriendRequest('${u.id}',this)">Add Friend</button>`
          }
        </div>`;
    }).join('');
    r.users.forEach(u => {
      const av = $(`search-av-${u.id}`);
      if (av) renderAvatar(av, u);
    });
  }

  window.sendFriendRequest = async function (toId, btn) {
    btn.disabled = true; btn.textContent = 'Sending…';
    const r = await api('POST', '/api/friends/request', { toId });
    if (r.error) { toast(r.error, 'error'); btn.disabled = false; btn.textContent = 'Add Friend'; }
    else { btn.textContent = 'Requested'; toast('Friend request sent!', 'success'); }
  };

  // ---- Load Friends ----
  async function loadFriends() {
    const r = await api('GET', '/api/friends');
    friends = r.friends || [];
    renderFriendsList();
  }

  function renderFriendsList() {
    const list = $('friends-list');
    const empty = $('friends-empty');
    if (!friends.length) {
      list.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
    list.innerHTML = friends.map(f => `
      <div class="friend-card" data-id="${f.id}">
        <div class="avatar-wrap">
          <div class="avatar" id="fav-${f.id}"></div>
          <div class="status-dot ${f.status === 'online' ? 'online' : ''}" id="fdot-${f.id}"></div>
        </div>
        <div class="person-info">
          <div class="display-name">${esc(f.displayName)}</div>
          <div class="username">@${esc(f.username)}</div>
          <div class="status ${f.status === 'online' ? 'online' : ''}" id="fstatus-${f.id}">${f.status === 'online' ? '● Online' : '○ Offline'}</div>
        </div>
        <div class="card-actions">
          <button class="action-btn ghost" onclick="openDmWith('${f.id}')">Message</button>
          <button class="action-btn danger" onclick="removeFriend('${f.id}',this)">Remove</button>
        </div>
      </div>
    `).join('');
    friends.forEach(f => {
      const av = $(`fav-${f.id}`);
      if (av) renderAvatar(av, f);
    });
  }

  window.removeFriend = async function (id, btn) {
    if (!confirm('Remove this friend?')) return;
    btn.disabled = true;
    await api('DELETE', `/api/friends/${id}`);
    friends = friends.filter(f => f.id !== id);
    renderFriendsList();
    if (activeDmUserId === id) closeDm();
    toast('Friend removed', 'info');
  };

  window.openDmWith = function (id) {
    const user = friends.find(f => f.id === id);
    if (!user) return;
    railSelect('dms');
    switchView('dm');
    openDm(user);
  };

  // ---- Pending Requests ----
  async function loadPendingRequests() {
    const [inRes, outRes] = await Promise.all([
      api('GET', '/api/friends/requests/incoming'),
      api('GET', '/api/friends/requests/outgoing')
    ]);
    const incoming = inRes.requests || [];
    const outgoing = outRes.requests || [];
    const total = incoming.length;

    // Update badges
    const badge = $('requests-badge');
    badge.textContent = total;
    badge.style.display = total > 0 ? 'inline-block' : 'none';
    const pc = $('pending-count');
    pc.textContent = total || '';
    pc.style.display = total > 0 ? 'inline' : 'none';

    // Render incoming
    const inEl = $('incoming-requests');
    const inEmpty = $('incoming-empty');
    if (!incoming.length) { inEl.innerHTML = ''; inEmpty.style.display = 'block'; }
    else {
      inEmpty.style.display = 'none';
      inEl.innerHTML = incoming.map(r => `
        <div class="request-card">
          <div class="avatar-wrap"><div class="avatar" id="rav-${r.id}"></div></div>
          <div class="person-info">
            <div class="display-name">${esc(r.displayName)}</div>
            <div class="username">@${esc(r.username)}</div>
          </div>
          <div class="card-actions">
            <button class="action-btn success" onclick="respondRequest('${r.id}','accept',this)">Accept</button>
            <button class="action-btn danger" onclick="respondRequest('${r.id}','decline',this)">Decline</button>
          </div>
        </div>
      `).join('');
      incoming.forEach(r => { const av = $(`rav-${r.id}`); if (av) renderAvatar(av, r); });
    }

    // Render outgoing
    const outEl = $('outgoing-requests');
    const outEmpty = $('outgoing-empty');
    if (!outgoing.length) { outEl.innerHTML = ''; outEmpty.style.display = 'block'; }
    else {
      outEmpty.style.display = 'none';
      outEl.innerHTML = outgoing.map(r => `
        <div class="request-card">
          <div class="avatar-wrap"><div class="avatar" id="oav-${r.id}"></div></div>
          <div class="person-info">
            <div class="display-name">${esc(r.displayName)}</div>
            <div class="username">@${esc(r.username)}</div>
          </div>
          <span class="action-btn ghost" style="cursor:default">Pending…</span>
        </div>
      `).join('');
      outgoing.forEach(r => { const av = $(`oav-${r.id}`); if (av) renderAvatar(av, r); });
    }
  }

  window.respondRequest = async function (id, action, btn) {
    btn.disabled = true;
    const r = await api('POST', `/api/friends/request/${id}/respond`, { action });
    if (r.error) { toast(r.error, 'error'); btn.disabled = false; return; }
    if (action === 'accept') { toast('Friend added!', 'success'); loadFriends(); }
    else toast('Request declined', 'info');
    loadPendingRequests();
  };

  // ---- DM List ----
  function renderDmList() {
    const list = $('dm-list');
    if (!friends.length) { list.innerHTML = '<div style="padding:12px;font-size:12px;color:var(--text-muted)">No friends yet</div>'; return; }
    list.innerHTML = friends.map(f => `
      <div class="dm-item ${activeDmUserId === f.id ? 'active' : ''}" data-id="${f.id}" onclick="railSelect('dms');switchView('dm');openDm(window._friendsMap['${f.id}'])">
        <div class="avatar-wrap">
          <div class="avatar sm" id="dav-${f.id}"></div>
          <div class="status-dot ${f.status === 'online' ? 'online' : ''}" id="ddot-${f.id}"></div>
        </div>
        <div class="person-info">
          <div class="display-name">${esc(f.displayName)}</div>
          <div class="last-msg" id="dlm-${f.id}"></div>
        </div>
      </div>
    `).join('');
    friends.forEach(f => {
      const av = $(`dav-${f.id}`);
      if (av) renderAvatar(av, f);
    });
    // Make friends accessible globally for onclick
    window._friendsMap = {};
    friends.forEach(f => window._friendsMap[f.id] = f);
  }

  // ---- DM / Chat ----
  window.openDm = async function (user) {
    activeDmUserId = user.id;
    activeDmUser = user;

    // Update DM list active state
    document.querySelectorAll('.dm-item').forEach(el => el.classList.toggle('active', el.dataset.id === user.id));

    // Show chat container
    $('chat-placeholder').style.display = 'none';
    const cc = $('chat-container');
    cc.style.display = 'flex';

    // Set header
    renderAvatar($('chat-peer-avatar'), user);
    $('chat-peer-name').textContent = user.displayName;
    $('chat-peer-username').textContent = '@' + user.username;
    const statusDot = $('chat-peer-status');
    statusDot.className = `status-dot ${user.status === 'online' ? 'online' : ''}`;

    // Load messages
    await loadMessages(user.id);

    $('message-input').focus();
  };

  function closeDm() {
    activeDmUserId = null;
    activeDmUser = null;
    $('chat-placeholder').style.display = 'flex';
    $('chat-container').style.display = 'none';
  }

  async function loadMessages(userId, prepend = false) {
    const list = $('messages-list');
    const wrap = $('messages-wrap');
    const oldest = list.querySelector('.message');
    const beforeTs = prepend && oldest ? oldest.dataset.ts : undefined;
    const url = `/api/messages/${userId}${beforeTs ? `?before=${beforeTs}` : ''}`;
    const r = await api('GET', url);
    if (!r.messages) return;
    if (!prepend) {
      list.innerHTML = '';
      r.messages.forEach(m => appendMessage(m, false));
      wrap.scrollTop = wrap.scrollHeight;
    } else {
      const prevHeight = wrap.scrollHeight;
      r.messages.forEach(m => prependMessage(m));
      wrap.scrollTop = wrap.scrollHeight - prevHeight;
    }
  }

  function appendMessage(msg, scroll = true) {
    const list = $('messages-list');
    const el = buildMessageEl(msg, list.lastElementChild);
    list.appendChild(el);
    if (scroll) {
      const wrap = $('messages-wrap');
      wrap.scrollTop = wrap.scrollHeight;
    }
  }

  function prependMessage(msg) {
    const list = $('messages-list');
    const el = buildMessageEl(msg, null, list.firstElementChild);
    list.prepend(el);
  }

  function buildMessageEl(msg, prevEl) {
    const el = document.createElement('div');
    const prevTs = prevEl ? parseInt(prevEl.dataset.ts) : 0;
    const prevFrom = prevEl ? prevEl.dataset.from : '';
    const grouped = prevFrom === msg.fromId && (msg.createdAt - prevTs) < 300;
    el.className = `message${grouped ? ' grouped' : ''}`;
    el.dataset.ts = msg.createdAt;
    el.dataset.from = msg.fromId;
    el.dataset.id = msg.id;

    const isMe = msg.fromId === currentUser.id;
    const author = isMe
      ? { id: currentUser.id, displayName: currentUser.displayName, username: currentUser.username, avatarDataUrl: currentUser.avatarDataUrl }
      : msg.author;

    el.innerHTML = `
      <div class="avatar" id="mav-${msg.id}"></div>
      <div class="msg-body">
        <div class="msg-header">
          <span class="msg-author">${esc(author.displayName)}</span>
          <span class="msg-time">${formatTime(msg.createdAt)}</span>
        </div>
        <div class="msg-content">${esc(msg.content)}</div>
      </div>
    `;
    setTimeout(() => {
      const av = $(`mav-${msg.id}`);
      if (av) renderAvatar(av, author);
    }, 0);
    return el;
  }

  // Infinite scroll (load older)
  $('messages-wrap').addEventListener('scroll', function () {
    if (this.scrollTop < 80 && activeDmUserId) {
      loadMessages(activeDmUserId, true);
    }
  });

  // ---- Message Input ----
  $('message-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  $('message-input').addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 150) + 'px';
    handleTyping();
  });
  $('send-btn').addEventListener('click', sendMessage);

  function sendMessage() {
    const input = $('message-input');
    const content = input.value.trim();
    if (!content || !activeDmUserId || !socket) return;
    socket.emit('send_message', { toId: activeDmUserId, content });
    input.value = '';
    input.style.height = 'auto';
    stopTyping();
  }

  function handleTyping() {
    if (!activeDmUserId || !socket) return;
    if (!isTyping) { isTyping = true; socket.emit('typing_start', { toId: activeDmUserId }); }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(stopTyping, 2000);
  }

  function stopTyping() {
    if (isTyping && activeDmUserId && socket) { isTyping = false; socket.emit('typing_stop', { toId: activeDmUserId }); }
    clearTimeout(typingTimer);
  }

  // ---- Socket.io ----
  function connectSocket() {
    socket = io({ transports: ['websocket', 'polling'] });

    socket.on('connect', () => console.log('Socket connected'));
    socket.on('disconnect', () => console.log('Socket disconnected'));

    socket.on('new_message', msg => {
      // Update DM last message
      const dlm = $(`dlm-${msg.fromId === currentUser.id ? msg.toId : msg.fromId}`);
      if (dlm) dlm.textContent = msg.content.slice(0, 30) + (msg.content.length > 30 ? '…' : '');

      if (activeDmUserId && (msg.fromId === activeDmUserId || msg.toId === activeDmUserId)) {
        appendMessage(msg);
      } else if (msg.fromId !== currentUser.id) {
        const friend = friends.find(f => f.id === msg.fromId);
        toast(`${friend ? friend.displayName : 'Someone'}: ${msg.content.slice(0, 50)}`, 'info');
      }
    });

    socket.on('message_sent', msg => {
      if (activeDmUserId && (msg.fromId === activeDmUserId || msg.toId === activeDmUserId)) {
        appendMessage(msg);
      }
      const dlm = $(`dlm-${msg.toId}`);
      if (dlm) dlm.textContent = msg.content.slice(0, 30) + (msg.content.length > 30 ? '…' : '');
    });

    socket.on('user_typing', ({ fromId, username }) => {
      if (fromId === activeDmUserId) {
        $('typing-name').textContent = username;
        $('typing-indicator').style.display = 'flex';
        clearTimeout(window._typingHideTimer);
        window._typingHideTimer = setTimeout(() => $('typing-indicator').style.display = 'none', 3000);
      }
    });

    socket.on('user_stop_typing', ({ fromId }) => {
      if (fromId === activeDmUserId) $('typing-indicator').style.display = 'none';
    });

    socket.on('status_change', ({ userId, status }) => {
      const f = friends.find(f => f.id === userId);
      if (f) f.status = status;
      const dot = $(`fdot-${userId}`);
      if (dot) dot.className = `status-dot ${status === 'online' ? 'online' : ''}`;
      const fstatus = $(`fstatus-${userId}`);
      if (fstatus) { fstatus.textContent = status === 'online' ? '● Online' : '○ Offline'; fstatus.className = `status ${status === 'online' ? 'online' : ''}`; }
      const ddot = $(`ddot-${userId}`);
      if (ddot) ddot.className = `status-dot ${status === 'online' ? 'online' : ''}`;
      if (activeDmUserId === userId) {
        const dot2 = $('chat-peer-status');
        if (dot2) dot2.className = `status-dot ${status === 'online' ? 'online' : ''}`;
      }
    });

    // ---- CALL EVENTS ----
    socket.on('incoming_call', ({ roomId, fromId, caller }) => {
      if (callState) {
        socket.emit('call_decline', { roomId, toId: fromId });
        return;
      }
      pendingCallData = { roomId, fromId, caller };
      $('incoming-caller-name').textContent = caller.displayName;
      renderAvatar($('incoming-caller-avatar'), { id: fromId, ...caller });
      $('incoming-call-modal').classList.add('active');
      playRingtone(true); // incoming — pulsing tone
    });

    socket.on('call_ringing', ({ roomId, toId }) => {
      playRingtone(false); // outgoing — gentle beep
    });

    socket.on('call_accepted', async ({ roomId, byId }) => {
      stopRingtone();
      outgoingCallTo = null;
      const friend = friends.find(f => f.id === byId);
      if (!friend) return;
      await startWebRTCCall(roomId, byId, friend, true);
    });

    socket.on('call_declined', () => {
      stopRingtone();
      outgoingCallTo = null;
      $('call-hud').style.display = 'none';
      $('call-timer').textContent = '0:00';
      toast('Call declined', 'info');
      callState = null;
    });

    socket.on('call_cancelled', () => {
      stopRingtone();
      $('incoming-call-modal').classList.remove('active');
      pendingCallData = null;
      toast('Caller hung up', 'info');
    });

    socket.on('call_busy', () => toast('User is in another call', 'error'));

    socket.on('peer_joined', ({ userId }) => {});

    socket.on('webrtc_offer', async ({ roomId, fromId, offer }) => {
      if (!callState || callState.roomId !== roomId) return;
      const pc = callState.peerConnection;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('webrtc_answer', { roomId, toId: fromId, answer });
      } catch(e) {
        console.error('offer handling error:', e);
      }
    });

    socket.on('webrtc_answer', async ({ answer }) => {
      if (!callState || !callState.peerConnection) return;
      await callState.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    });

    socket.on('webrtc_ice', async ({ candidate }) => {
      if (!callState || !callState.peerConnection) return;
      try { await callState.peerConnection.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}
    });

    socket.on('call_ended', ({ roomId }) => {
      if (callState && callState.roomId === roomId) endCallLocal();
    });

    socket.on('new_channel_message', msg => {
      if (msg.channelId === activeChannelId) {
        appendChannelMessage(msg);
      } else if (msg.serverId) {
        // Could show unread badge — for now just a subtle toast
        const s = servers.find(sv => sv.id === msg.serverId);
        // Only notify if not currently viewing that server
        if (msg.serverId !== activeServerId) {
          // silent — just mark could be added later
        }
      }
    });

    socket.on('channel_user_typing', ({ channelId, userId: uid, username }) => {
      if (channelId === activeChannelId && uid !== currentUser.id) {
        $('channel-typing-name').textContent = username;
        $('channel-typing-indicator').style.display = 'flex';
        clearTimeout(window._chTypingTimer);
        window._chTypingTimer = setTimeout(() => $('channel-typing-indicator').style.display = 'none', 3000);
      }
    });

    socket.on('channel_user_stop_typing', ({ channelId }) => {
      if (channelId === activeChannelId) $('channel-typing-indicator').style.display = 'none';
    });

    socket.on('screenshare_started', ({ fromId }) => {
      // The ontrack handler deals with showing the video; this is just for notification
      const peer = callState && callState.peerUser;
      toast((peer ? peer.displayName : 'Peer') + ' started screen sharing', 'info');
    });

    socket.on('screenshare_stopped', () => {
      remoteScreenActive = false;
      $('screenshare-overlay').style.display = 'none';
      $('screenshare-video').srcObject = null;
      $('view-screen-btn').style.display = 'none';
      $('view-screen-btn').classList.remove('viewing');
      toast('Screen share ended', 'info');
    });
  }

  // ---- Voice Calls ----
  $('start-call-btn').addEventListener('click', () => {
    if (!activeDmUserId) return;
    if (callState || outgoingCallTo) return toast('Already in a call', 'error');
    outgoingCallTo = activeDmUserId;
    socket.emit('call_invite', { toId: activeDmUserId });
    const friend = friends.find(f => f.id === activeDmUserId);
    if (friend) showCallHud(friend, false);
  });

  $('accept-call-btn').addEventListener('click', async () => {
    if (!pendingCallData) return;
    stopRingtone();
    const { roomId, fromId, caller } = pendingCallData;
    $('incoming-call-modal').classList.remove('active');
    socket.emit('call_accept', { roomId, toId: fromId });
    const friend = friends.find(f => f.id === fromId) || { id: fromId, ...caller };
    await startWebRTCCall(roomId, fromId, friend, false);
    pendingCallData = null;
  });

  $('decline-call-btn').addEventListener('click', () => {
    if (!pendingCallData) return;
    stopRingtone();
    socket.emit('call_decline', { roomId: pendingCallData.roomId, toId: pendingCallData.fromId });
    $('incoming-call-modal').classList.remove('active');
    pendingCallData = null;
  });

  $('end-call-btn').addEventListener('click', () => {
    if (callState) {
      socket.emit('call_end', { roomId: callState.roomId });
      endCallLocal();
    } else if (outgoingCallTo) {
      // Still ringing — cancel it
      socket.emit('call_cancel', { toId: outgoingCallTo });
      outgoingCallTo = null;
      stopRingtone();
      $('call-hud').style.display = 'none';
      $('call-timer').textContent = '0:00';
    }
  });

  $('mute-btn').addEventListener('click', () => {
    if (!callState || !callState.localStream) return;
    const track = callState.localStream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    $('mute-btn').classList.toggle('muted', !track.enabled);
  });

  $('screenshare-btn').addEventListener('click', async () => {
    if (!callState) return;
    if (isScreenSharing) {
      stopScreenShare();
    } else {
      await startScreenShare();
    }
  });

  $('screenshare-close').addEventListener('click', () => {
    $('screenshare-overlay').style.display = 'none';
    // Show the view button so they can reopen
    if (isScreenSharing || remoteScreenActive) {
      $('view-screen-btn').style.display = 'flex';
      $('view-screen-btn').classList.add('viewing');
    }
  });

  $('view-screen-btn').addEventListener('click', () => {
    $('screenshare-overlay').style.display = 'flex';
    $('view-screen-btn').classList.remove('viewing');
    // don't hide it — keep it so they can close/reopen again
  });

  async function startScreenShare() {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const screenTrack = screenStream.getVideoTracks()[0];

      const pc = callState.peerConnection;
      const senders = pc.getSenders();
      const videoSender = senders.find(s => s.track && s.track.kind === 'video');
      if (videoSender) {
        await videoSender.replaceTrack(screenTrack);
      } else {
        pc.addTrack(screenTrack, screenStream);
      }

      // Renegotiate so the peer actually receives the new video track
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('webrtc_offer', { roomId: callState.roomId, toId: callState.peerId, offer });

      isScreenSharing = true;
      $('screenshare-btn').classList.add('sharing');
      $('screenshare-btn').title = 'Stop sharing';

      // Show own preview (muted to avoid feedback)
      $('screenshare-who').textContent = 'You are sharing your screen';
      const vid = $('screenshare-video');
      vid.srcObject = screenStream;
      vid.muted = true;
      $('screenshare-overlay').style.display = 'flex';
      $('view-screen-btn').style.display = 'flex';

      socket.emit('screenshare_started', { roomId: callState.roomId, toId: callState.peerId });

      screenTrack.onended = () => stopScreenShare();

    } catch (e) {
      if (e.name !== 'NotAllowedError') {
        toast('Could not start screen share', 'error');
      }
    }
  }

  async function stopScreenShare() {
    if (screenStream) {
      screenStream.getTracks().forEach(t => t.stop());
      screenStream = null;
    }
    if (callState) {
      const pc = callState.peerConnection;
      const senders = pc.getSenders();
      const videoSender = senders.find(s => s.track && s.track.kind === 'video');
      if (videoSender) {
        pc.removeTrack(videoSender);
        // Renegotiate after removing track
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('webrtc_offer', { roomId: callState.roomId, toId: callState.peerId, offer });
        } catch(e) {}
      }
      socket.emit('screenshare_stopped', { roomId: callState.roomId, toId: callState.peerId });
    }
    isScreenSharing = false;
    $('screenshare-btn').classList.remove('sharing');
    $('screenshare-btn').title = 'Share screen';
    $('screenshare-overlay').style.display = 'none';
    $('screenshare-video').srcObject = null;
    $('view-screen-btn').style.display = 'none';
    $('view-screen-btn').classList.remove('viewing');
  }

  // ---- Ringtone (Web Audio API) ----
  function playRingtone(isIncoming) {
    stopRingtone();
    try {
      ringtoneCtx = new (window.AudioContext || window.webkitAudioContext)();
      let beat = 0;
      // Discord-inspired: two-tone rising beep pattern
      const schedule = isIncoming
        ? [{ f: 660, t: 0, d: 0.15 }, { f: 880, t: 0.2, d: 0.15 }, { f: 0, t: 0.5, d: 0 }] // incoming: repeating
        : [{ f: 520, t: 0, d: 0.1 }, { f: 0, t: 0.6, d: 0 }]; // outgoing: gentle pulse

      function playPattern() {
        if (!ringtoneCtx) return;
        schedule.forEach(({ f, t, d }) => {
          if (!f) return;
          const osc = ringtoneCtx.createOscillator();
          const gain = ringtoneCtx.createGain();
          osc.connect(gain);
          gain.connect(ringtoneCtx.destination);
          osc.type = 'sine';
          osc.frequency.setValueAtTime(f, ringtoneCtx.currentTime + t);
          gain.gain.setValueAtTime(0, ringtoneCtx.currentTime + t);
          gain.gain.linearRampToValueAtTime(0.18, ringtoneCtx.currentTime + t + 0.01);
          gain.gain.linearRampToValueAtTime(0, ringtoneCtx.currentTime + t + d);
          osc.start(ringtoneCtx.currentTime + t);
          osc.stop(ringtoneCtx.currentTime + t + d + 0.05);
          ringtoneNodes.push(osc);
        });
        const interval = isIncoming ? 1000 : 1200;
        ringtoneNodes.push(setTimeout(playPattern, interval));
      }
      playPattern();
    } catch(e) {
      console.warn('Ringtone error:', e);
    }
  }

  function stopRingtone() {
    ringtoneNodes.forEach(n => {
      try {
        if (typeof n === 'number') clearTimeout(n);
        else n.stop();
      } catch(e) {}
    });
    ringtoneNodes = [];
    if (ringtoneCtx) {
      try { ringtoneCtx.close(); } catch(e) {}
      ringtoneCtx = null;
    }
  }

  async function startWebRTCCall(roomId, peerId, peerUser, isCaller) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]
      });

      stream.getTracks().forEach(t => pc.addTrack(t, stream));

      pc.ontrack = e => {
        const track = e.track;
        if (track.kind === 'audio') {
          const audio = document.createElement('audio');
          audio.autoplay = true;
          audio.srcObject = e.streams[0];
          document.body.appendChild(audio);
          if (callState) callState.remoteAudio = audio;
        } else if (track.kind === 'video') {
          // Remote screen share incoming
          remoteScreenActive = true;
          const peerName = callState && callState.peerUser ? callState.peerUser.displayName : 'Peer';
          $('screenshare-who').textContent = peerName + ' is sharing their screen';
          const vid = $('screenshare-video');
          vid.srcObject = e.streams[0];
          vid.muted = false;
          $('screenshare-overlay').style.display = 'flex';
          $('view-screen-btn').style.display = 'flex';
          $('view-screen-btn').classList.add('viewing');
          toast((peerName) + ' is sharing their screen — click 👁 to view', 'info', 5000);
          track.onended = () => {
            remoteScreenActive = false;
            $('screenshare-overlay').style.display = 'none';
            vid.srcObject = null;
            $('view-screen-btn').style.display = 'none';
            $('view-screen-btn').classList.remove('viewing');
          };
        }
      };

      pc.onicecandidate = e => {
        if (e.candidate) {
          socket.emit('webrtc_ice', { roomId, toId: peerId, candidate: e.candidate });
        }
      };

      pc.onconnectionstatechange = () => {
        const hud = $('hud-status');
        if (!hud) return;
        if (pc.connectionState === 'connected') hud.textContent = 'Connected';
        else if (pc.connectionState === 'connecting') hud.textContent = 'Connecting…';
        else if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
          hud.textContent = 'Disconnected';
        }
      };

      callState = { roomId, peerId, peerUser, peerConnection: pc, localStream: stream };

      socket.emit('join_call', { roomId });

      if (isCaller) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('webrtc_offer', { roomId, toId: peerId, offer });
      }

      showCallHud(peerUser, true);
    } catch (e) {
      console.error('WebRTC error:', e);
      toast('Could not access microphone', 'error');
    }
  }

  function showCallHud(peerUser, connected) {
    renderAvatar($('hud-peer-avatar'), peerUser);
    $('hud-peer-name').textContent = peerUser.displayName;
    $('hud-status').textContent = connected ? 'Connecting…' : 'Calling…';
    $('call-hud').style.display = 'block';

    // Timer
    let secs = 0;
    if (callState) {
      clearInterval(callState.timerInterval);
      callState.timerInterval = setInterval(() => {
        secs++;
        $('call-timer').textContent = formatCallTimer(secs);
      }, 1000);
    }
  }

  function endCallLocal() {
    stopRingtone();
    if (isScreenSharing) stopScreenShare();
    if (callState) {
      clearInterval(callState.timerInterval);
      if (callState.peerConnection) callState.peerConnection.close();
      if (callState.localStream) callState.localStream.getTracks().forEach(t => t.stop());
      if (callState.remoteAudio) callState.remoteAudio.remove();
      callState = null;
    }
    $('call-hud').style.display = 'none';
    $('call-timer').textContent = '0:00';
    $('screenshare-overlay').style.display = 'none';
    $('screenshare-video').srcObject = null;
    isScreenSharing = false;
    remoteScreenActive = false;
    $('screenshare-btn').classList.remove('sharing');
    $('view-screen-btn').style.display = 'none';
    $('view-screen-btn').classList.remove('viewing');
  }

  // ---- Profile ----
  $('profile-btn').addEventListener('click', () => {
    $('profile-display-name').value = currentUser.displayName;
    renderAvatar($('profile-avatar-preview'), currentUser);
    $('profile-modal').classList.add('active');
  });
  $('profile-modal-close').addEventListener('click', () => $('profile-modal').classList.remove('active'));
  $('profile-modal').addEventListener('click', e => { if (e.target === $('profile-modal')) $('profile-modal').classList.remove('active'); });

  $('avatar-file-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('avatar', file);
    const res = await fetch('/api/users/avatar', { method: 'POST', body: fd, credentials: 'same-origin' });
    const r = await res.json();
    if (r.error) return toast(r.error, 'error');
    currentUser.avatarDataUrl = r.avatarDataUrl;
    $('profile-avatar-preview').innerHTML = `<img src="${r.avatarDataUrl}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    updateSelfCard();
    toast('Avatar updated!', 'success');
  });

  $('save-profile-btn').addEventListener('click', async () => {
    const name = $('profile-display-name').value.trim();
    if (!name) return showError('profile-error', 'Display name required');
    const r = await api('PATCH', '/api/users/profile', { displayName: name });
    if (r.error) return showError('profile-error', r.error);
    currentUser.displayName = name;
    updateSelfCard();
    $('profile-modal').classList.remove('active');
    toast('Profile updated!', 'success');
    renderFriendsList();
  });

  // ---- Logout ----
  $('logout-btn').addEventListener('click', async () => {
    if (!confirm('Sign out?')) return;
    await api('POST', '/api/auth/logout');
    if (socket) socket.disconnect();
    currentUser = null; socket = null; friends = [];
    activeDmUserId = null; activeDmUser = null;
    endCallLocal();
    showScreen('auth-screen');
  });

  // ---- Escape helper ----
  function esc(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---- Start ----
  init();
})();
