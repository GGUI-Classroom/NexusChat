const state = {
  me: null,
  friends: [],
  servers: [],
  selected: null,
  authors: {},
  messages: [],
  refreshTimer: null,
  authMode: 'login',
  tos: null
};

const authScreen = document.getElementById('auth-screen');
const termsScreen = document.getElementById('terms-screen');
const appShell = document.getElementById('app-shell');
const authForm = document.getElementById('auth-form');
const authTitle = document.getElementById('auth-title');
const authCopy = document.getElementById('auth-copy');
const authSubmit = document.getElementById('auth-submit');
const authModeToggle = document.getElementById('auth-mode-toggle');
const authError = document.getElementById('auth-error');
const displayNameField = document.getElementById('display-name-field');
const displayNameInput = document.getElementById('display-name-input');
const usernameInput = document.getElementById('username-input');
const passwordInput = document.getElementById('password-input');
const termsCheckField = document.getElementById('terms-check-field');
const termsCheck = document.getElementById('terms-check');
const termsTitle = document.getElementById('terms-title');
const termsVersion = document.getElementById('terms-version');
const termsContent = document.getElementById('terms-content');
const termsAccept = document.getElementById('terms-accept');
const termsError = document.getElementById('terms-error');
const logoutButton = document.getElementById('logout-button');
const identityRoot = document.getElementById('identity');
const friendList = document.getElementById('friend-list');
const serverList = document.getElementById('server-list');
const channelList = document.getElementById('channel-list');
const chatKind = document.getElementById('chat-kind');
const chatTitle = document.getElementById('chat-title');
const messagesRoot = document.getElementById('messages');
const composer = document.getElementById('composer');
const input = document.getElementById('message-input');
const sendButton = document.getElementById('send-button');
const connectionNote = document.getElementById('connection-note');

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || 'Nexus request failed');
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function deviceId() {
  const key = 'nexusClientTemplateDeviceId';
  try {
    let value = localStorage.getItem(key);
    if (!value) {
      value = `client_${crypto.randomUUID().replace(/-/g, '')}`;
      localStorage.setItem(key, value);
    }
    return value;
  } catch (_) {
    return `client_${crypto.randomUUID().replace(/-/g, '')}`;
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function avatar(user, className = 'avatar') {
  const assetPath = user?.avatarPath || user?.iconPath;
  if (assetPath) {
    const image = document.createElement('img');
    image.className = className;
    image.src = `/api/nexus${assetPath}`;
    image.alt = '';
    image.addEventListener('error', () => {
      image.replaceWith(avatar({ displayName: user.displayName || user.username }, `${className} fallback`));
    }, { once: true });
    return image;
  }
  return element('span', `${className} fallback`, String(user?.displayName || user?.username || '?').trim().slice(0, 1).toUpperCase());
}

function formatTime(timestamp) {
  if (!timestamp) return '';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(timestamp * 1000));
}

function setNote(value, isError = false) {
  connectionNote.textContent = value;
  connectionNote.classList.toggle('is-error', isError);
}

function setApplicationVisible(visible) {
  appShell.hidden = !visible;
  if (!visible) {
    window.clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
}

function showAuthentication(message = '') {
  termsScreen.hidden = true;
  setApplicationVisible(false);
  authScreen.hidden = false;
  authError.textContent = message;
  configureAuthMode(state.authMode);
  usernameInput.focus();
}

function configureAuthMode(mode) {
  state.authMode = mode;
  const registering = mode === 'register';
  authTitle.textContent = registering ? 'Create your account' : 'Welcome back';
  authCopy.textContent = registering
    ? 'Use a Nexus account everywhere this client connects.'
    : 'Sign in with your Nexus account to continue.';
  authSubmit.textContent = registering ? 'Create account' : 'Sign in';
  authModeToggle.textContent = registering ? 'I already have a Nexus account' : 'Create a Nexus account';
  displayNameField.hidden = !registering;
  termsCheckField.hidden = !registering;
  displayNameInput.required = registering;
  termsCheck.required = registering;
  passwordInput.autocomplete = registering ? 'new-password' : 'current-password';
}

async function loadTerms() {
  const payload = await api('/api/nexus/auth/terms');
  state.tos = payload.tos;
  return state.tos;
}

function presentTerms(policy) {
  state.tos = policy || state.tos;
  const tos = state.tos;
  if (!tos) {
    showAuthentication('Nexus Terms of Service could not be loaded. Try again.');
    return;
  }
  authScreen.hidden = true;
  setApplicationVisible(false);
  termsScreen.hidden = false;
  termsTitle.textContent = tos.title || 'Nexus Terms of Service';
  termsVersion.textContent = `Version ${tos.version}`;
  termsContent.textContent = tos.content || '';
  termsError.textContent = '';
}

function renderIdentity() {
  identityRoot.replaceChildren();
  if (!state.me) return;
  const card = element('div', 'identity-card');
  card.append(avatar(state.me));
  const text = document.createElement('div');
  text.className = 'identity-text';
  text.append(element('div', 'identity-name', state.me.displayName || state.me.username));
  text.append(element('div', 'identity-meta', `@${state.me.username}`));
  card.append(text);
  identityRoot.append(card);
}

function navigationButton(item, type) {
  const button = element('button', `nav-item${state.selected?.type === type && state.selected?.id === item.id ? ' selected' : ''}`);
  button.type = 'button';
  button.append(avatar(item));
  button.append(element('span', 'nav-name', item.displayName || item.name || item.username));
  if (type === 'dm') {
    const status = element('span', `nav-status${item.status === 'online' ? ' online' : ''}`);
    button.append(status);
  }
  button.addEventListener('click', () => type === 'dm' ? selectDm(item) : selectServer(item));
  return button;
}

function renderNavigation() {
  friendList.replaceChildren(...state.friends.map(friend => navigationButton(friend, 'dm')));
  serverList.replaceChildren(...state.servers.map(server => navigationButton(server, 'server')));
}

function renderMessages() {
  messagesRoot.replaceChildren();
  if (!state.selected) {
    messagesRoot.append(element('p', 'empty-state', 'Choose a direct message or a server channel to load the shared Nexus conversation.'));
    return;
  }
  if (!state.messages.length) {
    messagesRoot.append(element('p', 'empty-state', 'No messages here yet. Send the first one from this client.'));
    return;
  }
  state.messages.forEach(message => {
    const author = state.authors[message.fromId] || { displayName: 'Unknown user' };
    const row = element('article', 'message');
    row.append(avatar(author));
    const content = document.createElement('div');
    const heading = element('div', 'message-heading');
    heading.append(element('span', 'message-name', author.displayName || author.username || 'Unknown user'));
    heading.append(element('time', 'message-time', formatTime(message.createdAt)));
    content.append(heading);
    if (message.replyTo) content.append(element('div', 'message-time', `Replying to ${message.replyTo.displayName}`));
    content.append(element('div', 'message-content', message.content));
    row.append(content);
    messagesRoot.append(row);
  });
  messagesRoot.scrollTop = messagesRoot.scrollHeight;
}

function setComposerEnabled(enabled) {
  input.disabled = !enabled;
  sendButton.disabled = !enabled;
  input.placeholder = enabled ? 'Message through Nexus...' : 'Choose a conversation to start chatting';
}

async function loadDmMessages() {
  const target = state.selected;
  if (!target || target.type !== 'dm') return;
  const data = await api(`/api/nexus/dms/${encodeURIComponent(target.id)}?limit=50`);
  state.authors = data.authors || {};
  state.messages = data.messages || [];
  renderMessages();
}

async function loadChannelMessages() {
  const target = state.selected;
  if (!target || target.type !== 'channel') return;
  const data = await api(`/api/nexus/servers/${encodeURIComponent(target.serverId)}/channels/${encodeURIComponent(target.id)}/messages?limit=50`);
  state.authors = data.authors || {};
  state.messages = data.messages || [];
  renderMessages();
}

async function selectDm(friend) {
  state.selected = { type: 'dm', id: friend.id, name: friend.displayName || friend.username };
  state.messages = [];
  chatKind.textContent = 'DIRECT MESSAGE';
  chatTitle.textContent = state.selected.name;
  channelList.replaceChildren();
  setComposerEnabled(true);
  renderNavigation();
  renderMessages();
  try {
    await loadDmMessages();
    setNote('This conversation is connected to the shared Nexus chat system.');
  } catch (error) {
    handleChatError(error);
  }
}

async function selectServer(server) {
  state.selected = { type: 'server', id: server.id, name: server.name };
  state.messages = [];
  chatKind.textContent = 'SERVER';
  chatTitle.textContent = server.name;
  setComposerEnabled(false);
  renderNavigation();
  renderMessages();
  try {
    const data = await api(`/api/nexus/servers/${encodeURIComponent(server.id)}`);
    const channels = (data.channels || []).filter(channel => channel.type !== 'voice');
    channelList.replaceChildren(...channels.map(channel => {
      const button = element('button', 'channel-button', `# ${channel.name}`);
      button.type = 'button';
      button.addEventListener('click', () => selectChannel(server, channel, channels));
      return button;
    }));
    if (channels[0]) await selectChannel(server, channels[0], channels);
    else setNote('This server has no text channels available to this account.');
  } catch (error) {
    handleChatError(error);
  }
}

async function selectChannel(server, channel, channels) {
  state.selected = { type: 'channel', id: channel.id, serverId: server.id, name: channel.name, serverName: server.name };
  chatKind.textContent = server.name;
  chatTitle.textContent = `# ${channel.name}`;
  setComposerEnabled(true);
  [...channelList.children].forEach((button, index) => button.classList.toggle('selected', channels[index]?.id === channel.id));
  renderMessages();
  try {
    await loadChannelMessages();
    setNote('Nexus checks the account permissions before every send.');
  } catch (error) {
    handleChatError(error);
  }
}

function handleChatError(error) {
  if (error.status === 401) {
    showAuthentication('Your Nexus client session expired. Sign in again.');
    return;
  }
  if (error.payload?.tosRequired) {
    presentTerms(error.payload.tos);
    return;
  }
  setNote(error.message, true);
}

async function refreshOpenConversation() {
  try {
    if (state.selected?.type === 'dm') await loadDmMessages();
    if (state.selected?.type === 'channel') await loadChannelMessages();
  } catch (error) {
    if (error.status === 401 || error.payload?.tosRequired) handleChatError(error);
  }
}

async function startApplication(initialSession) {
  termsScreen.hidden = true;
  authScreen.hidden = true;
  try {
    const session = initialSession || await api('/api/nexus/session');
    const [friends, servers] = await Promise.all([
      api('/api/nexus/friends'),
      api('/api/nexus/servers')
    ]);
    state.me = session.user;
    state.friends = friends.friends || [];
    state.servers = servers.servers || [];
    state.selected = null;
    state.authors = {};
    state.messages = [];
    renderIdentity();
    renderNavigation();
    setApplicationVisible(true);
    if (state.friends[0]) await selectDm(state.friends[0]);
    else if (state.servers[0]) await selectServer(state.servers[0]);
    else renderMessages();
    window.clearInterval(state.refreshTimer);
    state.refreshTimer = window.setInterval(refreshOpenConversation, 3500);
  } catch (error) {
    if (error.payload?.tosRequired) return presentTerms(error.payload.tos);
    showAuthentication(error.status === 401 ? '' : `Could not load Nexus: ${error.message}`);
  }
}

authModeToggle.addEventListener('click', async () => {
  authError.textContent = '';
  configureAuthMode(state.authMode === 'login' ? 'register' : 'login');
  if (state.authMode === 'register') {
    try {
      await loadTerms();
    } catch (error) {
      authError.textContent = error.message;
    }
  }
});

authForm.addEventListener('submit', async event => {
  event.preventDefault();
  authError.textContent = '';
  authSubmit.disabled = true;
  try {
    const registering = state.authMode === 'register';
    if (registering && !termsCheck.checked) throw new Error('Agree to the Nexus Terms of Service to create an account.');
    if (registering && !state.tos) await loadTerms();
    const body = {
      username: usernameInput.value.trim(),
      password: passwordInput.value,
      deviceId: deviceId()
    };
    if (registering) {
      body.displayName = displayNameInput.value.trim();
      body.acceptedTos = true;
      body.acceptedTosVersion = state.tos.version;
    }
    const result = await api(`/api/nexus/auth/${registering ? 'register' : 'login'}`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
    passwordInput.value = '';
    if (result.tosRequired) return presentTerms(result.tos);
    await startApplication({ user: result.user });
  } catch (error) {
    authError.textContent = error.message;
  } finally {
    authSubmit.disabled = false;
  }
});

termsAccept.addEventListener('click', async () => {
  if (!state.tos) return;
  termsError.textContent = '';
  termsAccept.disabled = true;
  try {
    await api('/api/nexus/auth/tos/accept', {
      method: 'POST',
      body: JSON.stringify({ accepted: true, version: state.tos.version })
    });
    await startApplication();
  } catch (error) {
    termsError.textContent = error.message;
    if (error.payload?.tos) presentTerms(error.payload.tos);
  } finally {
    termsAccept.disabled = false;
  }
});

logoutButton.addEventListener('click', async () => {
  try {
    await api('/api/nexus/auth/logout', { method: 'POST', body: '{}' });
  } catch (_) {
    // Clearing the client view is still the right result when a logout request
    // races with a short Nexus outage.
  }
  state.me = null;
  state.friends = [];
  state.servers = [];
  state.selected = null;
  state.authors = {};
  state.messages = [];
  friendList.replaceChildren();
  serverList.replaceChildren();
  channelList.replaceChildren();
  identityRoot.replaceChildren();
  showAuthentication();
});

composer.addEventListener('submit', async event => {
  event.preventDefault();
  const content = input.value.trim();
  if (!content || !state.selected || input.disabled) return;
  sendButton.disabled = true;
  try {
    const target = state.selected.type === 'dm'
      ? `/api/nexus/dms/${encodeURIComponent(state.selected.id)}`
      : `/api/nexus/servers/${encodeURIComponent(state.selected.serverId)}/channels/${encodeURIComponent(state.selected.id)}/messages`;
    await api(target, { method: 'POST', body: JSON.stringify({ content }) });
    input.value = '';
    await refreshOpenConversation();
    setNote('Sent through Nexus.');
  } catch (error) {
    handleChatError(error);
  } finally {
    if (!input.disabled) sendButton.disabled = false;
  }
});

async function boot() {
  configureAuthMode('login');
  try {
    const session = await api('/api/nexus/session');
    await startApplication(session);
  } catch (error) {
    if (error.payload?.tosRequired) presentTerms(error.payload.tos);
    else showAuthentication(error.status === 401 ? '' : `Could not contact Nexus: ${error.message}`);
  }
}

boot();
