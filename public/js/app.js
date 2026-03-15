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
      loadServerInvites();
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

  async function loadServerInvites() {
    const r = await api('GET', '/api/servers/invites/pending');
    const invites = r.invites || [];
    const container = $('server-invites-list');
    const label = $('invites-section-label');
    const badge = $('rail-invite-badge');
    if (!invites.length) {
      container.innerHTML = '';
      label.style.display = 'none';
      badge.style.display = 'none';
      return;
    }
    label.style.display = 'block';
    $('invite-badge-count').textContent = invites.length;
    badge.style.display = 'flex';
    badge.textContent = invites.length;
    container.innerHTML = invites.map(inv => `
      <div class="server-invite-item" id="inv-${inv.id}">
        <div class="inv-server-name">${esc(inv.serverName)}</div>
        <div class="inv-from">Invited by ${esc(inv.from.displayName)}</div>
        <div class="inv-actions">
          <button class="inv-accept" onclick="respondServerInvite('${inv.id}','accept','${inv.serverId}')">Accept</button>
          <button class="inv-decline" onclick="respondServerInvite('${inv.id}','decline','${inv.serverId}')">Decline</button>
        </div>
      </div>
    `).join('');
  }

  window.respondServerInvite = async function(inviteId, action, serverId) {
    const r = await api('POST', `/api/servers/invites/${inviteId}/respond`, { action });
    if (r.error) return toast(r.error, 'error');
    if (action === 'accept' && r.server) {
      if (!servers.find(s => s.id === r.server.id)) servers.push(r.server);
      renderServerRail();
      toast('Joined server!', 'success');
    } else {
      toast('Invite declined', 'info');
    }
    loadServerInvites();
  };

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
      <div class="channel-item ${activeChannelId === c.id ? 'active' : ''} ${c.locked ? 'locked' : ''}"
           data-channel-id="${c.id}"
           data-channel-name="${esc(c.name)}"
           data-channel-locked="${c.locked ? '1' : '0'}">
        <span class="ch-hash">${c.locked ? '🔒' : '#'}</span>
        <span class="ch-name">${esc(c.name)}</span>
        ${isAdmin ? `
          <button class="ch-perms" data-ch-id="${c.id}" data-ch-name="${esc(c.name)}" title="Permissions">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>
          </button>
          <button class="ch-delete" data-ch-id="${c.id}" title="Delete channel">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          </button>` : ''}
      </div>
    `).join('');

    // Attach click handlers after rendering (safe, no inline data injection)
    $('channel-list').querySelectorAll('.channel-item').forEach(el => {
      el.addEventListener('click', () => {
        const chId = el.dataset.channelId;
        const chName = el.dataset.channelName;
        const locked = el.dataset.channelLocked === '1';
        openChannel({ id: chId, name: chName, locked });
      });
    });
    $('channel-list').querySelectorAll('.ch-perms').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        openChannelPerms(e, btn.dataset.chId, btn.dataset.chName);
      });
    });
    $('channel-list').querySelectorAll('.ch-delete').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        deleteChannel(e, btn.dataset.chId);
      });
    });
  }

  function renderMemberList(members) {
    const me = members.find(m => m.id === currentUser.id);
    const iAmAdmin = me && (me.role === 'admin' || me.isAdmin);
    const server = activeServerData && activeServerData.server;
    const ownerId = server && server.ownerId;

    $('server-member-list').innerHTML = members.map(m => {
      const isOwner = m.id === ownerId;
      const roleStyle = m.roleColor ? `color:${m.roleColor}` : '';
      const canManage = iAmAdmin && m.id !== currentUser.id && !isOwner;
      const popupData = encodeURIComponent(JSON.stringify({
        id: m.id, displayName: m.displayName, username: m.username,
        avatarDataUrl: m.avatarDataUrl || null, status: m.status,
        roleName: m.roleName || null, roleColor: m.roleColor || null
      }));
      return `
        <div class="server-member-item" onclick="showProfilePopup(event, '${popupData}')">
          <div class="avatar-wrap" style="flex-shrink:0">
            <div class="avatar sm" id="smav-${m.id}"></div>
            <div class="status-dot ${m.status==='online'?'online':''}" style="border-color:var(--bg-surface)"></div>
          </div>
          <span class="member-name" style="${roleStyle}">${esc(m.displayName)}</span>
          ${isOwner ? '<span class="member-role" style="color:var(--yellow)">Owner</span>' : (m.roleName ? `<span class="member-role" style="color:${m.roleColor||'var(--accent)'}">${esc(m.roleName)}</span>` : '')}
          ${canManage ? `<div class="member-actions">
            <button class="member-action-btn role" onclick="openAssignRole('${m.id}','${esc(m.displayName)}')">Role</button>
            <button class="member-action-btn kick" onclick="kickMember('${m.id}','${esc(m.displayName)}')">Kick</button>
            <button class="member-action-btn ban" onclick="banMember('${m.id}','${esc(m.displayName)}')">Ban</button>
          </div>` : ''}
        </div>`;
    }).join('');
    members.forEach(m => { const el = $(`smav-${m.id}`); if (el) renderAvatar(el, m); });
  }

  // ---- Kick / Ban ----
  window.kickMember = async function(userId, name) {
    if (!confirm(`Kick ${name} from the server?`)) return;
    const r = await api('POST', `/api/servers/${activeServerId}/kick/${userId}`);
    if (r.error) return toast(r.error, 'error');
    toast(`${name} was kicked`, 'info');
    const s = await api('GET', `/api/servers/${activeServerId}`);
    activeServerData = s;
    renderMemberList(s.members);
  };

  window.banMember = async function(userId, name) {
    const reason = prompt(`Reason for banning ${name}? (optional)`);
    if (reason === null) return; // cancelled
    const r = await api('POST', `/api/servers/${activeServerId}/ban/${userId}`, { reason });
    if (r.error) return toast(r.error, 'error');
    toast(`${name} was banned`, 'info');
    const s = await api('GET', `/api/servers/${activeServerId}`);
    activeServerData = s;
    renderMemberList(s.members);
  };

  // ---- Assign Role ----
  window.openAssignRole = async function(userId, name) {
    if (!activeServerData) return;
    const roles = activeServerData.roles || [];
    const roleNames = roles.map((r, i) => String(i+1) + '. ' + r.name + (r.isAdmin?' (Admin)':'')).join('\n');
    const choice = prompt('Assign role to ' + name + ':\n' + roleNames + '\n\nType role name exactly (or leave blank to remove role):');
    if (choice === null) return;
    const matched = roles.find(r => r.name.toLowerCase() === choice.toLowerCase().trim());
    const roleId = matched ? matched.id : null;
    if (choice.trim() && !matched) return toast('Role not found', 'error');
    const r = await api('PATCH', `/api/servers/${activeServerId}/members/${userId}/role`, { roleId });
    if (r.error) return toast(r.error, 'error');
    toast('Role updated!', 'success');
    const s = await api('GET', `/api/servers/${activeServerId}`);
    activeServerData = s;
    renderMemberList(s.members);
  };

  window.openChannel = function(channel) {
    // Clear messages immediately before switching so old messages never bleed through
    $('channel-messages-list').innerHTML = '';
    $('channel-typing-indicator').style.display = 'none';
    chLoadingOlder = false;

    activeChannelId = channel.id;

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
    if (prepend && chLoadingOlder) return;
    if (prepend) chLoadingOlder = true;

    const list = $('channel-messages-list');
    const wrap = $('channel-messages-wrap');
    const oldest = list.querySelector('.message');
    const beforeTs = prepend && oldest ? oldest.dataset.ts : undefined;
    const url = `/api/servers/${activeServerId}/channels/${channelId}/messages${beforeTs?`?before=${beforeTs}`:''}`;
    const r = await api('GET', url);
    if (!r.messages || !r.messages.length) {
      if (prepend) chLoadingOlder = false;
      return;
    }
    if (!prepend) {
      list.innerHTML = '';
      r.messages.forEach(m => appendChannelMessage(m, false));
      requestAnimationFrame(() => { wrap.scrollTop = wrap.scrollHeight; });
    } else {
      const distFromBottom = wrap.scrollHeight - wrap.scrollTop;
      r.messages.forEach(m => prependChannelMessage(m));
      requestAnimationFrame(() => {
        wrap.scrollTop = wrap.scrollHeight - distFromBottom;
        chLoadingOlder = false;
      });
    }
  }

  let chLoadingOlder = false;

  $('channel-messages-wrap').addEventListener('scroll', function() {
    if (this.scrollTop < 80 && activeChannelId && !chLoadingOlder) {
      loadChannelMessages(activeChannelId, true);
    }
  });

  function appendChannelMessage(msg, scroll=true) {
    const list = $('channel-messages-list');
    const el = buildMessageEl(msg, list.lastElementChild);
    list.appendChild(el);
    if (scroll) {
      const wrap = $('channel-messages-wrap');
      requestAnimationFrame(() => { wrap.scrollTop = wrap.scrollHeight; });
    }
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
    let r;
    try {
      const res = await fetch('/api/servers', { method: 'POST', body: fd, credentials: 'include' });
      const text = await res.text();
      try { r = JSON.parse(text); } catch(e) {
        return showError('create-server-error', 'Server error: ' + text.slice(0, 120));
      }
    } catch(e) {
      return showError('create-server-error', 'Network error: ' + e.message);
    }
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
  $('server-settings-btn').addEventListener('click', async () => {
    if (!activeServerData) return;
    const s = activeServerData.server;
    $('settings-server-name').value = s.name;
    $('settings-invite-code').value = s.inviteCode;
    if (s.iconDataUrl) {
      $('settings-icon-preview').innerHTML = `<img src="${s.iconDataUrl}" alt="">`;
    } else {
      $('settings-icon-preview').textContent = s.name[0].toUpperCase();
    }
    switchSettingsTab('overview');
    renderRolesList(activeServerData.roles || []);
    loadBansList();
    $('server-settings-modal').classList.add('active');
  });

  // Settings tab switching
  window.switchSettingsTab = function(tab) {
    document.querySelectorAll('.settings-tab').forEach(b => b.classList.toggle('active', b.dataset.stab === tab));
    document.querySelectorAll('.settings-tab-panel').forEach(p => {
      p.style.display = p.id === 'settings-tab-' + tab ? 'block' : 'none';
      p.classList.toggle('active', p.id === 'settings-tab-' + tab);
    });
  };

  function renderRolesList(roles) {
    $('roles-list').innerHTML = roles.length
      ? roles.map(r => `
          <div class="role-row" id="role-row-${r.id}">
            <div class="role-dot" style="background:${r.color}"></div>
            <span class="role-name" style="color:${r.color}">${esc(r.name)}</span>
            <span class="role-badge">${r.isAdmin ? 'Admin' : 'Member'}</span>
            <div class="role-actions">
              <button class="role-edit-btn" onclick="editRole('${r.id}','${esc(r.name)}','${r.color}',${r.isAdmin})">Edit</button>
              <button class="role-del-btn" onclick="deleteRole('${r.id}','${esc(r.name)}')">Delete</button>
            </div>
          </div>`).join('')
      : '<p style="font-size:13px;color:var(--text-muted);padding:8px 0">No custom roles yet. Create one below.</p>';
  }

  window.editRole = async function(roleId, currentName, currentColor, currentIsAdmin) {
    const name = prompt('Role name:', currentName);
    if (!name || !name.trim()) return;
    const color = prompt('Color (hex, e.g. #ff5555):', currentColor);
    const isAdminChoice = confirm('Should this role have admin permissions?');
    const r = await api('PATCH', `/api/servers/${activeServerId}/roles/${roleId}`, {
      name: name.trim(), color: color || currentColor, isAdmin: isAdminChoice
    });
    if (r.error) return toast(r.error, 'error');
    const s = await api('GET', `/api/servers/${activeServerId}`);
    activeServerData = s;
    renderRolesList(s.roles || []);
    renderMemberList(s.members);
    toast('Role updated!', 'success');
  };

  window.deleteRole = async function(roleId, name) {
    if (!confirm(`Delete role "${name}"?`)) return;
    const r = await api('DELETE', `/api/servers/${activeServerId}/roles/${roleId}`);
    if (r.error) return toast(r.error, 'error');
    const s = await api('GET', `/api/servers/${activeServerId}`);
    activeServerData = s;
    renderRolesList(s.roles || []);
    renderMemberList(s.members);
    toast('Role deleted', 'info');
  };

  $('create-role-btn').addEventListener('click', async () => {
    const name = $('new-role-name').value.trim();
    const color = $('new-role-color').value;
    const isAdmin = $('new-role-admin').value === 'true';
    if (!name) return toast('Enter a role name', 'error');
    const r = await api('POST', `/api/servers/${activeServerId}/roles`, { name, color, isAdmin });
    if (r.error) return toast(r.error, 'error');
    $('new-role-name').value = '';
    const s = await api('GET', `/api/servers/${activeServerId}`);
    activeServerData = s;
    renderRolesList(s.roles || []);
    toast('Role created!', 'success');
  });

  async function loadBansList() {
    const r = await api('GET', `/api/servers/${activeServerId}/bans`);
    const bans = r.bans || [];
    $('bans-list').innerHTML = bans.length
      ? bans.map(b => `
          <div class="ban-row">
            <div class="ban-info">
              <div class="ban-name">${esc(b.displayName)} <span style="color:var(--text-muted);font-weight:400">@${esc(b.username)}</span></div>
              ${b.reason ? `<div class="ban-reason">Reason: ${esc(b.reason)}</div>` : ''}
            </div>
            <button class="action-btn success" onclick="unbanMember('${b.userId}','${esc(b.displayName)}')">Unban</button>
          </div>`).join('')
      : '<p style="font-size:13px;color:var(--text-muted)">No banned members.</p>';
  }

  window.unbanMember = async function(userId, name) {
    const r = await api('POST', `/api/servers/${activeServerId}/unban/${userId}`);
    if (r.error) return toast(r.error, 'error');
    toast(`${name} was unbanned`, 'success');
    loadBansList();
  };
  $('server-settings-close').addEventListener('click', () => $('server-settings-modal').classList.remove('active'));

  $('leave-server-btn').addEventListener('click', async () => {
    if (!activeServerId || !activeServerData) return;
    const serverName = activeServerData.server.name;
    if (!confirm('Leave "' + serverName + '"? You can rejoin with an invite code.')) return;
    const r = await api('DELETE', '/api/servers/' + activeServerId + '/leave');
    if (r.error) return toast(r.error, 'error');
    servers = servers.filter(s => s.id !== activeServerId);
    renderServerRail();
    activeServerId = null; activeChannelId = null; activeServerData = null;
    railSelect('dms');
    toast('Left "' + serverName + '"', 'info');
  });
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
    let r;
    try {
      const res = await fetch(`/api/servers/${activeServerId}`, { method: 'PATCH', body: fd, credentials: 'include' });
      const text = await res.text();
      try { r = JSON.parse(text); } catch(e) {
        return showError('settings-server-error', 'Server error: ' + text.slice(0, 120));
      }
    } catch(e) {
      return showError('settings-server-error', 'Network error: ' + e.message);
    }
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

    // Reset pagination lock and load messages
    dmLoadingOlder = false;
    await loadMessages(user.id);

    $('message-input').focus();
  };

  function closeDm() {
    activeDmUserId = null;
    activeDmUser = null;
    $('chat-placeholder').style.display = 'flex';
    $('chat-container').style.display = 'none';
  }

  let dmLoadingOlder = false; // lock to prevent multiple simultaneous loads

  async function loadMessages(userId, prepend = false) {
    if (prepend && dmLoadingOlder) return; // prevent double-fire
    if (prepend) dmLoadingOlder = true;

    const list = $('messages-list');
    const wrap = $('messages-wrap');
    const oldest = list.querySelector('.message');
    const beforeTs = prepend && oldest ? oldest.dataset.ts : undefined;

    // Don't re-fetch if we got nothing last time for this conversation
    const url = `/api/messages/${userId}${beforeTs ? `?before=${beforeTs}` : ''}`;
    const r = await api('GET', url);

    if (!r.messages || !r.messages.length) {
      if (prepend) dmLoadingOlder = false;
      return;
    }

    if (!prepend) {
      list.innerHTML = '';
      r.messages.forEach(m => appendMessage(m, false));
      // Use requestAnimationFrame so DOM is painted before we scroll
      requestAnimationFrame(() => { wrap.scrollTop = wrap.scrollHeight; });
    } else {
      // Save scroll position from the bottom before adding content
      const distFromBottom = wrap.scrollHeight - wrap.scrollTop;
      r.messages.forEach(m => prependMessage(m));
      // Restore position from bottom after DOM updates
      requestAnimationFrame(() => {
        wrap.scrollTop = wrap.scrollHeight - distFromBottom;
        dmLoadingOlder = false;
      });
    }
  }

  function appendMessage(msg, scroll = true) {
    const list = $('messages-list');
    const el = buildMessageEl(msg, list.lastElementChild);
    list.appendChild(el);
    if (scroll) {
      const wrap = $('messages-wrap');
      requestAnimationFrame(() => { wrap.scrollTop = wrap.scrollHeight; });
    }
  }

  function prependMessage(msg) {
    const list = $('messages-list');
    // Build without grouping context (prepended messages are old, grouping is cosmetic)
    const el = buildMessageEl(msg, null);
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

    const roleColor = author.roleColor || null;
    const roleStyle = roleColor ? `style="color:${roleColor}"` : '';
    const roleClass = roleColor ? 'msg-author has-role' : 'msg-author';
    const roleTip = author.roleName ? `title="${esc(author.roleName)}"` : '';

    el.innerHTML = `
      <div class="avatar" id="mav-${msg.id}"></div>
      <div class="msg-body">
        <div class="msg-header">
          <span class="${roleClass}" ${roleStyle} ${roleTip}>${esc(author.displayName)}</span>
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

  // Infinite scroll (load older) — only fires when near the top
  $('messages-wrap').addEventListener('scroll', function () {
    if (this.scrollTop < 80 && activeDmUserId && !dmLoadingOlder) {
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
      // Deduplicate — if this message ID is already in the DOM, skip it
      if ($(`[data-id="${msg.id}"]`)) return;

      // Update DM last message preview
      const peerId = msg.fromId === currentUser.id ? msg.toId : msg.fromId;
      const dlm = $(`dlm-${peerId}`);
      if (dlm) dlm.textContent = msg.content.slice(0, 30) + (msg.content.length > 30 ? '…' : '');

      if (activeDmUserId && (msg.fromId === activeDmUserId || msg.toId === activeDmUserId)) {
        appendMessage(msg);
      } else if (msg.fromId !== currentUser.id) {
        const friend = friends.find(f => f.id === msg.fromId);
        toast(`${friend ? friend.displayName : 'Someone'}: ${msg.content.slice(0, 50)}`, 'info');
      }
    });

    // message_sent: only update the DM list preview, never render — new_message handles rendering
    socket.on('message_sent', msg => {
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

    socket.on('channel_error', ({ channelId, error }) => {
      if (channelId === activeChannelId) toast(error, 'error');
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

    socket.on('server_invite', (data) => {
      toast(`You've been invited to "${data.serverName}" by ${data.from.displayName}`, 'info', 6000);
      loadServerInvites();
    });

    socket.on('kicked_from_server', ({ serverId }) => {
      servers = servers.filter(s => s.id !== serverId);
      renderServerRail();
      if (activeServerId === serverId) {
        railSelect('dms');
      }
      toast('You were kicked from a server', 'error');
    });

    socket.on('banned_from_server', ({ serverId }) => {
      servers = servers.filter(s => s.id !== serverId);
      renderServerRail();
      if (activeServerId === serverId) {
        railSelect('dms');
      }
      toast('You were banned from a server', 'error');
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
    $('profile-bio').value = currentUser.bio || '';
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
    const bio = $('profile-bio').value.trim();
    const r = await api('PATCH', '/api/users/profile', { displayName: name, bio });
    if (r.error) return showError('profile-error', r.error);
    currentUser.displayName = name;
    currentUser.bio = bio;
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

  // ---- Profile Popup ----
  window.showProfilePopup = async function(e, encodedData) {
    e.stopPropagation();
    const data = JSON.parse(decodeURIComponent(encodedData));
    const popup = $('profile-popup');

    // Render what we have immediately
    renderAvatar($('popup-avatar'), data);
    $('popup-name').textContent = data.displayName;
    $('popup-username').textContent = '@' + data.username;
    $('popup-status').className = 'status-dot ' + (data.status === 'online' ? 'online' : '');
    $('popup-bio-section').style.display = 'none';
    $('popup-bio').textContent = '';

    if (data.roleName) {
      $('popup-role').style.display = 'inline-block';
      $('popup-role').style.color = data.roleColor || 'var(--accent)';
      $('popup-role').textContent = data.roleName;
    } else {
      $('popup-role').style.display = 'none';
    }

    // Position popup near the click
    popup.style.display = 'block';
    const x = e.clientX, y = e.clientY;
    const pw = 280, ph = 260;
    const left = Math.min(x + 10, window.innerWidth - pw - 10);
    const top = Math.min(y, window.innerHeight - ph - 10);
    popup.style.left = left + 'px';
    popup.style.top = top + 'px';

    // Fetch full profile for bio
    try {
      const r = await api('GET', '/api/users/profile/' + data.id);
      if (r.bio) {
        $('popup-bio').textContent = r.bio;
        $('popup-bio-section').style.display = 'block';
      }
    } catch(err) {}
  };

  // Dismiss popup on outside click
  document.addEventListener('click', e => {
    const popup = $('profile-popup');
    if (popup && popup.style.display !== 'none' && !popup.contains(e.target)) {
      popup.style.display = 'none';
    }
  });

  // ---- Channel Permissions ----
  let permsChannelId = null;
  let permsChannelRoles = [];

  window.openChannelPerms = async function(e, channelId, channelName) {
    e.stopPropagation();
    permsChannelId = channelId;
    $('perms-channel-name').textContent = '#' + channelName;
    $('channel-perms-error').textContent = '';

    const r = await api('GET', `/api/servers/${activeServerId}/channels/${channelId}/permissions`);
    if (r.error) return toast(r.error, 'error');

    $('channel-locked-toggle').checked = !!r.locked;
    $('perms-roles-section').style.display = r.locked ? 'block' : 'none';

    // Build role permission rows
    const roles = (activeServerData && activeServerData.roles) || [];
    const permMap = {};
    (r.permissions || []).forEach(p => { permMap[p.roleId] = p.allowSend; });

    $('perms-roles-list').innerHTML = roles.map(role => {
      const hasAllow = permMap[role.id] === true;
      const hasDeny = permMap[role.id] === false;
      return `
        <div class="perm-role-row">
          <div class="perm-role-dot" style="background:${role.color}"></div>
          <span class="perm-role-name" style="color:${role.color}">${esc(role.name)}</span>
          <button class="perm-allow-btn ${hasAllow ? 'active' : ''}"
            onclick="setChannelPerm('${role.id}', true, this)">Allow</button>
          <button class="perm-deny-btn ${hasDeny ? 'active' : ''}"
            onclick="setChannelPerm('${role.id}', false, this)">Deny</button>
          ${permMap[role.id] !== undefined ? `<button class="action-btn ghost" style="font-size:11px;padding:4px 8px" onclick="removeChannelPerm('${role.id}', this)">Reset</button>` : ''}
        </div>`;
    }).join('') || '<p style="font-size:13px;color:var(--text-muted)">No roles defined yet. Create roles in Server Settings first.</p>';

    $('channel-perms-modal').classList.add('active');
  };

  $('channel-locked-toggle').addEventListener('change', async function() {
    if (!permsChannelId) return;
    const r = await api('PATCH', `/api/servers/${activeServerId}/channels/${permsChannelId}/lock`, { locked: this.checked });
    if (r.error) { this.checked = !this.checked; return toast(r.error, 'error'); }
    $('perms-roles-section').style.display = this.checked ? 'block' : 'none';
    // Update local channel data
    if (activeServerData) {
      const ch = activeServerData.channels.find(c => c.id === permsChannelId);
      if (ch) ch.locked = this.checked;
      const me = activeServerData.members.find(m => m.id === currentUser.id);
      renderChannelList(activeServerData.channels, me && (me.role === 'admin' || me.isAdmin));
    }
    toast(this.checked ? 'Channel locked' : 'Channel unlocked', 'success');
  });

  window.setChannelPerm = async function(roleId, allowSend, btn) {
    if (!permsChannelId) return;
    const r = await api('PUT', `/api/servers/${activeServerId}/channels/${permsChannelId}/permissions/${roleId}`, { allowSend });
    if (r.error) return toast(r.error, 'error');
    // Refresh the modal
    const ch = activeServerData && activeServerData.channels.find(c => c.id === permsChannelId);
    if (ch) openChannelPerms({ stopPropagation: ()=>{} }, permsChannelId, ch.name);
    toast('Permission updated', 'success');
  };

  window.removeChannelPerm = async function(roleId, btn) {
    if (!permsChannelId) return;
    const r = await api('DELETE', `/api/servers/${activeServerId}/channels/${permsChannelId}/permissions/${roleId}`);
    if (r.error) return toast(r.error, 'error');
    const ch = activeServerData && activeServerData.channels.find(c => c.id === permsChannelId);
    if (ch) openChannelPerms({ stopPropagation: ()=>{} }, permsChannelId, ch.name);
    toast('Permission reset', 'info');
  };

  $('channel-perms-close').addEventListener('click', () => $('channel-perms-modal').classList.remove('active'));
  $('channel-perms-modal').addEventListener('click', e => { if (e.target === $('channel-perms-modal')) $('channel-perms-modal').classList.remove('active'); });

  // Handle channel_error from server (permission denied)
  // Added in connectSocket below

  // ---- Escape helper ----
  function esc(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---- Start ----
  init();
})();
