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
  let isAppAdmin = false;
  let nexusClientLocked = false;
  let quickPopupTimer = null;
  let secretHumCtx = null;
  let secretHumNodes = [];
  let secretClaimRunning = false;
  const LOCAL_API_ORIGIN = String(window.NEXUS_API_URL || '').replace(/\/+$/, '');

  function apiUrl(path) {
    if (!path || /^https?:\/\//i.test(path)) return path;
    return LOCAL_API_ORIGIN ? LOCAL_API_ORIGIN + path : path;
  }

  function requestText(method, path, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, apiUrl(path), true);
      xhr.withCredentials = true;
      Object.entries(headers).forEach(([key, value]) => xhr.setRequestHeader(key, value));
      xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText || '' });
      xhr.onerror = () => reject(new Error('Network request failed'));
      xhr.ontimeout = () => reject(new Error('Network request timed out'));
      xhr.timeout = 30000;
      xhr.send(body || null);
    });
  }

  async function requestJson(method, path, body, headers) {
    const res = await requestText(method, path, body, headers);
    try {
      return JSON.parse(res.text);
    } catch (e) {
      console.error('Non-JSON response:', res.text);
      return { error: 'Server returned invalid response: ' + res.text.slice(0, 100) };
    }
  }

  const SECRET_CATEGORY = '???SECRET???';
  const SECRET_DECORATION_ID = 'stormveil';
  const SECRET_UNLOCK_PASSPHRASE = 'void';
  const HEHESHUIS_SECRET_ID = 'heheshuis_aura';
  const HEHESHUIS_PASSPHRASE = 'lol';

  // Call state
  let callState = null; // { roomId, peerId, peerUser, peerConnection, localStream, timerInterval }
  let pendingCallData = null; // incoming call data before answering
  let ringtoneCtx = null;
  let ringtoneNodes = [];
  let ringtonePreviewTimer = null;
  let isScreenSharing = false;
  let screenStream = null;
  let outgoingCallTo = null;
  let outgoingCallRoomId = null;
  let outgoingCallType = 'voice';
  let remoteScreenActive = false; // true when peer is sharing their screen
  let expectingRemoteScreenTrack = false;

  // Server state
  let servers = [];
  let activeServerId = null;
  let activeChannelId = null;
  let activeServerData = null; // { server, channels, members }
  let isCurrentServerAdmin = false;
  let pendingChannelReply = null;
  let activeChannelTopic = null;
  let activeChannelSlowmode = 0;
  let activeChannelType = 'text';
  let channelTypingTimer = null;
  let isChannelTyping = false;
  let groupCallState = null;
  let groupCameraStream = null;
  let groupScreenStream = null;

  const RINGTONE_PRESETS = {
    neon_surge: {
      wave: 'triangle',
      intervalMs: 1050,
      gain: 0.2,
      pattern: [
        { f: 740, t: 0.00, d: 0.10 },
        { f: 988, t: 0.16, d: 0.12 },
        { f: 1318, t: 0.34, d: 0.14 }
      ]
    },
    cyber_echo: {
      wave: 'square',
      intervalMs: 980,
      gain: 0.17,
      pattern: [
        { f: 660, t: 0.00, d: 0.08 },
        { f: 660, t: 0.14, d: 0.08 },
        { f: 880, t: 0.30, d: 0.12 },
        { f: 660, t: 0.50, d: 0.10 }
      ]
    },
    starlight_ping: {
      wave: 'sine',
      intervalMs: 1100,
      gain: 0.2,
      pattern: [
        { f: 988, t: 0.00, d: 0.11 },
        { f: 1174, t: 0.18, d: 0.11 },
        { f: 1568, t: 0.40, d: 0.14 }
      ]
    },
    thunder_hop: {
      wave: 'sawtooth',
      intervalMs: 1000,
      gain: 0.16,
      pattern: [
        { f: 220, t: 0.00, d: 0.12 },
        { f: 440, t: 0.20, d: 0.10 },
        { f: 554, t: 0.36, d: 0.10 },
        { f: 659, t: 0.52, d: 0.12 }
      ]
    },
    velvet_alarm: {
      wave: 'triangle',
      intervalMs: 1150,
      gain: 0.18,
      pattern: [
        { f: 523, t: 0.00, d: 0.14 },
        { f: 659, t: 0.24, d: 0.14 },
        { f: 784, t: 0.46, d: 0.16 }
      ]
    },
    quantum_drift: {
      wave: 'triangle',
      intervalMs: 980,
      gain: 0.2,
      pattern: [
        { f: 698, t: 0.00, d: 0.08 },
        { f: 932, t: 0.12, d: 0.09 },
        { f: 1174, t: 0.25, d: 0.10 },
        { f: 1568, t: 0.40, d: 0.14 }
      ]
    },
    nova_breaker: {
      wave: 'sawtooth',
      intervalMs: 920,
      gain: 0.19,
      pattern: [
        { f: 196, t: 0.00, d: 0.11 },
        { f: 392, t: 0.16, d: 0.09 },
        { f: 294, t: 0.28, d: 0.08 },
        { f: 880, t: 0.43, d: 0.12 },
        { f: 1174, t: 0.59, d: 0.10 }
      ]
    }
  };

  const DEFAULT_INCOMING_RINGTONE = {
    wave: 'sine',
    intervalMs: 1000,
    gain: 0.18,
    pattern: [
      { f: 660, t: 0, d: 0.15 },
      { f: 880, t: 0.2, d: 0.15 }
    ]
  };

  const DEFAULT_OUTGOING_RINGTONE = {
    wave: 'sine',
    intervalMs: 1200,
    gain: 0.16,
    pattern: [
      { f: 520, t: 0, d: 0.1 }
    ]
  };

  // ---- Helpers ----
  const $ = id => document.getElementById(id);
  const qs = sel => document.querySelector(sel);

  function pauseNexusClient(message) {
    nexusClientLocked = true;
    $('nexus-lock-message').textContent = (message || '').trim() || 'This Nexus client is temporarily paused.';
    $('nexus-lock-overlay').style.display = 'flex';
  }

  function unpauseNexusClient() {
    nexusClientLocked = false;
    $('nexus-lock-overlay').style.display = 'none';
  }

  function showQuickPopup(message, durationMs = 5000) {
    const text = (message || '').trim();
    if (!text) return;
    const host = $('nexus-quick-popup');
    const card = $('nexus-quick-popup-text');
    if (!host || !card) return;
    card.textContent = text;
    host.style.display = 'flex';
    if (quickPopupTimer) clearTimeout(quickPopupTimer);
    quickPopupTimer = setTimeout(() => {
      host.style.display = 'none';
      quickPopupTimer = null;
    }, durationMs);
  }

  function addStormveilLayers(wrap) {
    if (!wrap) return;
    wrap.querySelectorAll('.stormveil-layer').forEach(e => e.remove());
    const layerNames = ['a', 'b', 'c', 'd', 'e', 'f'];
    layerNames.forEach(name => {
      const layer = document.createElement('span');
      layer.className = 'stormveil-layer stormveil-layer-' + name;
      wrap.appendChild(layer);
    });
  }

  function addHeheshuisLayers(wrap) {
    if (!wrap) return;
    wrap.querySelectorAll('.heheshuis-layer').forEach(e => e.remove());
    const layerNames = ['a', 'b'];
    layerNames.forEach(name => {
      const layer = document.createElement('span');
      layer.className = 'heheshuis-layer heheshuis-layer-' + name;
      wrap.appendChild(layer);
    });
  }

  const PREMIUM_DECORATIONS = {
    ember_trace: ['ember', '#ff8b38', '#ff3f24', '#ffd06a', 'spark'],
    mint_signal: ['signal', '#68ffd0', '#44d9ff', '#caffed', 'wave'],
    pixel_pop: ['pixel', '#76beff', '#ff76e6', '#ffe86d', 'glints'],
    soft_static: ['static', '#dbe7ff', '#8fa0c6', '#ffffff', 'dust'],
    lime_loop: ['loop', '#b9ff4c', '#3effa8', '#edff86', 'arc'],
    neon_grid: ['grid', '#54f4ff', '#526cff', '#46ffca', 'scan'],
    violet_comet: ['comet', '#cc84ff', '#60ceff', '#f6d2ff', 'comet'],
    signal_wave: ['wave', '#48b4ff', '#40eeff', '#78ffce', 'wave'],
    chrome_edge: ['chrome', '#f7fbff', '#7d8fa5', '#c6dcff', 'shine'],
    solar_flare: ['solar', '#ffd448', '#ff6830', '#fff6a2', 'flare'],
    void_pulse: ['void', '#7c5cff', '#170d43', '#ca80ff', 'rift'],
    plasma_arc: ['plasma', '#4eecff', '#ff56da', '#ffffff', 'arc'],
    crystal_bloom: ['crystal', '#c4f6ff', '#96beff', '#ffffff', 'crystal'],
    toxic_slime: ['slime', '#7eff2e', '#26be2e', '#d6ff62', 'drip'],
    nebula_dust: ['nebula', '#5ce0ff', '#ba54ff', '#ff5cda', 'dust'],
    ion_crown: ['crown', '#62ecff', '#5a70ff', '#ffffff', 'crown'],
    ruby_circuit: ['ruby', '#ff4870', '#ffa056', '#ffd6d6', 'scan'],
    starforge: ['forge', '#ffd254', '#788494', '#fff6b2', 'shine'],
    quantum_ring: ['quantum', '#6cffe2', '#c468ff', '#5c8eff', 'rift'],
    midnight_sun: ['eclipse', '#ffbc40', '#12102a', '#ffee8e', 'eclipse'],
    dragon_core: ['dragon', '#ff4a2a', '#ffb24a', '#5e0a04', 'flare'],
    cosmic_crown: ['cosmic', '#ffeea0', '#7484ff', '#6eeeff', 'crown'],
    phantom_blade: ['blade', '#eaf6ff', '#96a8ff', '#96f6ff', 'blade'],
    time_rift: ['time', '#76ffe0', '#7e5cff', '#ffffff', 'rift'],
    zero_gravity: ['gravity', '#96daff', '#d894ff', '#ffe678', 'float'],
    singularity: ['singularity', '#8e68ff', '#040210', '#c898ff', 'rift'],
    celestial_wings: ['wings', '#ffeeb8', '#70d2ff', '#ffffff', 'wings'],
    apex_storm: ['storm', '#76e2ff', '#5268ff', '#ffffff', 'storm'],
    prism_overdrive: ['prism', '#ff54d8', '#52e6ff', '#ffe252', 'prism'],
    eternal_flame: ['flame', '#ff7a2a', '#ff2612', '#ffde62', 'flare'],
    magic_mists: ['magic-mists', '#60e0ff', '#ba4cff', '#44f8d2', 'mist']
  };

  const MYTHICAL_PREMIUM_DECORATIONS = new Set([
    'dragon_core',
    'cosmic_crown',
    'phantom_blade',
    'time_rift',
    'zero_gravity',
    'singularity',
    'celestial_wings',
    'apex_storm',
    'prism_overdrive',
    'eternal_flame',
    'magic_mists'
  ]);

  function isPremiumDecoration(deco) {
    return !!PREMIUM_DECORATIONS[deco];
  }

  function clearDecorationDom(wrap) {
    if (!wrap) return;
    wrap.querySelectorAll('.avatar-deco,.premium-deco,.admin-crown,.deco-shine-overlay,.stormveil-layer,.heheshuis-layer').forEach(e => e.remove());
  }

  function renderPremiumDecoration(wrap, deco) {
    const preset = PREMIUM_DECORATIONS[deco];
    if (!wrap || !preset) return;
    const [style, a, b, c, motif] = preset;
    const isMythical = MYTHICAL_PREMIUM_DECORATIONS.has(deco);
    const el = document.createElement('div');
    el.className = `premium-deco premium-${style}${isMythical ? ' premium-mythical' : ''}`;
    el.dataset.deco = deco;
    el.style.setProperty('--fx-a', a);
    el.style.setProperty('--fx-b', b);
    el.style.setProperty('--fx-c', c);
    el.innerHTML = `
      <span class="premium-shell"></span>
      <span class="premium-glass"></span>
      <span class="premium-rim premium-rim-a"></span>
      <span class="premium-rim premium-rim-b"></span>
      <span class="premium-wisp premium-wisp-a"></span>
      <span class="premium-wisp premium-wisp-b"></span>
      <span class="premium-motif premium-motif-${motif}"></span>
      <span class="premium-sparks"></span>
      ${isMythical ? '<span class="premium-intrusion"></span><span class="premium-strike"></span>' : ''}
    `;
    wrap.appendChild(el);
  }

  function applyDecorationToWrap(wrap, deco) {
    if (!wrap || !deco) return;
    if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';
    wrap.style.overflow = 'visible';
    clearDecorationDom(wrap);
    stopStormCanvas(wrap); stopInfernoCanvas(wrap); stopYinYangCanvas(wrap); stopHydroCanvas(wrap); stopShatterCanvas(wrap);

    const canvasOnlyDecos = new Set(['storm','inferno','yinyang','hydro','shatter']);
    if (isPremiumDecoration(deco)) {
      renderPremiumDecoration(wrap, deco);
    } else if (!canvasOnlyDecos.has(deco)) {
      const decoEl = document.createElement('div');
      decoEl.className = 'avatar-deco deco-' + deco;
      wrap.appendChild(decoEl);
      if (deco === 'stormveil') addStormveilLayers(wrap);
      if (deco === 'heheshuis_aura') addHeheshuisLayers(wrap);
    }

    wrap.dataset.deco = deco;
  }

  function renderAvatar(el, user, showDeco = true) {
    const url = user && user.avatarDataUrl;
    // Don't show deco on grouped messages (avatar is hidden anyway)
    const isGrouped = el.closest && el.closest('.message.grouped');
    const deco = showDeco && !isGrouped && user && user.activeDecoration;

    // Fill the avatar element
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%';
      img.onerror = () => { el.textContent = (user.displayName || user.username || '?')[0].toUpperCase(); };
      el.innerHTML = '';
      el.appendChild(img);
    } else {
      el.textContent = (user && (user.displayName || user.username) || '?')[0].toUpperCase();
    }

    if (!deco) {
      // Clean up any old deco on this element's wrap
      const oldWrap = el.parentElement;
      if (oldWrap) {
        clearDecorationDom(oldWrap);
        delete oldWrap.dataset.deco;
        stopStormCanvas(oldWrap);
        stopInfernoCanvas(oldWrap);
        stopYinYangCanvas(oldWrap);
        stopHydroCanvas(oldWrap);
        stopShatterCanvas(oldWrap);
      }
      return;
    }

    // Find or create a proper wrap for the avatar
    let wrap = el.parentElement;
    if (!wrap) return;

    // Ensure the wrap has position:relative and overflow:visible for canvas decos
    const canvasDecoSet = new Set(['storm','inferno','yinyang','hydro','shatter']);
    if (canvasDecoSet.has(deco)) {
      if (!wrap.classList.contains('avatar-wrap')) {
        wrap.style.position = 'relative';
        wrap.style.overflow = 'visible';
      } else {
        wrap.style.overflow = 'visible';
      }
    } else if (getComputedStyle(wrap).position === 'static') {
      wrap.style.position = 'relative';
    }

    // Remove stale deco elements and canvases
    wrap.querySelectorAll('.avatar-deco, .premium-deco, .storm-canvas, .stormveil-layer, .heheshuis-layer').forEach(e => e.remove());
    // Stop any running canvas engines first
    stopStormCanvas(wrap); stopInfernoCanvas(wrap); stopYinYangCanvas(wrap);
    stopHydroCanvas(wrap);
    stopShatterCanvas(wrap);

    // Canvas-only decos don't need an avatar-deco div — the canvas IS the visual
    const canvasOnlyDecos = new Set(['storm','inferno','yinyang','hydro','shatter']);
    if (!canvasOnlyDecos.has(deco)) {
      if (isPremiumDecoration(deco)) {
        renderPremiumDecoration(wrap, deco);
      } else {
        const decoEl = document.createElement('div');
        decoEl.className = 'avatar-deco deco-' + deco;
        wrap.appendChild(decoEl);

        if (deco === 'stormveil') {
          addStormveilLayers(wrap);
        } else if (deco === 'heheshuis_aura') {
          addHeheshuisLayers(wrap);
        }
      }
    }
    wrap.dataset.deco = deco;

    // Admin deco: floating crown
    if (deco === 'nexus_admin' && !wrap.querySelector('.admin-crown')) {
      const crown = document.createElement('span');
      crown.className = 'admin-crown';
      crown.textContent = '\u{1F451}';
      wrap.appendChild(crown);
    }
    if (deco !== 'nexus_admin') {
      const oldCrown = wrap.querySelector('.admin-crown');
      if (oldCrown) oldCrown.remove();
    }

    // Canvas engines
    if (deco === 'storm') {
      setTimeout(() => startStormCanvas(wrap), 50);
    } else { stopStormCanvas(wrap); }

    if (deco === 'inferno') {
      setTimeout(() => startInfernoCanvas(wrap), 50);
    } else { stopInfernoCanvas(wrap); }

    if (deco === 'yinyang') {
      setTimeout(() => startYinYangCanvas(wrap), 50);
    } else { stopYinYangCanvas(wrap); }

    if (deco === 'hydro') {
      setTimeout(() => startHydroCanvas(wrap), 50);
    } else { stopHydroCanvas(wrap); }

    if (deco === 'shatter') {
      setTimeout(() => startShatterCanvas(wrap), 80);
    } else { stopShatterCanvas(wrap); }


    // Shine overlay decos (diamond, goldshine)
    const shineDecos = ['diamond', 'goldshine'];
    const existingShine = wrap.querySelector('.deco-shine-overlay');
    if (existingShine) existingShine.remove();
    if (shineDecos.includes(deco)) {
      const shine = document.createElement('div');
      shine.className = `deco-shine-overlay deco-${deco}-shine`;
      wrap.appendChild(shine);
    }
  }

  // ---- Storm Canvas Engine ----
  // Map of wrap element -> { canvas, ctx, animId, phase, t, sparks }
  const stormCanvases = new WeakMap();

  function startStormCanvas(wrap) {
    if (stormCanvases.has(wrap)) return; // already running
    const avatarEl = wrap.querySelector('.avatar');
    const size = Math.max(10, avatarEl ? (avatarEl.offsetWidth || parseInt(avatarEl.style.width) || 36) : 36);
    const canvasSize = size + 40; // extra space for sparks outside ring

    const canvas = document.createElement('canvas');
    canvas.className = 'storm-canvas';
    canvas.width = canvasSize;
    canvas.height = canvasSize;
    canvas.style.width = canvasSize + 'px';
    canvas.style.height = canvasSize + 'px';
    wrap.appendChild(canvas);

    const ctx = canvas.getContext('2d');
    const cx = canvasSize / 2;
    const cy = canvasSize / 2;
    const r = size / 2 + 3; // ring radius just outside avatar

    // Spark particles
    const sparks = [];
    function spawnSpark(fromRing) {
      const angle = Math.random() * Math.PI * 2;
      const speed = fromRing ? (0.5 + Math.random() * 1.5) : (1 + Math.random() * 3);
      const ox = cx + Math.cos(angle) * r;
      const oy = cy + Math.sin(angle) * r;
      sparks.push({
        x: ox, y: oy,
        vx: Math.cos(angle) * speed * (0.5 + Math.random()),
        vy: Math.sin(angle) * speed * (0.5 + Math.random()),
        life: 1, decay: 0.03 + Math.random() * 0.05,
        size: 0.8 + Math.random() * 1.4,
        bright: fromRing
      });
    }

    // Lightning bolt path generator — jagged polyline from top to bottom
    function makeLightning(x1, y1, x2, y2, roughness, depth) {
      if (depth === 0) return [[x1,y1],[x2,y2]];
      const mx = (x1+x2)/2 + (Math.random()-0.5)*roughness;
      const my = (y1+y2)/2 + (Math.random()-0.5)*roughness;
      const a = makeLightning(x1,y1,mx,my, roughness*0.6, depth-1);
      const b = makeLightning(mx,my,x2,y2, roughness*0.6, depth-1);
      return [...a, ...b];
    }

    let phase = 0; // 0=sparks, 1=intensify, 2=strike, 3=afterglow
    let phaseT = 0;
    let ringAngle = 0;
    let ringAngle2 = 0;
    let lightningPath = null;
    let lightningAlpha = 0;
    let flashAlpha = 0;
    let lastTime = null;
    let animId;

    function draw(ts) {
      if (!lastTime) lastTime = ts;
      const dt = Math.min((ts - lastTime) / 1000, 0.05);
      lastTime = ts;
      phaseT += dt;

      ctx.clearRect(0, 0, canvasSize, canvasSize);

      // Phase transitions
      if (phase === 0 && phaseT > 3.0) { phase = 1; phaseT = 0; }
      else if (phase === 1 && phaseT > 0.6) { phase = 2; phaseT = 0;
        lightningPath = makeLightning(cx - 4 + Math.random()*8, cy - r - 4, cx - 6 + Math.random()*12, cy + r + 4, 12, 5);
        lightningAlpha = 1; flashAlpha = 1;
        // Burst of sparks on strike
        for (let i = 0; i < 20; i++) spawnSpark(false);
      }
      else if (phase === 2 && phaseT > 0.5) { phase = 3; phaseT = 0; lightningPath = null; }
      else if (phase === 3 && phaseT > 1.2) { phase = 0; phaseT = 0; }

      // Ring rotation
      ringAngle += dt * 2.8;
      ringAngle2 -= dt * 2.2;

      const intensity = phase === 1 ? (phaseT/0.6) : (phase === 2 ? 1 : phase === 3 ? Math.max(0, 1-phaseT/1.2) : 0.4);

      // Draw outer ring 1
      ctx.beginPath();
      ctx.arc(cx, cy, r + 5, 0, Math.PI*2);
      ctx.strokeStyle = `rgba(100,180,255,${0.15 + intensity*0.25})`;
      ctx.lineWidth = 1;
      ctx.stroke();

      // Draw orbiting arc 1
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(ringAngle);
      ctx.beginPath();
      ctx.arc(0, 0, r + 3, 0, Math.PI * 1.2);
      const g1 = ctx.createLinearGradient(-r, 0, r, 0);
      g1.addColorStop(0, `rgba(180,220,255,${0.9 + intensity*0.1})`);
      g1.addColorStop(0.5, `rgba(120,190,255,${0.6})`);
      g1.addColorStop(1, 'rgba(100,180,255,0)');
      ctx.strokeStyle = g1;
      ctx.lineWidth = 1.5 + intensity;
      ctx.shadowColor = '#88ccff';
      ctx.shadowBlur = 4 + intensity * 8;
      ctx.stroke();
      ctx.restore();

      // Draw orbiting arc 2 (opposite direction, outer)
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(ringAngle2);
      ctx.beginPath();
      ctx.arc(0, 0, r + 7, 0, Math.PI * 1.5);
      const g2 = ctx.createLinearGradient(-r, 0, r, 0);
      g2.addColorStop(0, `rgba(200,230,255,${0.7 + intensity*0.2})`);
      g2.addColorStop(1, 'rgba(160,210,255,0)');
      ctx.strokeStyle = g2;
      ctx.lineWidth = 1 + intensity * 0.5;
      ctx.shadowColor = '#aaddff';
      ctx.shadowBlur = 3 + intensity * 6;
      ctx.stroke();
      ctx.restore();

      // Spawn sparks from ring
      const spawnRate = phase === 0 ? 0.15 : phase === 1 ? 0.05 : 0.08;
      if (Math.random() < spawnRate + intensity * 0.2) spawnSpark(true);

      // Update and draw sparks
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        s.x += s.vx * (1 + intensity * 1.5);
        s.y += s.vy * (1 + intensity * 1.5);
        s.life -= s.decay + (phase === 2 ? 0.02 : 0);
        if (s.life <= 0) { sparks.splice(i, 1); continue; }
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.size * s.life, 0, Math.PI*2);
        const alpha = s.life * (s.bright ? 0.9 : 0.7);
        ctx.fillStyle = s.bright
          ? `rgba(200,230,255,${alpha})`
          : `rgba(255,255,255,${alpha})`;
        ctx.shadowColor = '#88ccff';
        ctx.shadowBlur = s.bright ? 4 : 6;
        ctx.fill();
      }

      // Full-avatar flash on strike
      if (phase === 2 && flashAlpha > 0) {
        flashAlpha = Math.max(0, 1 - phaseT / 0.5);
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, r - 1, 0, Math.PI*2);
        ctx.fillStyle = `rgba(180,220,255,${flashAlpha * 0.85})`;
        ctx.shadowColor = '#ffffff';
        ctx.shadowBlur = 20;
        ctx.fill();
        ctx.restore();
      }

      // Draw lightning bolt
      if (lightningPath && phase === 2) {
        lightningAlpha = Math.max(0, 1 - phaseT / 0.45);
        if (lightningAlpha > 0) {
          // Glow pass
          ctx.beginPath();
          ctx.moveTo(lightningPath[0][0], lightningPath[0][1]);
          for (let i = 1; i < lightningPath.length; i++) {
            ctx.lineTo(lightningPath[i][0], lightningPath[i][1]);
          }
          ctx.strokeStyle = `rgba(180,220,255,${lightningAlpha * 0.5})`;
          ctx.lineWidth = 6;
          ctx.shadowColor = '#88ccff';
          ctx.shadowBlur = 20;
          ctx.lineJoin = 'round';
          ctx.stroke();
          // Core pass
          ctx.beginPath();
          ctx.moveTo(lightningPath[0][0], lightningPath[0][1]);
          for (let i = 1; i < lightningPath.length; i++) {
            ctx.lineTo(lightningPath[i][0], lightningPath[i][1]);
          }
          ctx.strokeStyle = `rgba(255,255,255,${lightningAlpha})`;
          ctx.lineWidth = 1.5;
          ctx.shadowBlur = 8;
          ctx.stroke();
        }
      }

      animId = requestAnimationFrame(draw);
    }

    animId = requestAnimationFrame(draw);
    stormCanvases.set(wrap, { canvas, animId });
  }

  function stopStormCanvas(wrap) {
    const data = stormCanvases.get(wrap);
    if (data) {
      cancelAnimationFrame(data.animId);
      data.canvas.remove();
      stormCanvases.delete(wrap);
    }
  }

  // ---- Inferno Canvas ----
  // Phase 0 (4s): flames orbit the avatar ring only, never touch center
  // Phase 1 (0.8s transition): flames spread inward, filling the avatar
  // Phase 2 (1.5s): full fire engulfs avatar
  // Phase 3 (0.6s): flames recede back to ring
  const infernoCanvases = new WeakMap();

  function startInfernoCanvas(wrap) {
    if (infernoCanvases.has(wrap)) return;
    const avatarEl = wrap.querySelector('.avatar');
    const size = Math.max(10, avatarEl ? (avatarEl.offsetWidth || parseInt(avatarEl.style.width) || 36) : 36);
    const pad = 22;
    const W = size + pad*2, H = size + pad*2 + 8;
    const canvas = document.createElement('canvas');
    canvas.className = 'storm-canvas';
    canvas.width = W; canvas.height = H;
    canvas.style.width = W+'px'; canvas.style.height = H+'px';
    canvas.style.top = '50%'; canvas.style.left = '50%';
    canvas.style.transform = 'translate(-50%,-48%)';
    wrap.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    const cx = W/2, cy = H/2+3, r = size/2;

    // phase: 0=ring only, 1=spreading in, 2=full engulf, 3=receding
    let phase=0, phaseT=0, lastTime=null, animId;
    // spread: 0 = flames only at ring, 1 = flames fill whole avatar
    let spread = 0;

    const flames = [];
    function spawnFlame(forced) {
      // In phase 0, spawn only near ring edge
      // In phase 1/2, also spawn inside
      const p = spread;
      const angle = Math.random() * Math.PI * 2;
      // Origin: between (r - p*r*0.9) and (r + 4)
      const originR = (r - p * r * 0.85) + Math.random() * 6;
      const ox = cx + Math.cos(angle) * originR;
      const oy = cy + Math.sin(angle) * originR;
      // Velocity: outward when ring-only, more upward when spreading
      const outward = Math.cos(angle) * (0.2 + Math.random()*0.4) * (1-p*0.7);
      const upward  = -(0.8 + Math.random()*1.4) * (0.5 + p*0.8);
      flames.push({
        x: ox, y: oy,
        vx: outward + (Math.random()-0.5)*0.3,
        vy: upward,
        life: 1,
        decay: 0.02 + Math.random()*0.02,
        size: (2 + Math.random()*4) * (0.7 + p*0.8),
        hue: 5 + Math.random()*45,
      });
    }

    function draw(ts) {
      if (!lastTime) lastTime = ts;
      const dt = Math.min((ts-lastTime)/1000, 0.05); lastTime = ts;
      phaseT += dt;

      // Phase transitions
      if (phase===0 && phaseT>4)   { phase=1; phaseT=0; }
      if (phase===1 && phaseT>0.8) { phase=2; phaseT=0; }
      if (phase===2 && phaseT>1.5) { phase=3; phaseT=0; }
      if (phase===3 && phaseT>0.6) { phase=0; phaseT=0; }

      // Compute spread (0=ring only, 1=full cover)
      if (phase===0) spread = Math.max(0, spread - dt*2);
      if (phase===1) spread = Math.min(1, phaseT/0.8);
      if (phase===2) spread = 1;
      if (phase===3) spread = Math.max(0, 1 - phaseT/0.6);

      ctx.clearRect(0, 0, W, H);

      // Base glow ring (always present)
      const glowR = r + 4 + spread * 4;
      const grd = ctx.createRadialGradient(cx,cy,r-3,cx,cy,glowR+4);
      grd.addColorStop(0, `rgba(255,100,0,${0.4+spread*0.4})`);
      grd.addColorStop(0.5, `rgba(255,40,0,${0.2+spread*0.3})`);
      grd.addColorStop(1, 'transparent');
      ctx.beginPath(); ctx.arc(cx,cy,glowR+4,0,Math.PI*2);
      ctx.fillStyle=grd; ctx.fill();

      // When engulfing, also fill center with translucent fire glow
      if (spread > 0.1) {
        const inner = ctx.createRadialGradient(cx,cy,0,cx,cy,r);
        inner.addColorStop(0, `rgba(255,200,50,${spread*0.55})`);
        inner.addColorStop(0.5, `rgba(255,80,0,${spread*0.45})`);
        inner.addColorStop(1, `rgba(255,40,0,${spread*0.1})`);
        ctx.save();
        ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2);
        ctx.fillStyle=inner; ctx.fill();
        ctx.restore();
      }

      // Spawn flames
      const spawnCount = 2 + Math.round(spread * 4);
      for (let i=0; i<spawnCount; i++) spawnFlame();

      // Draw flames
      for (let i=flames.length-1; i>=0; i--) {
        const f = flames[i];
        f.x += f.vx; f.y += f.vy;
        f.vy -= 0.035;
        f.vx *= 0.97;
        f.life -= f.decay;
        f.size *= 0.974;
        if (f.life<=0||f.size<0.4) { flames.splice(i,1); continue; }
        const g = ctx.createRadialGradient(f.x,f.y,0,f.x,f.y,f.size);
        g.addColorStop(0, `hsla(${f.hue+30},100%,90%,${f.life})`);
        g.addColorStop(0.35,`hsla(${f.hue+10},100%,60%,${f.life*0.85})`);
        g.addColorStop(1,   `hsla(${f.hue-5},100%,25%,0)`);
        ctx.beginPath(); ctx.arc(f.x,f.y,f.size,0,Math.PI*2);
        ctx.fillStyle=g; ctx.fill();
      }
      animId = requestAnimationFrame(draw);
    }
    animId = requestAnimationFrame(draw);
    infernoCanvases.set(wrap, { canvas, animId });
  }

  function stopInfernoCanvas(wrap) {
    const d = infernoCanvases.get(wrap);
    if (d) { cancelAnimationFrame(d.animId); d.canvas.remove(); infernoCanvases.delete(wrap); }
  }

  // ---- Yin Yang Canvas ----
  // Phase 0 (5s): split ring — left white, right dark, slowly rotating
  // Phase 1 (0.8s): arcs begin spinning inward, blending/mixing
  // Phase 2 (1.5s): full yin-yang symbol, slowly rotating
  // Phase 3 (0.7s): symbol dissolves back out to split ring
  const yinYangCanvases = new WeakMap();

  function startYinYangCanvas(wrap) {
    if (yinYangCanvases.has(wrap)) return;
    const avatarEl = wrap.querySelector('.avatar');
    const size = Math.max(10, avatarEl ? (avatarEl.offsetWidth || parseInt(avatarEl.style.width) || 36) : 36);
    const W = size + 16, H = size + 16;
    const canvas = document.createElement('canvas');
    canvas.className = 'storm-canvas';
    canvas.width = W; canvas.height = H;
    canvas.style.width = W+'px'; canvas.style.height = H+'px';
    wrap.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    const cx = W/2, cy = H/2, r = size/2 + 3;

    let phase=0, phaseT=0, lastTime=null, animId;
    let spinAngle = 0; // rotation for mixing animation

    // Ease in/out helper
    const easeInOut = t => t < 0.5 ? 2*t*t : -1+(4-2*t)*t;

    function drawSplitRing(alpha, rotation) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(cx, cy);
      ctx.rotate(rotation);
      // White half
      ctx.beginPath(); ctx.arc(0,0,r, Math.PI/2, -Math.PI/2, false);
      ctx.strokeStyle='rgba(255,255,255,0.95)'; ctx.lineWidth=2.5;
      ctx.shadowColor='rgba(255,255,255,0.7)'; ctx.shadowBlur=5;
      ctx.stroke();
      // Dark half
      ctx.beginPath(); ctx.arc(0,0,r,-Math.PI/2,Math.PI/2,false);
      ctx.strokeStyle='rgba(40,40,40,0.95)'; ctx.lineWidth=2.5;
      ctx.shadowColor='rgba(0,0,0,0.5)'; ctx.shadowBlur=5;
      ctx.stroke();
      ctx.shadowBlur=0;
      ctx.restore();
    }

    function drawYinYang(alpha, rotation, scale) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(cx, cy);
      ctx.rotate(rotation);
      ctx.scale(scale, scale);
      const sr = r * 0.96;
      // Clip to circle
      ctx.beginPath(); ctx.arc(0,0,sr,0,Math.PI*2); ctx.clip();
      // Dark half (right)
      ctx.beginPath(); ctx.arc(0,0,sr,-Math.PI/2,Math.PI/2); ctx.fillStyle='#111'; ctx.fill();
      // Light half (left)
      ctx.beginPath(); ctx.arc(0,0,sr,Math.PI/2,-Math.PI/2); ctx.fillStyle='#eee'; ctx.fill();
      // Top small dark semicircle
      ctx.beginPath(); ctx.arc(0,-sr/2,sr/2,0,Math.PI*2); ctx.fillStyle='#111'; ctx.fill();
      // Bottom small light semicircle
      ctx.beginPath(); ctx.arc(0,sr/2,sr/2,0,Math.PI*2); ctx.fillStyle='#eee'; ctx.fill();
      // Dots
      ctx.beginPath(); ctx.arc(0,-sr/2,sr/6,0,Math.PI*2); ctx.fillStyle='#eee'; ctx.fill();
      ctx.beginPath(); ctx.arc(0,sr/2,sr/6,0,Math.PI*2); ctx.fillStyle='#111'; ctx.fill();
      ctx.restore();
      // Outer ring glow
      ctx.save();
      ctx.globalAlpha = alpha * 0.6;
      ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2);
      ctx.strokeStyle='rgba(180,180,180,0.6)'; ctx.lineWidth=1.5; ctx.stroke();
      ctx.restore();
    }

    function draw(ts) {
      if (!lastTime) lastTime = ts;
      const dt = Math.min((ts-lastTime)/1000, 0.05); lastTime = ts;
      phaseT += dt;

      if (phase===0 && phaseT>5)   { phase=1; phaseT=0; spinAngle=0; }
      if (phase===1 && phaseT>0.8) { phase=2; phaseT=0; }
      if (phase===2 && phaseT>1.5) { phase=3; phaseT=0; }
      if (phase===3 && phaseT>0.7) { phase=0; phaseT=0; spinAngle=0; }

      ctx.clearRect(0,0,W,H);

      if (phase===0) {
        // Idle: static split ring
        drawSplitRing(1, 0);
      }
      else if (phase===1) {
        // Mixing: arcs spin faster and faster, fading into symbol
        const t = easeInOut(phaseT/0.8);
        spinAngle += dt * (2 + t * 12); // accelerate spin
        const ringAlpha = 1 - t * 0.3;
        const symAlpha  = t;
        const symScale  = 0.4 + t * 0.6;
        drawSplitRing(ringAlpha, spinAngle);
        drawYinYang(symAlpha, spinAngle * 0.3, symScale);
      }
      else if (phase===2) {
        // Full symbol, slowly rotating
        spinAngle += dt * 0.4;
        drawYinYang(1, spinAngle, 1);
      }
      else if (phase===3) {
        // Dissolve back: symbol shrinks and splits back to ring
        const t = easeInOut(phaseT/0.7);
        spinAngle += dt * (0.4 + t * 8); // spin up again before breaking
        const symAlpha  = 1 - t;
        const symScale  = 1 - t * 0.3;
        const ringAlpha = t;
        drawYinYang(symAlpha, spinAngle, symScale);
        drawSplitRing(ringAlpha, spinAngle);
      }

      animId = requestAnimationFrame(draw);
    }
    animId = requestAnimationFrame(draw);
    yinYangCanvases.set(wrap, { canvas, animId });
  }

  function stopYinYangCanvas(wrap) {
    const d = yinYangCanvases.get(wrap);
    if (d) { cancelAnimationFrame(d.animId); d.canvas.remove(); yinYangCanvases.delete(wrap); }
  }

  // ---- Hydro Canvas ----
  // Idle: two water rings orbit + small bubble particles
  // Every 6s: a water ripple wave sweeps across the avatar
  const hydroCanvases = new WeakMap();

  function startHydroCanvas(wrap) {
    if (hydroCanvases.has(wrap)) return;
    const avatarEl = wrap.querySelector('.avatar');
    const size = Math.max(10, avatarEl ? (avatarEl.offsetWidth || parseInt(avatarEl.style.width) || 36) : 36);
    const pad = 14;
    const W = size + pad*2, H = size + pad*2;
    const canvas = document.createElement('canvas');
    canvas.className = 'storm-canvas';
    canvas.width = W; canvas.height = H;
    canvas.style.width = W+'px'; canvas.style.height = H+'px';
    wrap.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    const cx = W/2, cy = H/2, r = size/2;

    let phase=0, phaseT=0, lastTime=null, animId;
    let angle1=0, angle2=0;
    // Ripple state
    let rippleR=0, rippleAlpha=0;

    const bubbles = [];
    function spawnBubble() {
      const a = Math.random()*Math.PI*2;
      const or = r + 2 + Math.random()*6;
      bubbles.push({
        x: cx + Math.cos(a)*or, y: cy + Math.sin(a)*or,
        vx: (Math.random()-0.5)*0.3, vy: -(0.2+Math.random()*0.4),
        r: 1+Math.random()*2, life:1, decay:0.015+Math.random()*0.015
      });
    }

    function draw(ts) {
      if (!lastTime) lastTime = ts;
      const dt = Math.min((ts-lastTime)/1000, 0.05); lastTime = ts;
      phaseT += dt;
      angle1 += dt*1.8; angle2 -= dt*1.2;

      // Phase: 0=idle (6s), 1=ripple swell in (0.5s), 2=hold (1s), 3=recede (0.8s)
      if (phase===0 && phaseT>6)   { phase=1; phaseT=0; rippleR=r*0.1; }
      if (phase===1 && phaseT>0.5) { phase=2; phaseT=0; }
      if (phase===2 && phaseT>1.0) { phase=3; phaseT=0; }
      if (phase===3 && phaseT>0.8) { phase=0; phaseT=0; }

      ctx.clearRect(0,0,W,H);

      // Idle ring glow
      const g = ctx.createRadialGradient(cx,cy,r-2,cx,cy,r+8);
      g.addColorStop(0,'rgba(0,160,220,0.5)');
      g.addColorStop(0.6,'rgba(0,120,200,0.2)');
      g.addColorStop(1,'transparent');
      ctx.beginPath(); ctx.arc(cx,cy,r+8,0,Math.PI*2);
      ctx.fillStyle=g; ctx.fill();

      // Orbiting arcs
      ctx.save(); ctx.translate(cx,cy); ctx.rotate(angle1);
      ctx.beginPath(); ctx.arc(0,0,r+4,0,Math.PI*1.3);
      const ga1=ctx.createLinearGradient(-r,0,r,0);
      ga1.addColorStop(0,'rgba(0,200,255,0.9)'); ga1.addColorStop(1,'rgba(0,200,255,0)');
      ctx.strokeStyle=ga1; ctx.lineWidth=2; ctx.shadowColor='#00ccff'; ctx.shadowBlur=6; ctx.stroke();
      ctx.restore();

      ctx.save(); ctx.translate(cx,cy); ctx.rotate(angle2);
      ctx.beginPath(); ctx.arc(0,0,r+7,0,Math.PI*1.6);
      const ga2=ctx.createLinearGradient(-r,0,r,0);
      ga2.addColorStop(0,'rgba(100,220,255,0.7)'); ga2.addColorStop(1,'rgba(100,220,255,0)');
      ctx.strokeStyle=ga2; ctx.lineWidth=1.5; ctx.shadowColor='#66ddff'; ctx.shadowBlur=4; ctx.stroke();
      ctx.restore();
      ctx.shadowBlur=0;

      // Bubbles
      if (Math.random()<0.12) spawnBubble();
      for (let i=bubbles.length-1; i>=0; i--) {
        const b=bubbles[i];
        b.x+=b.vx; b.y+=b.vy; b.life-=b.decay;
        if (b.life<=0) { bubbles.splice(i,1); continue; }
        ctx.beginPath(); ctx.arc(b.x,b.y,b.r,0,Math.PI*2);
        ctx.strokeStyle=`rgba(160,230,255,${b.life*0.8})`; ctx.lineWidth=0.8; ctx.stroke();
      }

      // Ripple wave
      if (phase===1) {
        rippleR = r * (phaseT/0.5);
        rippleAlpha = phaseT/0.5;
      } else if (phase===2) {
        rippleR = r;
        rippleAlpha = 1;
        // Draw water-cover effect — translucent blue fill + shimmer
        ctx.save();
        const cover = ctx.createRadialGradient(cx,cy-r*0.3,0,cx,cy,r);
        cover.addColorStop(0,'rgba(120,210,255,0.55)');
        cover.addColorStop(0.5,'rgba(0,160,220,0.45)');
        cover.addColorStop(1,'rgba(0,100,180,0.3)');
        ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2);
        ctx.fillStyle=cover; ctx.fill();
        // Shimmer lines
        const shimmerT = (phaseT/1.0);
        for (let i=0; i<3; i++) {
          const y = cy - r + (2*r) * ((shimmerT*0.8 + i*0.33) % 1);
          const hw = Math.sqrt(Math.max(0, r*r - (y-cy)*(y-cy)));
          ctx.beginPath(); ctx.moveTo(cx-hw, y); ctx.lineTo(cx+hw, y);
          ctx.strokeStyle=`rgba(200,240,255,${0.25*(1-(i*0.3))})`;
          ctx.lineWidth=1.5; ctx.stroke();
        }
        ctx.restore();
      } else if (phase===3) {
        rippleR = r * (1 + phaseT/0.8 * 0.5);
        rippleAlpha = 1 - phaseT/0.8;
      }

      if (phase>0) {
        ctx.beginPath(); ctx.arc(cx,cy,rippleR,0,Math.PI*2);
        ctx.strokeStyle=`rgba(0,200,255,${rippleAlpha*0.7})`;
        ctx.lineWidth=2; ctx.shadowColor='#00ccff'; ctx.shadowBlur=8; ctx.stroke();
        ctx.shadowBlur=0;
      }

      animId = requestAnimationFrame(draw);
    }
    animId = requestAnimationFrame(draw);
    hydroCanvases.set(wrap, { canvas, animId });
  }

  function stopHydroCanvas(wrap) {
    const d = hydroCanvases.get(wrap);
    if (d) { cancelAnimationFrame(d.animId); d.canvas.remove(); hydroCanvases.delete(wrap); }
  }



  // ---- Shatter Canvas ----
  const shatterCanvases = new WeakMap();

  function startShatterCanvas(wrap) {
    if (shatterCanvases.has(wrap)) return;
    const av = wrap.querySelector('.avatar');
    const S  = Math.max(20,(av&&av.offsetWidth)||(av&&parseInt(av.style.width))||36);
    const R  = S/2, CX = R, CY = R;
    const PAD = Math.ceil(S*0.5); // room for shards to poke out

    const cv = document.createElement('canvas');
    cv.width  = S + PAD*2;
    cv.height = S + PAD*2;
    cv.style.cssText = `position:absolute;top:${-PAD}px;left:${-PAD}px;`+
      `width:${S+PAD*2}px;height:${S+PAD*2}px;pointer-events:none;z-index:5;`;
    wrap.style.overflow = 'visible';
    if (getComputedStyle(wrap).position==='static') wrap.style.position='relative';
    wrap.appendChild(cv);
    const g = cv.getContext('2d');
    const OX = PAD, OY = PAD; // avatar center on canvas = (OX+CX, OY+CY)

    // ---- generate crack lines (not filled polygons) ----
    function mkCracks() {
      // 6-10 jagged lines from a central impact point
      const lines = [];
      const ix = CX + (Math.random()-0.5)*R*0.3;
      const iy = CY + (Math.random()-0.5)*R*0.3;
      const N  = 6 + Math.floor(Math.random()*5);
      for (let i=0; i<N; i++) {
        const baseAngle = (i/N)*Math.PI*2 + (Math.random()-0.5)*0.4;
        const length    = R*(0.5 + Math.random()*0.55);
        const pts = [[ix, iy]];
        let x=ix, y=iy;
        const segs = 4 + Math.floor(Math.random()*3);
        for (let s=0; s<segs; s++) {
          const jitter = (Math.random()-0.5)*0.5;
          const segLen = (length/segs)*(0.7+Math.random()*0.6);
          x += Math.cos(baseAngle+jitter)*segLen;
          y += Math.sin(baseAngle+jitter)*segLen;
          // clip to circle
          const dist = Math.sqrt((x-CX)**2+(y-CY)**2);
          if (dist > R*0.98) {
            const clip = R*0.98/dist;
            x = CX+(x-CX)*clip; y = CY+(y-CY)*clip;
            pts.push([x,y]); break;
          }
          pts.push([x,y]);
          // random branch
          if (Math.random()<0.4 && s===Math.floor(segs/2)) {
            const bAngle = baseAngle+(Math.random()-0.5)*1.2;
            const bLen   = length*0.35;
            let bx=x, by=y;
            const bPts = [[x,y]];
            for (let b=0;b<3;b++){
              bx+=Math.cos(bAngle+(Math.random()-0.5)*0.3)*bLen/3;
              by+=Math.sin(bAngle+(Math.random()-0.5)*0.3)*bLen/3;
              const bd=Math.sqrt((bx-CX)**2+(by-CY)**2);
              if(bd>R*0.97){break;}
              bPts.push([bx,by]);
            }
            lines.push({pts:bPts, branch:true});
          }
        }
        lines.push({pts, branch:false});
      }
      return {lines, ix, iy};
    }

    // ---- generate shards for explosion phase only ----
    function mkShards(crackData) {
      const arr=[];
      const N=10+Math.floor(Math.random()*5);
      const protrude = new Set();
      // Pick top shards to protrude upward
      while(protrude.size<2) protrude.add(Math.floor(Math.random()*N));
      for(let i=0;i<N;i++){
        const a0=(i/N)*Math.PI*2+(Math.random()-0.5)*0.25;
        const a1=((i+1)/N)*Math.PI*2+(Math.random()-0.5)*0.25;
        const am=(a0+a1)/2;
        const ri=R*(0.03+Math.random()*0.15);
        const ro=R*(0.78+Math.random()*0.22);
        const pts=[
          [CX+Math.cos(a0)*ri, CY+Math.sin(a0)*ri],
          [CX+Math.cos(am)*ri*0.35, CY+Math.sin(am)*ri*0.35],
          [CX+Math.cos(a1)*ri, CY+Math.sin(a1)*ri],
          [CX+Math.cos(a1)*ro, CY+Math.sin(a1)*ro],
          [CX+Math.cos(am)*(ro+R*0.03), CY+Math.sin(am)*(ro+R*0.03)],
          [CX+Math.cos(a0)*ro, CY+Math.sin(a0)*ro],
        ];
        const bcx=pts.reduce((s,p)=>s+p[0],0)/pts.length;
        const bcy=pts.reduce((s,p)=>s+p[1],0)/pts.length;
        const da=Math.atan2(bcy-CY,bcx-CX);
        const isP=protrude.has(i);
        arr.push({
          pts, bcx, bcy,
          vx: isP?(Math.random()-0.5)*0.4:Math.cos(da)*(0.5+Math.random()*0.8),
          vy: isP?-(1.0+Math.random()*0.8):Math.sin(da)*(0.5+Math.random()*0.8),
          vr: (Math.random()-0.5)*0.08,
          dx:0,dy:0,dr:0, protrude:isP,
        });
      }
      return arr;
    }

    // Draw crack lines: white glow + dark thin core
    function drawLines(lines, alpha, progress) {
      if(alpha<=0) return;
      g.save();
      g.beginPath(); g.arc(OX+CX,OY+CY,R,0,Math.PI*2); g.clip();
      lines.forEach(({pts,branch},li)=>{
        const lineProgress = Math.min(1, progress*(lines.length)-li*0.5);
        if(lineProgress<=0) return;
        const end=Math.floor((pts.length-1)*lineProgress)+1;
        const subPts=pts.slice(0,Math.max(2,end));
        g.beginPath();
        g.moveTo(OX+subPts[0][0],OY+subPts[0][1]);
        for(let k=1;k<subPts.length;k++) g.lineTo(OX+subPts[k][0],OY+subPts[k][1]);
        // White glow (refraction at crack edge)
        g.shadowColor='rgba(240,250,255,1)';
        g.shadowBlur=branch?1.5:2.5;
        g.strokeStyle=`rgba(245,252,255,${alpha*(branch?0.65:0.9)})`;
        g.lineWidth=branch?0.5:0.7;
        g.stroke();
        // Dark core (the actual gap)
        g.shadowBlur=0;
        g.strokeStyle=`rgba(0,10,30,${alpha*0.4})`;
        g.lineWidth=branch?0.25:0.35;
        g.stroke();
      });
      g.restore();
    }

    // Draw shard during explosion — NO fill, only edges
    function drawShard(s, alpha) {
      if(alpha<=0.01) return;
      g.save();
      g.globalAlpha=alpha;
      g.translate(OX+s.bcx+s.dx, OY+s.bcy+s.dy);
      g.rotate(s.dr);
      g.translate(-(OX+s.bcx),-(OY+s.bcy));
      g.beginPath();
      g.moveTo(OX+s.pts[0][0],OY+s.pts[0][1]);
      for(let k=1;k<s.pts.length;k++) g.lineTo(OX+s.pts[k][0],OY+s.pts[k][1]);
      g.closePath();
      // NO fill — glass is transparent
      // Only edges: white glow
      g.shadowColor='rgba(230,245,255,0.9)';
      g.shadowBlur=2;
      g.strokeStyle='rgba(240,250,255,0.85)';
      g.lineWidth=0.6;
      g.stroke();
      g.shadowBlur=0;
      g.restore();
    }

    const ease=t=>1-(1-t)*(1-t);
    let crackData=mkCracks(), shards=null;
    let ph=0,pt=0,lt=null,aid,ga=0;

    function frame(ts){
      if(!lt) lt=ts;
      const dt=Math.min((ts-lt)/1000,0.05); lt=ts; pt+=dt; ga+=dt*0.45;

      // phases: 0=cracks form(1.0s) 1=hold cracked(2.5s) 2=shatter(0.7s) 3=settle(0.5s) 4=idle(5s) 5=reform(1.0s)
      if(ph===0&&pt>1.0){ph=1;pt=0;}
      if(ph===1&&pt>2.5){ph=2;pt=0;shards=mkShards(crackData);}
      if(ph===2&&pt>0.7){ph=3;pt=0;}
      if(ph===3&&pt>0.5){ph=4;pt=0;crackData=mkCracks();shards=null;}
      if(ph===4&&pt>5.0){ph=5;pt=0;}
      if(ph===5&&pt>1.0){ph=0;pt=0;}

      g.clearRect(0,0,cv.width,cv.height);

      if(ph===0){
        // Cracks grow in progressively — NO shards yet, avatar fully visible
        drawLines(crackData.lines, ease(pt/1.0), ease(pt/1.0));
        // Faint ring
        g.beginPath(); g.arc(OX+CX,OY+CY,R,0,Math.PI*2);
        g.strokeStyle=`rgba(200,230,255,${ease(pt/1.0)*0.35})`; g.lineWidth=0.8; g.stroke();
      }
      else if(ph===1){
        // Cracked glass — just the crack lines and a glint, avatar still visible
        drawLines(crackData.lines, 0.88, 1.0);
        // Glint sweep across the cracked surface
        const gx1=OX+CX+Math.cos(ga)*R*1.3, gy1=OY+CY+Math.sin(ga)*R*1.3;
        const gx2=OX+CX-Math.cos(ga)*R*1.3, gy2=OY+CY-Math.sin(ga)*R*1.3;
        const gl=g.createLinearGradient(gx1,gy1,gx2,gy2);
        gl.addColorStop(0.44,'transparent');
        gl.addColorStop(0.50,'rgba(255,255,255,0.35)');
        gl.addColorStop(0.56,'transparent');
        g.save(); g.beginPath(); g.arc(OX+CX,OY+CY,R,0,Math.PI*2); g.clip();
        g.fillStyle=gl; g.fillRect(0,0,cv.width,cv.height);
        g.restore();
        g.beginPath(); g.arc(OX+CX,OY+CY,R,0,Math.PI*2);
        g.strokeStyle='rgba(200,230,255,0.4)'; g.lineWidth=0.8; g.stroke();
      }
      else if(ph===2){
        // SHATTER: crack lines vanish, shards explode outward
        const t=ease(pt/0.7);
        if(pt<0.05){
          g.save(); g.beginPath(); g.arc(OX+CX,OY+CY,R,0,Math.PI*2); g.clip();
          g.fillStyle=`rgba(245,252,255,${(0.05-pt)/0.05*0.7})`; g.fillRect(0,0,cv.width,cv.height);
          g.restore();
        }
        drawLines(crackData.lines, Math.max(0,1-t*3), 1.0);
        if(shards) shards.forEach(s=>{
          s.dx+=s.vx*(1+t*4)*dt*60;
          s.dy+=s.vy*(1+t*4)*dt*60;
          s.dr+=s.vr*dt*60;
          if(s.protrude){
            s.vy+=0.035; // gravity
            drawShard(s, Math.max(0,1-pt/0.7*0.5));
          } else {
            const d=Math.sqrt(s.dx*s.dx+s.dy*s.dy);
            drawShard(s, Math.max(0,1-d/(R*0.85)));
          }
        });
      }
      else if(ph===3){
        // Settle: protruding shards still falling, others gone
        const fade=1-pt/0.5;
        if(shards) shards.forEach(s=>{
          if(s.protrude){
            s.vy+=0.05;
            s.dx+=s.vx*0.04*dt*60; s.dy+=s.vy*0.04*dt*60;
            drawShard(s, fade*0.8);
          }
        });
      }
      else if(ph===4){
        // Idle: just a very faint frost ring, avatar fully visible
        g.beginPath(); g.arc(OX+CX,OY+CY,R-0.5,0,Math.PI*2);
        g.strokeStyle='rgba(160,210,255,0.25)'; g.lineWidth=0.8; g.stroke();
      }
      else if(ph===5){
        // Reform: crack lines draw back in
        const t=ease(pt/1.0);
        drawLines(crackData.lines, t*0.88, t);
        g.beginPath(); g.arc(OX+CX,OY+CY,R,0,Math.PI*2);
        g.strokeStyle=`rgba(200,230,255,${t*0.35})`; g.lineWidth=0.8; g.stroke();
      }

      aid=requestAnimationFrame(frame);
    }
    aid=requestAnimationFrame(frame);
    shatterCanvases.set(wrap,{canvas:cv,animId:aid});
  }

  function stopShatterCanvas(wrap) {
    const d = shatterCanvases.get(wrap);
    if (d) { cancelAnimationFrame(d.animId); d.canvas.remove(); shatterCanvases.delete(wrap); }
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
    try {
      return await requestJson(method, path, data ? JSON.stringify(data) : null, { 'Content-Type': 'application/json' });
    } catch (e) {
      console.error('Network error:', e);
      return { error: 'Network error: ' + e.message };
    }
  }

  async function checkAuth() {
    return api('GET', '/api/auth/me');
  }

  async function init() {
    const auth = await checkAuth();
    if (auth && auth.suspended) {
      showSuspensionScreen(null, auth.suspendedUntil, auth.suspendedReason || null);
      return;
    }
    if (auth && auth.user) {
      currentUser = auth.user;
      enterApp();
    } else {
      showScreen('auth-screen');
    }
  }

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    $(id).classList.add('active');
  }

  function showSuspensionScreen(errorMsg, until, reason) {
    stopSecretHum();
    // Parse "suspended until <date>" from error message if no until provided
    let untilText = 'an unknown time';
    if (until) {
      untilText = new Date(until * 1000).toLocaleString();
    } else if (errorMsg) {
      const m = errorMsg.match(/until (.+)$/);
      if (m) untilText = m[1];
    }
    $('suspension-until').textContent = 'Suspended until: ' + untilText;
    if (reason) {
      $('suspension-reason-text').textContent = reason;
      $('suspension-reason-box').style.display = 'block';
    } else {
      $('suspension-reason-box').style.display = 'none';
    }
    showScreen('suspension-screen');
  }

  window.logoutFromSuspension = async function() {
    await api('POST', '/api/auth/logout');
    stopSecretHum();
    leaveGroupCall(false);
    showScreen('auth-screen');
  };

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
    if (r && r.suspended) {
      showSuspensionScreen(null, r.suspendedUntil, r.suspendedReason || null);
      return;
    }
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
      syncSecretAmbient();
      showScreen('main-screen');
      loadPersistedClientState();
      connectSocket();
      loadFriends();
      loadPendingRequests();
      loadServers();
      loadServerInvites();
      switchView('friends');
      if (activeView === 'shop') loadShop();
      checkAdminStatus();
    } catch(e) {
      console.error('enterApp crash:', e);
      alert('Login succeeded but app failed to load: ' + e.message);
    }
  }

  async function loadPersistedClientState() {
    const r = await api('GET', '/api/users/client-state');
    if (r && !r.error && r.state && r.state.paused) {
      pauseNexusClient(r.state.message || 'This Nexus client is temporarily paused.');
      return;
    }
    unpauseNexusClient();
  }

  function updateSelfCard() {
    if (!currentUser) return;
    $('self-display-name').textContent = currentUser.displayName;
    $('self-username').textContent = '@' + currentUser.username;
    const el = $('self-avatar-display');
    renderAvatar(el, currentUser);
  }

  // ---- Mobile sidebar ----
  function isMobile() { return window.innerWidth <= 680; }

  function openMobileSidebar() {
    const sidebar = document.querySelector('.sidebar');
    const backdrop = $('sidebar-backdrop');
    if (sidebar) sidebar.classList.add('open');
    if (backdrop) backdrop.classList.add('active');
  }

  function closeMobileSidebar() {
    const sidebar = document.querySelector('.sidebar');
    const backdrop = $('sidebar-backdrop');
    if (sidebar) sidebar.classList.remove('open');
    if (backdrop) backdrop.classList.remove('active');
  }

  $('mobile-menu-btn').addEventListener('click', () => {
    const sidebar = document.querySelector('.sidebar');
    if (sidebar && sidebar.classList.contains('open')) {
      closeMobileSidebar();
    } else {
      openMobileSidebar();
    }
  });

  $('sidebar-backdrop').addEventListener('click', closeMobileSidebar);

  function setMobileTitle(title) {
    const el = $('mobile-topbar-title');
    if (el) el.textContent = title;
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
    $('server-boost-btn').title = `Boost ${r.server.name} (${r.server.boostCount || 0} active)`;

    // Show settings + add-channel only for admin/owner
    const me = r.members.find(m => m.id === currentUser.id);
    const isAdmin = me && (me.role === 'admin' || me.isAdmin);
    isCurrentServerAdmin = !!isAdmin;
    $('server-settings-btn').style.display = isAdmin ? 'flex' : 'none';
    $('add-channel-btn').style.display = isAdmin ? 'flex' : 'none';
    if ($('channel-edit-btn')) $('channel-edit-btn').style.display = isAdmin ? 'flex' : 'none';

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
         data-channel-type="${esc(c.type || 'text')}"
         data-channel-locked="${c.locked ? '1' : '0'}"
         data-channel-topic="${esc(c.topic || '')}"
         data-channel-slowmode="${parseInt(c.slowmodeSeconds || 0, 10)}">
        <span class="ch-hash">${(c.type === 'voice') ? '🔊' : (c.locked ? '🔒' : c.private ? '👁' : '#')}</span>
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
        const type = el.dataset.channelType || 'text';
        const locked = el.dataset.channelLocked === '1';
        const topic = el.dataset.channelTopic || null;
        const slowmodeSeconds = parseInt(el.dataset.channelSlowmode || '0', 10) || 0;
        openChannel({ id: chId, name: chName, type, locked, topic, slowmodeSeconds });
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
          <span class="member-name" style="${roleStyle}">${esc(m.displayName)}${server && server.tag ? ` <span class="member-role" style="color:var(--text-secondary)">[${esc(server.tag)}]</span>` : ''}</span>
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
    if (groupCallState && groupCallState.roomId) {
      const switchingAway = groupCallState.channelId !== channel.id || (channel.type || 'text') !== 'voice';
      if (switchingAway) leaveGroupCall(true);
    }

    // Clear messages immediately before switching so old messages never bleed through
    $('channel-messages-list').innerHTML = '';
    $('channel-typing-indicator').style.display = 'none';
    chLoadingOlder = false;

    activeChannelId = channel.id;
    activeChannelType = channel.type || 'text';
    activeChannelTopic = channel.topic || null;
    activeChannelSlowmode = Math.max(0, parseInt(channel.slowmodeSeconds, 10) || 0);
    setChannelReply(null);

    document.querySelectorAll('.channel-item').forEach(el => {
      el.classList.toggle('active', el.dataset.channelId === channel.id);
    });
    $('channel-name-header').textContent = channel.name;
    if ($('channel-topic-header')) {
      if (activeChannelTopic) {
        $('channel-topic-header').textContent = activeChannelTopic;
        $('channel-topic-header').style.display = 'block';
      } else {
        $('channel-topic-header').textContent = '';
        $('channel-topic-header').style.display = 'none';
      }
    }
    const slowmodeHint = activeChannelSlowmode > 0 ? ` (slowmode ${activeChannelSlowmode}s)` : '';
    if (activeChannelType === 'voice') {
      $('channel-message-input').placeholder = 'Voice channel - use voice controls in header';
      $('channel-message-input').disabled = true;
      $('channel-send-btn').style.display = 'none';
      if ($('group-call-btn')) $('group-call-btn').style.display = 'inline-flex';
      if ($('group-camera-btn')) $('group-camera-btn').style.display = 'inline-flex';
      if ($('group-screen-btn')) $('group-screen-btn').style.display = 'inline-flex';
    } else {
      $('channel-message-input').placeholder = 'Message #' + channel.name + slowmodeHint + '…';
      $('channel-message-input').disabled = false;
      $('channel-send-btn').style.display = 'inline-flex';
      if ($('group-call-btn')) $('group-call-btn').style.display = 'none';
      if ($('group-camera-btn')) $('group-camera-btn').style.display = 'none';
      if ($('group-screen-btn')) $('group-screen-btn').style.display = 'none';
    }
    setMobileTitle('#' + channel.name);
    if (isMobile()) closeMobileSidebar();
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
    const isAdmin = me && (me.role === 'admin' || me.isAdmin);
    isCurrentServerAdmin = !!isAdmin;
    renderChannelList(s.channels, isAdmin);
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
  if ($('channel-edit-btn')) $('channel-edit-btn').addEventListener('click', () => window.openChannelSettingsQuick());
  if ($('channel-pins-btn')) $('channel-pins-btn').addEventListener('click', () => window.openChannelPins());
  if ($('group-call-btn')) $('group-call-btn').addEventListener('click', async () => {
    if (!socket || !activeServerId || !activeChannelId) return;
    if (activeChannelType !== 'voice') return toast('Join a voice channel to start voice chat', 'error');
    if (callState || outgoingCallTo) return toast('Finish your direct call first', 'error');

    if (groupCallState && groupCallState.roomId) {
      leaveGroupCall(true);
      return;
    }

    try {
      const local = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      groupCallState = {
        roomId: null,
        serverId: activeServerId,
        channelId: activeChannelId,
        localStream: local,
        users: new Map(),
        localVideoTrack: null,
        localVideoMode: 'off',
        peers: new Map(),
        audios: new Map()
      };
      socket.emit('join_group_call', { serverId: activeServerId, channelId: activeChannelId });
      $('group-call-btn').classList.add('active');
      $('group-call-btn').title = 'Leave Group Voice Chat';
      toast('Joining group voice…', 'info');
    } catch (e) {
      groupCallState = null;
      toast('Microphone access is required for group voice', 'error');
    }
  });

  if ($('group-camera-btn')) $('group-camera-btn').addEventListener('click', async () => {
    if (!groupCallState || !groupCallState.roomId) return toast('Join voice channel first', 'info');
    if (groupCallState.localVideoMode === 'camera') {
      await stopGroupVideoMode();
      $('group-camera-btn').classList.remove('active');
      return;
    }
    try {
      if (groupScreenStream) {
        groupScreenStream.getTracks().forEach(t => t.stop());
        groupScreenStream = null;
      }
      groupCameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      const track = groupCameraStream.getVideoTracks()[0];
      await applyGroupVideoTrack(track, 'camera');
      $('group-camera-btn').classList.add('active');
      if ($('group-screen-btn')) $('group-screen-btn').classList.remove('active');
      track.onended = async () => {
        await stopGroupVideoMode();
        if ($('group-camera-btn')) $('group-camera-btn').classList.remove('active');
      };
    } catch (e) {
      toast('Camera permission denied', 'error');
    }
  });

  if ($('group-screen-btn')) $('group-screen-btn').addEventListener('click', async () => {
    if (!groupCallState || !groupCallState.roomId) return toast('Join voice channel first', 'info');
    if (groupCallState.localVideoMode === 'screen') {
      await stopGroupVideoMode();
      $('group-screen-btn').classList.remove('active');
      return;
    }
    try {
      if (groupCameraStream) {
        groupCameraStream.getTracks().forEach(t => t.stop());
        groupCameraStream = null;
      }
      groupScreenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const track = groupScreenStream.getVideoTracks()[0];
      await applyGroupVideoTrack(track, 'screen');
      $('group-screen-btn').classList.add('active');
      if ($('group-camera-btn')) $('group-camera-btn').classList.remove('active');
      track.onended = async () => {
        await stopGroupVideoMode();
        if ($('group-screen-btn')) $('group-screen-btn').classList.remove('active');
      };
    } catch (e) {
      toast('Screen share was cancelled', 'info');
    }
  });

  function sendChannelMessage() {
    if (activeChannelType === 'voice') return;
    const input = $('channel-message-input');
    const content = input.value.trim();
    if (!content || !activeChannelId || !activeServerId || !socket) return;
    socket.emit('send_channel_message', {
      serverId: activeServerId,
      channelId: activeChannelId,
      content,
      replyToMessageId: pendingChannelReply ? pendingChannelReply.id : null
    });
    input.value = '';
    input.style.height = 'auto';
    setChannelReply(null);
    stopChannelTyping();
  }

  function setChannelReply(reply) {
    pendingChannelReply = reply;
    const box = $('channel-reply-preview');
    if (!box) return;
    if (!reply) {
      box.style.display = 'none';
      box.innerHTML = '';
      return;
    }
    box.style.display = 'flex';
    box.innerHTML = `<span>Replying to <strong>${esc(reply.displayName)}</strong>: ${esc(reply.content)}</span>
      <button type="button" onclick="cancelChannelReply()" title="Cancel reply">✕</button>`;
  }

  window.startChannelReply = function(msgId, encodedName, encodedContent) {
    const displayName = decodeURIComponent(encodedName || 'User');
    const content = decodeURIComponent(encodedContent || '').slice(0, 120);
    setChannelReply({ id: msgId, displayName, content });
    $('channel-message-input').focus();
  };

  window.cancelChannelReply = function() {
    setChannelReply(null);
  };

  window.openChannelSettingsQuick = async function() {
    if (!activeServerId || !activeChannelId || !isCurrentServerAdmin) return;
    const activeChannel = (activeServerData && activeServerData.channels || []).find(c => c.id === activeChannelId);
    if (!activeChannel) return;

    const topicInput = prompt('Channel topic (leave blank to clear):', activeChannel.topic || '');
    if (topicInput === null) return;
    const slowmodeInput = prompt('Slowmode seconds (0-120):', String(parseInt(activeChannel.slowmodeSeconds || 0, 10)));
    if (slowmodeInput === null) return;

    const slowmodeSeconds = Math.min(120, Math.max(0, parseInt(slowmodeInput, 10) || 0));
    const r = await api('PATCH', `/api/servers/${activeServerId}/channels/${activeChannelId}/settings`, {
      topic: topicInput,
      slowmodeSeconds
    });
    if (r.error) return toast(r.error, 'error');

    if (activeServerData && Array.isArray(activeServerData.channels)) {
      activeServerData.channels = activeServerData.channels.map(c => c.id === activeChannelId ? {
        ...c,
        topic: r.channel.topic,
        slowmodeSeconds: r.channel.slowmodeSeconds
      } : c);
      renderChannelList(activeServerData.channels, isCurrentServerAdmin);
      openChannel(r.channel);
    }
    toast('Channel settings updated', 'success');
  };

  window.openChannelPins = async function() {
    if (!activeServerId || !activeChannelId) return;
    const r = await api('GET', `/api/servers/${activeServerId}/channels/${activeChannelId}/pins`);
    if (r.error) return toast(r.error, 'error');
    const pins = r.pins || [];
    if (!pins.length) return toast('No pinned messages yet', 'info');

    const lines = pins.slice(0, 15).map((p, idx) => (
      `${idx + 1}. ${p.author.displayName}: ${String(p.content || '').slice(0, 64)}`
    )).join('\n');
    const choice = prompt(`Pinned messages (latest first):\n${lines}\n\nType a number to jump to it.`);
    if (!choice) return;

    const idx = parseInt(choice, 10) - 1;
    if (idx < 0 || idx >= pins.length) return toast('Invalid selection', 'error');
    const target = pins[idx];
    const existing = document.querySelector(`.message[data-id="${target.messageId}"]`);
    if (existing) {
      existing.scrollIntoView({ behavior: 'smooth', block: 'center' });
      existing.classList.add('mentioned-me');
      setTimeout(() => existing.classList.remove('mentioned-me'), 1400);
      return;
    }

    await loadChannelMessages(activeChannelId);
    const afterLoad = document.querySelector(`.message[data-id="${target.messageId}"]`);
    if (afterLoad) {
      afterLoad.scrollIntoView({ behavior: 'smooth', block: 'center' });
      afterLoad.classList.add('mentioned-me');
      setTimeout(() => afterLoad.classList.remove('mentioned-me'), 1400);
    } else {
      toast('Pinned message is older than the loaded range', 'info');
    }
  };

  window.toggleChannelPin = async function(msgId, channelId, isPinned) {
    if (!activeServerId || !channelId) return;
    const method = isPinned ? 'DELETE' : 'POST';
    const r = await api(method, `/api/servers/${activeServerId}/channels/${channelId}/messages/${msgId}/pin`);
    if (r.error) return toast(r.error, 'error');
    await loadChannelMessages(channelId);
    toast(isPinned ? 'Message unpinned' : 'Message pinned', 'success');
  };

  function handleChannelTyping() {
    if (!activeChannelId || !socket) return;
    if (!isChannelTyping) { isChannelTyping = true; socket.emit('channel_typing_start', { serverId: activeServerId, channelId: activeChannelId }); }
    clearTimeout(channelTypingTimer);
    channelTypingTimer = setTimeout(stopChannelTyping, 2000);
  }

  // ---- Mention Autocomplete ----
  let mentionQuery = null;
  let mentionStart = -1;
  let selectedMentionIdx = 0;
  let mentionItems = [];

  $('channel-message-input').addEventListener('input', function() {
    checkMentionTrigger(this);
  });

  $('channel-message-input').addEventListener('keydown', function(e) {
    const ac = $('channel-mention-autocomplete');
    if (ac.style.display !== 'none') {
      if (e.key === 'ArrowDown') { e.preventDefault(); selectedMentionIdx = Math.min(selectedMentionIdx+1, mentionItems.length-1); renderMentionList(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); selectedMentionIdx = Math.max(selectedMentionIdx-1, 0); renderMentionList(); }
      else if (e.key === 'Enter' || e.key === 'Tab') {
        if (mentionItems.length) { e.preventDefault(); insertMention(mentionItems[selectedMentionIdx]); }
      }
      else if (e.key === 'Escape') { closeMentionAC(); }
    }
  });

  function checkMentionTrigger(textarea) {
    const val = textarea.value;
    const pos = textarea.selectionStart;
    // Find the last @ before cursor
    const before = val.slice(0, pos);
    const atIdx = before.lastIndexOf('@');
    if (atIdx === -1) { closeMentionAC(); return; }
    // Only trigger if @ is at start or preceded by space
    const charBefore = before[atIdx-1];
    if (charBefore && charBefore !== ' ' && charBefore !== '\n') { closeMentionAC(); return; }
    const query = before.slice(atIdx+1);
    if (query.includes(' ')) { closeMentionAC(); return; }
    mentionStart = atIdx;
    mentionQuery = query.toLowerCase();
    buildMentionItems();
  }

  function buildMentionItems() {
    if (!activeServerData) return;
    const q = mentionQuery;
    const roles = (activeServerData.roles || []).filter(r => r.name.toLowerCase().startsWith(q));
    const members = (activeServerData.members || []).filter(m =>
      m.displayName.toLowerCase().includes(q) || m.username.toLowerCase().includes(q)
    ).slice(0, 8);

    mentionItems = [
      ...roles.map(r => ({ type: 'role', id: r.id, name: r.name, color: r.color })),
      ...members.map(m => ({ type: 'user', id: m.id, name: m.displayName, username: m.username, avatarDataUrl: m.avatarDataUrl }))
    ];

    if (!mentionItems.length) { closeMentionAC(); return; }
    selectedMentionIdx = 0;
    renderMentionList();
    $('channel-mention-autocomplete').style.display = 'block';
  }

  function renderMentionList() {
    const ac = $('channel-mention-autocomplete');
    ac.innerHTML = mentionItems.map((item, i) => {
      if (item.type === 'role') {
        return `<div class="mention-item ${i===selectedMentionIdx?'selected':''}" onclick="insertMention(mentionItems[${i}])">
          <div class="mention-item-icon mention-item-role-icon" style="background:${item.color}22;color:${item.color}">@</div>
          <div><div class="mention-item-name" style="color:${item.color}">${esc(item.name)}</div><div class="mention-item-sub">Role</div></div>
        </div>`;
      } else {
        return `<div class="mention-item ${i===selectedMentionIdx?'selected':''}" onclick="insertMention(mentionItems[${i}])">
          <div class="mention-item-icon" id="miac-${item.id}" style="background:var(--bg-hover)">
            ${item.avatarDataUrl ? `<img src="${item.avatarDataUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">` : esc((item.name||'?')[0].toUpperCase())}
          </div>
          <div><div class="mention-item-name">${esc(item.name)}</div><div class="mention-item-sub">@${esc(item.username||'')}</div></div>
        </div>`;
      }
    }).join('');
  }

  window.insertMention = function(item) {
    const ta = $('channel-message-input');
    const val = ta.value;
    const token = item.type === 'role'
      ? `<@role:${item.id}>`
      : `<@user:${item.id}>`;
    // Replace @query with token
    const before = val.slice(0, mentionStart);
    const after = val.slice(ta.selectionStart);
    ta.value = before + token + ' ' + after;
    // Move cursor after token
    const newPos = before.length + token.length + 1;
    ta.setSelectionRange(newPos, newPos);
    ta.focus();
    closeMentionAC();
  };

  function closeMentionAC() {
    $('channel-mention-autocomplete').style.display = 'none';
    mentionQuery = null;
    mentionStart = -1;
    mentionItems = [];
  }

  // Close autocomplete on outside click
  document.addEventListener('click', e => {
    if (!$('channel-mention-autocomplete').contains(e.target) && e.target !== $('channel-message-input')) {
      closeMentionAC();
    }
  });

  function stopChannelTyping() {
    if (isChannelTyping && activeChannelId && socket) { isChannelTyping = false; socket.emit('channel_typing_stop', { serverId: activeServerId, channelId: activeChannelId }); }
    clearTimeout(channelTypingTimer);
  }

  // ---- Add Channel ----
  function resetChannelCreateModal() {
    $('channel-create-name').value = '';
    $('channel-create-type').value = 'text';
    showError('channel-create-error', '');
    $('channel-create-submit').disabled = false;
  }

  function closeChannelCreateModal() {
    $('channel-create-modal').classList.remove('active');
    resetChannelCreateModal();
  }

  $('add-channel-btn').addEventListener('click', () => {
    if (!activeServerId) return;
    resetChannelCreateModal();
    $('channel-create-modal').classList.add('active');
    $('channel-create-name').focus();
  });

  $('channel-create-close').addEventListener('click', closeChannelCreateModal);
  $('channel-create-cancel').addEventListener('click', closeChannelCreateModal);
  $('channel-create-modal').addEventListener('click', e => {
    if (e.target === $('channel-create-modal')) closeChannelCreateModal();
  });

  $('channel-create-form').addEventListener('submit', async e => {
    e.preventDefault();
    if (!activeServerId) return;
    const name = $('channel-create-name').value.trim();
    const type = $('channel-create-type').value === 'voice' ? 'voice' : 'text';
    if (!name) {
      showError('channel-create-error', 'Channel name is required');
      return;
    }

    $('channel-create-submit').disabled = true;
    showError('channel-create-error', '');

    const r = await api('POST', `/api/servers/${activeServerId}/channels`, { name, type });
    if (r.error) {
      $('channel-create-submit').disabled = false;
      showError('channel-create-error', r.error);
      return;
    }

    const s = await api('GET', `/api/servers/${activeServerId}`);
    activeServerData = s;
    renderChannelList(s.channels, true);
    openChannel(r.channel);
    closeChannelCreateModal();
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
      const res = await requestText('POST', '/api/servers', fd);
      const text = res.text;
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
    $('settings-boost-status').textContent = `${s.boostCount || 0} active boosts. Tags and gradients unlock at 2.`;
    $('settings-server-tag').value = s.tag || '';
    $('settings-tag-group').style.display = (s.boostCount || 0) >= 2 ? 'block' : 'none';
    if (s.iconDataUrl) {
      $('settings-icon-preview').innerHTML = `<img src="${s.iconDataUrl}" alt="">`;
    } else {
      $('settings-icon-preview').textContent = s.name[0].toUpperCase();
    }
    switchSettingsTab('overview');
    await loadNexusGuardSettings();
    renderRolesList(activeServerData.roles || []);
    renderBoostSettings(s);
    loadBansList();
    $('server-settings-modal').classList.add('active');
  });

  function renderBoostSettings(server) {
    const features = new Set(server.boostFeatures || []);
    $('boosts-settings-content').innerHTML = `<div class="shop-card"><div class="shop-card-name">${server.boostCount || 0} active boosts</div><div class="shop-card-desc">Allocate two boosts per server feature. Expired boosts automatically disable the feature they funded.</div></div><div class="shop-grid" style="margin-top:12px"><div class="shop-card"><div class="shop-card-name">Server Tag</div><div class="shop-card-desc">A clickable tag card shown beside members across DMs and servers.</div><button class="shop-card-btn ${features.has('tag') ? 'equip' : 'buy'}" onclick="spendBoosts('tag')">${features.has('tag') ? 'Allocated' : 'Spend 2 Boosts'}</button></div><div class="shop-card"><div class="shop-card-name">Role Gradients</div><div class="shop-card-desc">Unlock animated gradient colors in the role editor.</div><button class="shop-card-btn ${features.has('gradients') ? 'equip' : 'buy'}" onclick="spendBoosts('gradients')">${features.has('gradients') ? 'Allocated' : 'Spend 2 Boosts'}</button></div></div>`;
  }
  window.spendBoosts = async function(feature) { const r = await api('POST', '/api/perks/servers/' + activeServerId + '/spend', { feature }); if (r.error) return toast(r.error, 'error'); toast('Boosts allocated', 'success'); await loadServerSidebar(activeServerId); $('server-settings-btn').click(); };

  $('server-boost-btn').addEventListener('click', async () => {
    if (!activeServerId || !activeServerData) return;
    if (!confirm(`Boost ${activeServerData.server.name} for 10,000 Nexals for 30 days?`)) return;
    const r = await api('POST', '/api/perks/servers/' + activeServerId + '/boost');
    if (r.error) return toast(r.error, 'error');
    updateNexalDisplay(r.nexals);
    toast('Server boosted for 30 days', 'success');
    await loadServerSidebar(activeServerId);
  });

  $('save-server-tag-btn').addEventListener('click', async () => {
    if (!activeServerId) return;
    const r = await api('PATCH', '/api/perks/servers/' + activeServerId + '/tag', { tag: $('settings-server-tag').value });
    if (r.error) return toast(r.error, 'error');
    toast('Server tag saved', 'success');
    await loadServerSidebar(activeServerId);
  });

  // Settings tab switching
  window.switchSettingsTab = function(tab) {
    document.querySelectorAll('.settings-tab').forEach(b => b.classList.toggle('active', b.dataset.stab === tab));
    document.querySelectorAll('.settings-tab-panel').forEach(p => {
      p.style.display = p.id === 'settings-tab-' + tab ? 'block' : 'none';
      p.classList.toggle('active', p.id === 'settings-tab-' + tab);
    });
  };

  async function loadNexusGuardSettings() {
    if (!activeServerId) return;
    const r = await api('GET', `/api/servers/${activeServerId}/bot-config`);
    if (r.error || !r.config) {
      showError('ng-settings-error', r.error || 'Failed to load NexusGuard settings');
      return;
    }
    const cfg = r.config;
    const botAvatar = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5NiA5NiI+PGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSJnIiB4MT0iMCIgeTE9IjAiIHgyPSIxIiB5Mj0iMSI+PHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjMGYxNzJhIi8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjMWUyOTNiIi8+PC9saW5lYXJHcmFkaWVudD48bGluZWFyR3JhZGllbnQgaWQ9ImEiIHgxPSIwIiB5MT0iMCIgeDI9IjEiIHkyPSIxIj48c3RvcCBvZmZzZXQ9IjAiIHN0b3AtY29sb3I9IiNmNTllMGIiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiNmOTczMTYiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz48Y2lyY2xlIGN4PSI0OCIgY3k9IjQ4IiByPSI0NiIgZmlsbD0idXJsKCNnKSIvPjxwYXRoIGQ9Ik00OCAxNmwyNCA4djIyYzAgMTgtMTAgMzAtMjQgMzYtMTQtNi0yNC0xOC0yNC0zNlYyNHoiIGZpbGw9InVybCgjYSkiLz48cGF0aCBkPSJNNDggMjZsMTQgNXYxNWMwIDExLTYgMTktMTQgMjMtOC00LTE0LTEyLTE0LTIzVjMxeiIgZmlsbD0iIzExMTgyNyIgb3BhY2l0eT0iLjY1Ii8+PGNpcmNsZSBjeD0iNDgiIGN5PSI0NSIgcj0iNyIgZmlsbD0iI2ZkZTY4YSIvPjxwYXRoIGQ9Ik0zNiA1OWgyNHY1SDM2eiIgZmlsbD0iI2ZkZTY4YSIvPjwvc3ZnPg==';
    const avatarEl = $('ng-avatar-preview');
    if (avatarEl) avatarEl.innerHTML = `<img src="${botAvatar}" alt="NexusGuard" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    $('ng-prefix-input').value = cfg.prefix || '/';
    $('ng-enabled-toggle').checked = cfg.enabled !== false;
    $('ng-automod-toggle').checked = cfg.automod !== false;
    $('ng-block-links-toggle').checked = !!cfg.blockLinks;
    $('ng-caps-threshold').value = cfg.capsThreshold || 90;
    $('ng-spam-window').value = cfg.spamWindow || 6;
    $('ng-blocked-words').value = (cfg.blockedWords || []).join('\n');
    showError('ng-settings-error', '');
  }

  $('save-ng-settings-btn').addEventListener('click', async () => {
    if (!activeServerId) return;
    const prefix = (($('ng-prefix-input').value || '/').trim().slice(0, 2) || '/');
    const capsThreshold = parseInt($('ng-caps-threshold').value, 10);
    const spamWindow = parseInt($('ng-spam-window').value, 10);
    const blockedWords = ($('ng-blocked-words').value || '')
      .split('\n')
      .map(w => w.trim().toLowerCase())
      .filter(Boolean);
    if (!capsThreshold || capsThreshold < 50 || capsThreshold > 100) {
      return showError('ng-settings-error', 'Caps threshold must be between 50 and 100');
    }
    if (!spamWindow || spamWindow < 3 || spamWindow > 20) {
      return showError('ng-settings-error', 'Spam threshold must be between 3 and 20');
    }

    const r = await api('PATCH', `/api/servers/${activeServerId}/bot-config`, {
      prefix,
      enabled: $('ng-enabled-toggle').checked,
      automod: $('ng-automod-toggle').checked,
      blockLinks: $('ng-block-links-toggle').checked,
      capsThreshold,
      spamWindow,
      blockedWords
    });

    if (r.error) return showError('ng-settings-error', r.error);
    showError('ng-settings-error', '');
    toast('NexusGuard settings saved!', 'success');
  });

  function renderRolesList(roles) {
    $('roles-list').innerHTML = roles.length
      ? roles.map(r => `
          <div class="role-row" id="role-row-${r.id}">
            <div class="role-dot" style="background:${r.color}"></div>
            <span class="role-name${r.gradientStart ? ' role-gradient-text' : ''}" style="${r.gradientStart ? `--role-gradient-start:${r.gradientStart};--role-gradient-end:${r.gradientEnd}` : `color:${r.color}`}">${esc(r.name)}</span>
            <span class="role-badge">${r.isAdmin ? 'Admin' : 'Member'}</span>
            ${r.canDeleteMessages ? '<span class="role-badge" style="background:rgba(240,84,84,0.15);color:var(--red)">Can Delete</span>' : ''}
            <div class="role-actions">
              <button class="role-edit-btn" onclick="editRole('${r.id}')">Edit</button>
              <button class="role-del-btn" onclick="deleteRole('${r.id}','${esc(r.name)}')">Delete</button>
            </div>
            <label class="toggle-row" style="grid-column:1/-1;margin:4px 0 0"><input type="checkbox" ${r.gradientStart ? 'checked' : ''} onchange="toggleRoleGradient('${r.id}',this.checked)"><span class="toggle-label"><span class="toggle-title">Animated gradient</span></span></label>
          </div>`).join('')
      : '<p style="font-size:13px;color:var(--text-muted);padding:8px 0">No custom roles yet. Create one below.</p>';
  }

  window.editRole = function(roleId) { const role = activeServerData.roles.find(r => r.id === roleId); if (!role) return; $('role-editor').style.display='block'; $('edit-role-id').value=role.id; $('edit-role-name').value=role.name; $('edit-role-color').value=role.color; $('edit-role-admin').value=String(!!role.isAdmin); $('edit-role-gradient').checked=!!role.gradientStart; $('edit-role-gradient-colors').style.display=role.gradientStart?'flex':'none'; $('edit-role-gradient-start').value=role.gradientStart||'#62e6ff'; $('edit-role-gradient-end').value=role.gradientEnd||'#b06cff'; };
  $('edit-role-gradient').addEventListener('change', function(){ $('edit-role-gradient-colors').style.display=this.checked?'flex':'none'; });
  $('cancel-role-editor-btn').addEventListener('click', ()=> $('role-editor').style.display='none');
  $('save-role-editor-btn').addEventListener('click', async ()=> { const payload={name:$('edit-role-name').value.trim(),color:$('edit-role-color').value,isAdmin:$('edit-role-admin').value==='true',gradientAnimated:$('edit-role-gradient').checked}; if(payload.gradientAnimated){payload.gradientStart=$('edit-role-gradient-start').value;payload.gradientEnd=$('edit-role-gradient-end').value;} const r=await api('PATCH',`/api/servers/${activeServerId}/roles/${$('edit-role-id').value}`,payload); if(r.error)return toast(r.error,'error'); const s=await api('GET',`/api/servers/${activeServerId}`); activeServerData=s; renderRolesList(s.roles||[]); renderMemberList(s.members); $('role-editor').style.display='none'; toast('Role updated','success'); });
  window.toggleRoleGradient = function(roleId, enabled) { editRole(roleId); $('edit-role-gradient').checked=enabled; $('edit-role-gradient-colors').style.display=enabled?'flex':'none'; };

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
    const canDeleteMessages = $('new-role-can-delete') && $('new-role-can-delete').checked;
    if (!name) return toast('Enter a role name', 'error');
    const r = await api('POST', `/api/servers/${activeServerId}/roles`, { name, color, isAdmin, canDeleteMessages });
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
      const res = await requestText('PATCH', `/api/servers/${activeServerId}`, fd);
      const text = res.text;
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
    if (view === 'shop') loadShop();
    if (view === 'achievements') loadAchievements();
    if (view === 'stats') loadCollectionStats();
    if (view === 'pro') loadPro();
  }

  // Rail selection: 'dms' or a server id
  window.railSelect = function(id) {
    document.querySelectorAll('.rail-btn').forEach(b => b.classList.remove('active'));
    if (id === 'dms') {
      $('rail-dms') && $('rail-dms').classList.add('active');
      $('sidebar-dms').style.display = 'flex';
      $('sidebar-server').style.display = 'none';
      activeServerId = null;
      activeChannelId = null;
      switchView('friends');
      setMobileTitle('Nexus');
    } else {
      const btn = document.querySelector(`.rail-btn[data-server-id="${id}"]`);
      if (btn) btn.classList.add('active');
      $('sidebar-dms').style.display = 'none';
      $('sidebar-server').style.display = 'flex';
      loadServerSidebar(id);
      switchView('channel');
    }
    if (isMobile()) closeMobileSidebar();
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

    setMobileTitle(user.displayName);
    if (isMobile()) closeMobileSidebar();
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

  function renderReactionChips(msgId, channelId, reactions) {
    const safe = Array.isArray(reactions) ? reactions : [];
    const chips = safe.map(r => {
      const emoji = String(r.emoji || '');
      const count = Math.max(1, parseInt(r.count, 10) || 1);
      const reacted = !!r.reacted;
      return `<button class="msg-reaction-chip${reacted ? ' reacted' : ''}" onclick="toggleChannelReaction('${msgId}','${channelId}','${encodeURIComponent(emoji)}')">${esc(emoji)} ${count}</button>`;
    }).join('');
    return `${chips}<button class="msg-reaction-add" onclick="promptChannelReaction('${msgId}','${channelId}')">+</button>`;
  }

  window.promptChannelReaction = function(msgId, channelId) {
    const emoji = prompt('React with emoji (examples: 👍 🔥 😂)');
    if (!emoji || !emoji.trim()) return;
    window.toggleChannelReaction(msgId, channelId, encodeURIComponent(emoji.trim().slice(0, 16)));
  };

  window.toggleChannelReaction = function(msgId, channelId, encodedEmoji) {
    if (!socket || !activeServerId) return;
    const emoji = decodeURIComponent(encodedEmoji || '');
    if (!emoji) return;
    socket.emit('toggle_channel_reaction', {
      serverId: activeServerId,
      channelId,
      messageId: msgId,
      emoji
    });
  };

  function buildMessageEl(msg, prevEl) {
    const el = document.createElement('div');
    const prevTs = prevEl ? parseInt(prevEl.dataset.ts) : 0;
    const prevFrom = prevEl ? prevEl.dataset.from : '';
    const grouped = prevFrom === msg.fromId && (msg.createdAt - prevTs) < 300;
    const isMentioned = msg.content && currentUser && (
      msg.content.includes('<@user:' + currentUser.id + '>') ||
      (msg.mentions && activeServerData && msg.content.match(/<@role:[a-f0-9-]+>/) &&
       activeServerData.members && (() => {
         const me = activeServerData.members.find(m => m.id === currentUser.id);
         return me && msg.content.includes('<@role:' + (me.roleId || '') + '>');
       })())
    );
    el.className = `message${grouped ? ' grouped' : ''}${isMentioned ? ' mentioned-me' : ''}`;
    el.dataset.ts = msg.createdAt;
    el.dataset.from = msg.fromId;
    el.dataset.id = msg.id;

    const isMe = msg.fromId === currentUser.id;
    const author = isMe
      ? { id: currentUser.id, displayName: currentUser.displayName, username: currentUser.username, avatarDataUrl: currentUser.avatarDataUrl, activeColor: currentUser.activeColor || null, activeFont: currentUser.activeFont || null }
      : msg.author;

    const roleColor = author.roleColor || null;
    const roleStyle = roleColor ? `style="color:${roleColor}"` : '';
    const roleClass = roleColor ? 'msg-author has-role' : 'msg-author';
    const roleTip = author.roleName ? `title="${esc(author.roleName)}"` : '';

    // Check if current user can delete this message
    const isOwnMsg = msg.fromId === currentUser.id;
    const meInServer = activeServerData && activeServerData.members && activeServerData.members.find(m => m.id === currentUser.id);
    const myRole = meInServer && activeServerData.roles && activeServerData.roles.find(r => r.id === meInServer.roleId);
    const canDeleteThisMsg = isOwnMsg || (meInServer && (meInServer.role === 'admin' || meInServer.isAdmin)) || (myRole && myRole.canDeleteMessages);
    const isChannelMsg = !!msg.channelId;
    const canManagePins = isChannelMsg && meInServer && (meInServer.role === 'admin' || meInServer.isAdmin);

    const replyPreviewHtml = msg.replyTo
      ? `<div class="msg-reply-preview"><strong>${esc(msg.replyTo.displayName || 'User')}</strong>: ${esc(String(msg.replyTo.content || '').slice(0, 120))}</div>`
      : '';
    const pinBadge = msg.isPinned ? '<span class="msg-pinned-badge">PINNED</span>' : '';
    const replyAction = isChannelMsg
      ? `<button class="msg-action-btn" onclick="startChannelReply('${msg.id}','${encodeURIComponent(author.displayName || author.username || 'User')}','${encodeURIComponent(String(msg.content || '').slice(0, 160))}')" title="Reply">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><polyline points="9 17 4 12 9 7"/><line x1="4" y1="12" x2="20" y2="12"/></svg>
        </button>`
      : '';
    const pinAction = canManagePins
      ? `<button class="msg-action-btn" onclick="toggleChannelPin('${msg.id}','${msg.channelId}',${msg.isPinned ? 'true' : 'false'})" title="${msg.isPinned ? 'Unpin message' : 'Pin message'}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M16 3l5 5-4 4-2-2-5 5v4h-2v-4l5-5-2-2z"/></svg>
        </button>`
      : '';
    const reactionBar = isChannelMsg
      ? `<div class="msg-reactions" id="reactions-${msg.id}">${renderReactionChips(msg.id, msg.channelId, msg.reactions || [])}</div>`
      : '';

    el.innerHTML = `
      <div class="avatar-wrap" style="flex-shrink:0;align-self:flex-start;margin-top:2px"><div class="avatar" id="mav-${msg.id}"></div></div>
      <div class="msg-body">
        <div class="msg-header">
          <span class="${roleClass}" ${roleStyle} ${roleTip}>${esc(author.displayName)}</span>
          <span class="msg-time">${formatTime(msg.createdAt)}</span>
          ${pinBadge}
        </div>
        ${replyPreviewHtml}
        <div class="msg-content${author.activeFont ? ' msg-font-' + author.activeFont : ''}">${renderContent(msg.content, msg.mentions, author.activeColor || null)}</div>
        ${reactionBar}
        ${replyAction}
        ${pinAction}
        ${(isChannelMsg && canDeleteThisMsg) ? `<button class="msg-delete-btn" onclick="deleteChannelMessage('${msg.id}','${msg.channelId}',this)" title="Delete message">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>` : ''}
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
  let socketIoLoadPromise = null;

  function ensureSocketIoClient() {
    if (typeof window.io === 'function') return Promise.resolve(true);
    if (socketIoLoadPromise) return socketIoLoadPromise;

    socketIoLoadPromise = new Promise(resolve => {
      // Reuse existing script tag if present.
      const socketScriptUrl = apiUrl('/socket.io/socket.io.js');
      const existing = document.querySelector(`script[src="${socketScriptUrl}"]`);
      if (existing) {
        existing.addEventListener('load', () => resolve(typeof window.io === 'function'), { once: true });
        existing.addEventListener('error', () => resolve(false), { once: true });
        // In case script is already loaded but global wasn't checked yet.
        setTimeout(() => resolve(typeof window.io === 'function'), 0);
        return;
      }

      const s = document.createElement('script');
      s.src = socketScriptUrl;
      s.async = true;
      s.onload = () => resolve(typeof window.io === 'function');
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    }).finally(() => {
      // Allow retries if loading failed.
      if (typeof window.io !== 'function') socketIoLoadPromise = null;
    });

    return socketIoLoadPromise;
  }

  async function connectSocket() {
    if (socket) return;

    if (typeof window.io !== 'function') {
      const loaded = await ensureSocketIoClient();
      if (!loaded || typeof window.io !== 'function') {
        console.warn('Socket.IO client unavailable; continuing without realtime for now.');
        toast('Realtime unavailable right now. Refresh in a few seconds.', 'info', 3500);
        return;
      }
    }

    socket = io(LOCAL_API_ORIGIN || undefined, { transports: ['websocket', 'polling'], withCredentials: true });

    socket.on('connect', () => console.log('Socket connected'));
    socket.on('disconnect', () => console.log('Socket disconnected'));
    socket.on('connect_error', err => {
      console.warn('Socket connect error:', err && err.message ? err.message : err);
    });

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
    socket.on('incoming_call', ({ roomId, fromId, caller, callType }) => {
      if (callState) {
        socket.emit('call_decline', { roomId, toId: fromId });
        return;
      }
      const normalizedType = callType === 'video' ? 'video' : 'voice';
      pendingCallData = { roomId, fromId, caller, callType: normalizedType };
      $('incoming-caller-name').textContent = caller.displayName;
      const callLabel = document.querySelector('#incoming-call-modal .call-label');
      if (callLabel) callLabel.textContent = normalizedType === 'video' ? 'Incoming Video Call' : 'Incoming Voice Call';
      renderAvatar($('incoming-caller-avatar'), { id: fromId, ...caller });
      $('incoming-call-modal').classList.add('active');
      playRingtone(true); // incoming — pulsing tone
    });

    socket.on('call_ringing', ({ roomId, toId, callType }) => {
      outgoingCallRoomId = roomId || null;
      outgoingCallType = callType === 'video' ? 'video' : 'voice';
      playRingtone(false); // outgoing — gentle beep
    });

    socket.on('call_accepted', async ({ roomId, byId, callType }) => {
      stopRingtone();
      outgoingCallTo = null;
      outgoingCallRoomId = null;
      const friend = friends.find(f => f.id === byId);
      if (!friend) return;
      await startWebRTCCall(roomId, byId, friend, true, callType || outgoingCallType || 'voice');
    });

    socket.on('call_declined', () => {
      stopRingtone();
      outgoingCallTo = null;
      outgoingCallRoomId = null;
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

    socket.on('channel_message_deleted', ({ channelId, messageId }) => {
      if (channelId === activeChannelId) removeMessageFromDOM(messageId);
    });

    socket.on('channel_message_reaction_updated', ({ channelId, messageId, reactions }) => {
      if (channelId !== activeChannelId) return;
      const el = $(`reactions-${messageId}`);
      if (!el) return;
      el.innerHTML = renderReactionChips(messageId, channelId, reactions || []);
    });

    socket.on('group_call_joined', async ({ roomId, serverId, channelId, participants }) => {
      if (!groupCallState) return;
      groupCallState.roomId = roomId;
      groupCallState.serverId = serverId;
      groupCallState.channelId = channelId;
      groupCallState.users.clear();
      (participants || []).forEach(p => groupCallState.users.set(p.id, p));

      if ($('group-video-grid')) $('group-video-grid').innerHTML = '';
      if ($('group-local-video')) $('group-local-video').srcObject = null;

      const others = (participants || []).filter(p => p.id !== currentUser.id);
      for (const p of others) {
        await ensureGroupPeerConnection(p.id, true);
      }
      const count = others.length + 1;
      if ($('group-call-btn')) $('group-call-btn').title = `Leave Group Voice Chat (${count} in call)`;
      toast(`Joined group voice (${count} in call)`, 'success');
    });

    socket.on('group_call_user_joined', ({ roomId, user }) => {
      if (!groupCallState || groupCallState.roomId !== roomId) return;
      groupCallState.users.set(user.id, user);
      const peerCount = groupCallState.peers.size + 2;
      if ($('group-call-btn')) $('group-call-btn').title = `Leave Group Voice Chat (${peerCount} in call)`;
      toast(`${user.displayName} joined group voice`, 'info');
    });

    socket.on('group_call_user_left', ({ roomId, userId }) => {
      if (!groupCallState || groupCallState.roomId !== roomId) return;
      const pc = groupCallState.peers.get(userId);
      if (pc) {
        try { pc.close(); } catch (_) {}
        groupCallState.peers.delete(userId);
      }
      const audio = groupCallState.audios.get(userId);
      if (audio) {
        audio.remove();
        groupCallState.audios.delete(userId);
      }
      const tile = $(`group-remote-video-${userId}`);
      if (tile && tile.parentElement) tile.parentElement.remove();
      groupCallState.users.delete(userId);
      const count = groupCallState.peers.size + 1;
      if ($('group-call-btn')) $('group-call-btn').title = `Leave Group Voice Chat (${count} in call)`;
    });

    socket.on('group_webrtc_offer', async ({ roomId, fromId, offer }) => {
      if (!groupCallState || groupCallState.roomId !== roomId) return;
      const pc = await ensureGroupPeerConnection(fromId, false);
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('group_webrtc_answer', { roomId, toId: fromId, answer });
      } catch (e) {
        console.error('group offer handling error:', e);
      }
    });

    socket.on('group_webrtc_answer', async ({ roomId, fromId, answer }) => {
      if (!groupCallState || groupCallState.roomId !== roomId) return;
      const pc = groupCallState.peers.get(fromId);
      if (!pc) return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
      } catch (e) {
        console.error('group answer handling error:', e);
      }
    });

    socket.on('group_webrtc_ice', async ({ roomId, fromId, candidate }) => {
      if (!groupCallState || groupCallState.roomId !== roomId) return;
      const pc = groupCallState.peers.get(fromId);
      if (!pc) return;
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (_) {}
    });

    socket.on('channel_error', ({ channelId, error }) => {
      if (channelId === activeChannelId) toast(error, 'error');
    });

    socket.on('screenshare_started', ({ fromId }) => {
      expectingRemoteScreenTrack = true;
      // The ontrack handler deals with showing the video; this is just for notification
      const peer = callState && callState.peerUser;
      toast((peer ? peer.displayName : 'Peer') + ' started screen sharing', 'info');
    });

    socket.on('account_suspended', ({ suspendedUntil, reason }) => {
      // Immediately show suspension screen and log out
      api('POST', '/api/auth/logout').then(() => {
        stopSecretHum();
        currentUser = null;
        leaveGroupCall(false);
        if (socket) { socket.disconnect(); socket = null; }
        showSuspensionScreen(null, suspendedUntil, reason || null);
      });
    });

    socket.on('nexus_admin_control', ({ action, message, view, by }) => {
      const actorName = (by && (by.displayName || by.username)) || 'Admin';
      if (action === 'lock') {
        const lockMessage = message || 'This Nexus client is temporarily locked by an administrator.';
        pauseNexusClient(lockMessage);
        toast(`Nexus client locked by ${actorName}`, 'error', 5000);
        return;
      }
      if (action === 'unlock') {
        unpauseNexusClient();
        toast(`Nexus client unlocked by ${actorName}`, 'success', 4000);
        return;
      }
      if (action === 'notify') {
        toast((message || 'Admin notice'), 'info', 7000);
        return;
      }
      if (action === 'popup') {
        showQuickPopup(message || 'Admin popup');
        return;
      }
      if (action === 'force_view') {
        if (view) switchView(view);
        if (message) toast(message, 'info', 6000);
      }
    });

    socket.on('mentioned', ({ type, serverId: sid, channelId: cid, fromUser, preview }) => {
      const serverName = servers.find(s => s.id === sid)?.name || 'a server';
      toast(`@mention from ${fromUser.displayName} in ${serverName}: ${preview}`, 'info', 6000);
    });

    socket.on('screenshare_stopped', () => {
      expectingRemoteScreenTrack = false;
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
    outgoingCallType = 'voice';
    socket.emit('call_invite', { toId: activeDmUserId, callType: 'voice' });
    const friend = friends.find(f => f.id === activeDmUserId);
    if (friend) showCallHud(friend, false);
  });

  if ($('start-video-call-btn')) {
    $('start-video-call-btn').addEventListener('click', () => {
      if (!activeDmUserId) return;
      if (callState || outgoingCallTo) return toast('Already in a call', 'error');
      outgoingCallTo = activeDmUserId;
      outgoingCallType = 'video';
      socket.emit('call_invite', { toId: activeDmUserId, callType: 'video' });
      const friend = friends.find(f => f.id === activeDmUserId);
      if (friend) showCallHud(friend, false);
    });
  }

  $('accept-call-btn').addEventListener('click', async () => {
    if (!pendingCallData) return;
    stopRingtone();
    const { roomId, fromId, caller, callType } = pendingCallData;
    $('incoming-call-modal').classList.remove('active');
    socket.emit('call_accept', { roomId, toId: fromId });
    const friend = friends.find(f => f.id === fromId) || { id: fromId, ...caller };
    await startWebRTCCall(roomId, fromId, friend, false, callType || 'voice');
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
      socket.emit('call_cancel', { toId: outgoingCallTo, roomId: outgoingCallRoomId });
      outgoingCallTo = null;
      outgoingCallRoomId = null;
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

  if ($('video-toggle-btn')) {
    $('video-toggle-btn').addEventListener('click', async () => {
      if (!callState || !callState.localStream) return;
      const pc = callState.peerConnection;
      const currentVideo = callState.localStream.getVideoTracks()[0] || null;

      if (currentVideo) {
        currentVideo.stop();
        callState.localStream.removeTrack(currentVideo);
        const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) {
          await sender.replaceTrack(null);
          try { pc.removeTrack(sender); } catch (_) {}
        }
        $('video-toggle-btn').classList.add('video-off');
        $('call-local-video').srcObject = null;
        if (!$('call-remote-video').srcObject) $('call-video-stage').style.display = 'none';
      } else {
        try {
          const cam = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          const camTrack = cam.getVideoTracks()[0];
          callState.localStream.addTrack(camTrack);
          const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
          if (sender) await sender.replaceTrack(camTrack);
          else pc.addTrack(camTrack, callState.localStream);

          $('video-toggle-btn').classList.remove('video-off');
          $('call-local-video').srcObject = new MediaStream([camTrack]);
          $('call-video-stage').style.display = 'block';

          camTrack.onended = () => {
            $('video-toggle-btn').classList.add('video-off');
            $('call-local-video').srcObject = null;
          };

          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('webrtc_offer', { roomId: callState.roomId, toId: callState.peerId, offer });
        } catch (e) {
          toast('Camera access was denied', 'error');
        }
      }
    });
  }

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
  function getRingtonePreset(ringtoneId) {
    if (!ringtoneId) return null;
    return RINGTONE_PRESETS[ringtoneId] || null;
  }

  function playRingtone(isIncoming, opts = {}) {
    stopRingtone();
    try {
      ringtoneCtx = new (window.AudioContext || window.webkitAudioContext)();
      // Custom ringtone is only for the receiver side (incoming calls).
      const activeRingtoneId = isIncoming ? (currentUser && currentUser.activeRingtone) : null;
      const chosen = getRingtonePreset(opts.ringtoneId || activeRingtoneId);
      const preset = chosen || (isIncoming ? DEFAULT_INCOMING_RINGTONE : DEFAULT_OUTGOING_RINGTONE);
      const schedule = preset.pattern || [];
      const waveType = preset.wave || 'sine';
      const gainPeak = Math.max(0.05, Math.min(0.3, (preset.gain || 0.18) * (opts.gainBoost || 1)));
      const interval = preset.intervalMs || (isIncoming ? 1000 : 1200);
      const oneShot = !!opts.oneShot;

      function playPattern() {
        if (!ringtoneCtx) return;
        schedule.forEach(({ f, t, d }) => {
          if (!f) return;
          const osc = ringtoneCtx.createOscillator();
          const gain = ringtoneCtx.createGain();
          osc.connect(gain);
          gain.connect(ringtoneCtx.destination);
          osc.type = waveType;
          osc.frequency.setValueAtTime(f, ringtoneCtx.currentTime + t);
          gain.gain.setValueAtTime(0, ringtoneCtx.currentTime + t);
          gain.gain.linearRampToValueAtTime(gainPeak, ringtoneCtx.currentTime + t + 0.01);
          gain.gain.linearRampToValueAtTime(0, ringtoneCtx.currentTime + t + d);
          osc.start(ringtoneCtx.currentTime + t);
          osc.stop(ringtoneCtx.currentTime + t + d + 0.05);
          ringtoneNodes.push(osc);
        });
        if (!oneShot) ringtoneNodes.push(setTimeout(playPattern, interval));
      }
      playPattern();
      if (oneShot) {
        const maxStep = schedule.reduce((max, s) => Math.max(max, (s.t || 0) + (s.d || 0)), 0);
        ringtoneNodes.push(setTimeout(stopRingtone, Math.ceil((maxStep + 0.2) * 1000)));
      }
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

  async function startWebRTCCall(roomId, peerId, peerUser, isCaller, callType = 'voice') {
    try {
      const wantsVideo = callType === 'video';
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: wantsVideo });
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
          const peerName = callState && callState.peerUser ? callState.peerUser.displayName : 'Peer';
          if (expectingRemoteScreenTrack) {
            remoteScreenActive = true;
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
              expectingRemoteScreenTrack = false;
              $('screenshare-overlay').style.display = 'none';
              vid.srcObject = null;
              $('view-screen-btn').style.display = 'none';
              $('view-screen-btn').classList.remove('viewing');
            };
          } else {
            $('call-remote-video').srcObject = e.streams[0];
            $('call-video-stage').style.display = 'block';
            track.onended = () => {
              $('call-remote-video').srcObject = null;
              if (!$('call-local-video').srcObject) $('call-video-stage').style.display = 'none';
            };
          }
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

      callState = { roomId, peerId, peerUser, peerConnection: pc, localStream: stream, callType };

      const localVideoTrack = stream.getVideoTracks()[0] || null;
      if (localVideoTrack) {
        $('video-toggle-btn').classList.remove('video-off');
        $('call-local-video').srcObject = new MediaStream([localVideoTrack]);
        $('call-video-stage').style.display = 'block';
      } else {
        $('video-toggle-btn').classList.add('video-off');
        $('call-local-video').srcObject = null;
      }

      socket.emit('join_call', { roomId });

      if (isCaller) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('webrtc_offer', { roomId, toId: peerId, offer });
      }

      showCallHud(peerUser, true);
    } catch (e) {
      console.error('WebRTC error:', e);
      toast('Could not access microphone/camera', 'error');
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
    $('call-video-stage').style.display = 'none';
    $('call-local-video').srcObject = null;
    $('call-remote-video').srcObject = null;
    $('screenshare-overlay').style.display = 'none';
    $('screenshare-video').srcObject = null;
    isScreenSharing = false;
    expectingRemoteScreenTrack = false;
    remoteScreenActive = false;
    $('screenshare-btn').classList.remove('sharing');
    $('video-toggle-btn').classList.remove('video-off');
    $('view-screen-btn').style.display = 'none';
    $('view-screen-btn').classList.remove('viewing');
  }

  async function ensureGroupPeerConnection(peerId, initiateOffer) {
    if (!groupCallState) return null;
    if (groupCallState.peers.has(peerId)) return groupCallState.peers.get(peerId);

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });

    groupCallState.localStream.getTracks().forEach(t => pc.addTrack(t, groupCallState.localStream));

    pc.onicecandidate = e => {
      if (e.candidate && groupCallState && groupCallState.roomId) {
        socket.emit('group_webrtc_ice', {
          roomId: groupCallState.roomId,
          toId: peerId,
          candidate: e.candidate
        });
      }
    };

    pc.ontrack = e => {
      const stream = e.streams[0];
      if (!stream) return;
      if (e.track && e.track.kind === 'audio') {
        let audio = groupCallState.audios.get(peerId);
        if (!audio) {
          audio = document.createElement('audio');
          audio.autoplay = true;
          audio.dataset.peerId = peerId;
          document.body.appendChild(audio);
          groupCallState.audios.set(peerId, audio);
        }
        audio.srcObject = stream;
      } else if (e.track && e.track.kind === 'video') {
        ensureGroupRemoteVideoTile(peerId, stream);
      }
    };

    groupCallState.peers.set(peerId, pc);

    if (initiateOffer && groupCallState.roomId) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('group_webrtc_offer', {
        roomId: groupCallState.roomId,
        toId: peerId,
        offer
      });
    }

    return pc;
  }

  function ensureGroupRemoteVideoTile(peerId, stream) {
    const grid = $('group-video-grid');
    if (!grid) return;
    if ($('group-call-stage')) $('group-call-stage').style.display = 'block';
    let wrap = $(`group-remote-wrap-${peerId}`);
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = `group-remote-wrap-${peerId}`;
      const user = groupCallState && groupCallState.users ? groupCallState.users.get(peerId) : null;
      const label = user ? user.displayName : 'User';
      wrap.innerHTML = `<video class="group-remote-video" id="group-remote-video-${peerId}" autoplay playsinline></video>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${esc(label)}</div>`;
      grid.appendChild(wrap);
    }
    const vid = $(`group-remote-video-${peerId}`);
    if (vid) vid.srcObject = stream;
  }

  async function renegotiateAllGroupPeers() {
    if (!groupCallState || !groupCallState.roomId) return;
    for (const [peerId, pc] of groupCallState.peers.entries()) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('group_webrtc_offer', { roomId: groupCallState.roomId, toId: peerId, offer });
      } catch (e) {
        console.warn('Group renegotiate failed for peer', peerId, e && e.message ? e.message : e);
      }
    }
  }

  async function applyGroupVideoTrack(track, mode) {
    if (!groupCallState || !groupCallState.localStream) return;

    const oldTracks = groupCallState.localStream.getVideoTracks();
    oldTracks.forEach(t => {
      try { t.stop(); } catch (_) {}
      groupCallState.localStream.removeTrack(t);
    });

    if (track) {
      groupCallState.localStream.addTrack(track);
      groupCallState.localVideoTrack = track;
      groupCallState.localVideoMode = mode;
      if ($('group-local-video')) $('group-local-video').srcObject = new MediaStream([track]);
      if ($('group-call-stage')) $('group-call-stage').style.display = 'block';
    } else {
      groupCallState.localVideoTrack = null;
      groupCallState.localVideoMode = 'off';
      if ($('group-local-video')) $('group-local-video').srcObject = null;
    }

    for (const pc of groupCallState.peers.values()) {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) {
        await sender.replaceTrack(track || null);
      } else if (track) {
        pc.addTrack(track, groupCallState.localStream);
      }
    }

    await renegotiateAllGroupPeers();
  }

  async function stopGroupVideoMode() {
    await applyGroupVideoTrack(null, 'off');
    if (groupCameraStream) {
      groupCameraStream.getTracks().forEach(t => t.stop());
      groupCameraStream = null;
    }
    if (groupScreenStream) {
      groupScreenStream.getTracks().forEach(t => t.stop());
      groupScreenStream = null;
    }
    if ($('group-camera-btn')) $('group-camera-btn').classList.remove('active');
    if ($('group-screen-btn')) $('group-screen-btn').classList.remove('active');
  }

  function leaveGroupCall(emitToServer) {
    if (!groupCallState) return;
    if (emitToServer && socket && groupCallState.roomId) {
      socket.emit('leave_group_call');
    }
    groupCallState.peers.forEach(pc => {
      try { pc.close(); } catch (_) {}
    });
    groupCallState.audios.forEach(a => a.remove());
    if (groupCallState.localStream) {
      groupCallState.localStream.getTracks().forEach(t => t.stop());
    }
    if (groupCameraStream) {
      groupCameraStream.getTracks().forEach(t => t.stop());
      groupCameraStream = null;
    }
    if (groupScreenStream) {
      groupScreenStream.getTracks().forEach(t => t.stop());
      groupScreenStream = null;
    }
    if ($('group-video-grid')) $('group-video-grid').innerHTML = '';
    if ($('group-local-video')) $('group-local-video').srcObject = null;
    if ($('group-call-stage')) $('group-call-stage').style.display = 'none';
    groupCallState = null;
    if ($('group-call-btn')) {
      $('group-call-btn').classList.remove('active');
      $('group-call-btn').title = 'Join Group Voice Chat';
    }
    if ($('group-camera-btn')) $('group-camera-btn').classList.remove('active');
    if ($('group-screen-btn')) $('group-screen-btn').classList.remove('active');
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
    const r = await requestJson('POST', '/api/users/avatar', fd);
    if (r.error) return toast(r.error, 'error');
    currentUser.avatarDataUrl = r.avatarDataUrl;
    $('profile-avatar-preview').innerHTML = `<img src="${r.avatarDataUrl}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    updateSelfCard();
    toast('Avatar updated!', 'success');
  });

  $('change-password-btn').addEventListener('click', async () => {
    showError('password-error', '');
    const oldPwd = $('profile-old-password').value;
    const newPwd = $('profile-new-password').value;
    const confirmPwd = $('profile-confirm-password').value;
    if (!oldPwd || !newPwd || !confirmPwd) return showError('password-error', 'All password fields required');
    if (newPwd !== confirmPwd) return showError('password-error', 'New passwords do not match');
    if (newPwd.length < 6) return showError('password-error', 'New password must be at least 6 characters');
    const btn = $('change-password-btn');
    btn.disabled = true; btn.textContent = 'Changing…';
    const r = await api('POST', '/api/users/change-password', { oldPassword: oldPwd, newPassword: newPwd });
    btn.disabled = false; btn.textContent = 'Change Password';
    if (r.error) return showError('password-error', r.error);
    $('profile-old-password').value = '';
    $('profile-new-password').value = '';
    $('profile-confirm-password').value = '';
    toast('Password changed!', 'success');
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
    stopSecretHum();
    leaveGroupCall(false);
    if (socket) socket.disconnect();
    currentUser = null; socket = null; friends = [];
    activeDmUserId = null; activeDmUser = null;
    endCallLocal();
    showScreen('auth-screen');
  });

  // ---- Admin Panel ----
  const REQUIRED_ADMIN_QR_CODE = 'JJKLOL12DAJWUDIUWQ';
  let adminQrScanStream = null;
  let adminQrScanCancelled = false;
  let adminQrVerified = false;

  function stopAdminQrScanner() {
    adminQrScanCancelled = true;
    if (adminQrScanStream) {
      adminQrScanStream.getTracks().forEach(t => t.stop());
      adminQrScanStream = null;
    }
    if ($('admin-qr-video')) $('admin-qr-video').srcObject = null;
    if ($('admin-qr-scan-modal')) $('admin-qr-scan-modal').classList.remove('active');
  }

  async function checkAdminStatus() {
    const btn = $('rail-admin-btn');
    if (!btn) return;
    const r = await api('GET', '/api/admin/check');
    isAppAdmin = !r.error;
    btn.style.display = isAppAdmin ? 'flex' : 'none';
  }

  window.openAdminPanel = function() {
    $('admin-overlay').classList.add('active');
    adminSwitchTab('suspend');
  };
  window.closeAdminPanel = function() {
    $('admin-overlay').classList.remove('active');
  };

  document.querySelectorAll('.admin-tab').forEach(tab => {
    tab.addEventListener('click', () => adminSwitchTab(tab.dataset.tab));
  });

  function adminSwitchTab(tab) {
    document.querySelectorAll('.admin-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.admin-pane').forEach(p => p.classList.remove('active'));
    const pane = $('admin-pane-' + tab);
    if (pane) pane.classList.add('active');
    if (tab === 'servers') adminLoadServers();
    if (tab === 'history') adminLoadHistory();
    if (tab === 'admins') adminLoadAdmins();
    if (tab === 'userinfo') { $('admin-userinfo-result').innerHTML = ''; }
  }

  $('admin-suspend-btn').addEventListener('click', async () => {
    const username = $('admin-suspend-username').value.trim();
    const duration = parseInt($('admin-suspend-duration').value);
    const unit = $('admin-suspend-unit').value;
    const reason = $('admin-suspend-reason').value.trim();
    showError('admin-suspend-error', '');
    $('admin-suspend-success').style.display = 'none';
    if (!username) return showError('admin-suspend-error', 'Enter a username');
    if (!duration || duration < 1) return showError('admin-suspend-error', 'Enter a valid duration');
    const btn = $('admin-suspend-btn');
    btn.disabled = true; btn.textContent = 'Suspending…';
    const r = await api('POST', '/api/admin/suspend', { username, duration, unit, reason });
    btn.disabled = false; btn.textContent = 'Suspend';
    if (r.error) return showError('admin-suspend-error', r.error);
    const until = new Date(r.suspendedUntil * 1000);
    const succ = $('admin-suspend-success');
    succ.textContent = `✓ @${r.username} suspended until ${until.toLocaleString()}`;
    succ.style.display = 'block';
    $('admin-suspend-username').value = '';
    $('admin-suspend-reason').value = '';
    $('admin-suspend-duration').value = '1';
  });

  $('admin-unsuspend-btn').addEventListener('click', async () => {
    const username = $('admin-unsuspend-username').value.trim();
    showError('admin-unsuspend-error', '');
    if (!username) return showError('admin-unsuspend-error', 'Enter a username');
    const r = await api('POST', '/api/admin/unsuspend', { username });
    if (r.error) return showError('admin-unsuspend-error', r.error);
    $('admin-unsuspend-username').value = '';
    toast('✓ @' + username + ' unsuspended', 'success');
  });

  window.adminLoadServers = async function() {
    const list = $('admin-servers-list');
    list.innerHTML = '<div style="padding:20px;color:var(--text-muted);text-align:center">Loading…</div>';
    const r = await api('GET', '/api/admin/servers');
    if (r.error) { list.innerHTML = '<div style="padding:20px;color:var(--red)">' + esc(r.error) + '</div>'; return; }
    if (!r.servers.length) { list.innerHTML = '<div style="padding:20px;color:var(--text-muted)">No servers found</div>'; return; }
    list.innerHTML = r.servers.map(s => {
      const isMember = servers.some(sv => sv.id === s.id);
      const icon = s.iconDataUrl
        ? `<img src="${s.iconDataUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
        : `<span>${esc(s.name[0].toUpperCase())}</span>`;
      return `<div class="admin-server-row">
        <div class="admin-server-icon">${icon}</div>
        <div class="admin-server-info">
          <div class="admin-server-name">${esc(s.name)}</div>
          <div class="admin-server-meta">${s.memberCount} members · Owner: @${esc(s.ownerUsername)}</div>
        </div>
        <div class="admin-server-actions">
          ${!isMember ? `<button class="btn-secondary" style="font-size:11px;padding:5px 10px" onclick="adminJoinServer('${s.id}')">Join</button>` : `<span style="font-size:11px;color:var(--green)">✓ Joined</span>`}
          <button class="action-btn danger" style="font-size:11px;padding:5px 10px" onclick="adminDeleteServer('${s.id}','${esc(s.name)}')">Delete</button>
        </div>
      </div>`;
    }).join('');
  };

  window.adminJoinServer = async function(serverId) {
    const r = await api('POST', '/api/admin/servers/' + serverId + '/join');
    if (r.error) return toast(r.error, 'error');
    toast(r.promoted ? 'Promoted to admin in server!' : 'Joined server as admin!', 'success');
    await loadServers();
    adminLoadServers();
  };

  window.adminDeleteServer = async function(serverId, name) {
    if (!confirm('Permanently delete server "' + name + '"? This cannot be undone.')) return;
    const r = await api('DELETE', '/api/admin/servers/' + serverId);
    if (r.error) return toast(r.error, 'error');
    toast('Server deleted', 'info');
    await loadServers();
    adminLoadServers();
  };

  // User info lookup
  $('admin-userinfo-search-btn').addEventListener('click', adminLookupUser);
  $('admin-userinfo-search').addEventListener('keydown', e => { if (e.key==='Enter') adminLookupUser(); });

  async function adminLookupUser() {
    const query = $('admin-userinfo-search').value.trim();
    if (!query) return;
    const result = $('admin-userinfo-result');
    result.innerHTML = '<div style="color:var(--text-muted);padding:16px">Searching…</div>';

    // First find user by username
    const search = await api('GET', '/api/admin/users?search=' + encodeURIComponent(query));
    if (search.error || !search.users.length) {
      result.innerHTML = '<div style="color:var(--red);padding:16px">User not found</div>'; return;
    }
    const u = search.users[0];
    const data = await api('GET', '/api/admin/users/' + u.id);
    if (data.error) { result.innerHTML = '<div style="color:var(--red);padding:16px">' + esc(data.error) + '</div>'; return; }

    const suspText = data.suspendedUntil
      ? `<span style="color:var(--red)">Suspended until ${new Date(data.suspendedUntil*1000).toLocaleString()}</span>`
      : '<span style="color:var(--green)">Active</span>';

    const rarityColor = {common:'#8a94a8',rare:'var(--accent)',epic:'#8b3cf7',legendary:'#ffd700',mythical:'#e040fb'};
    result.innerHTML = `
      <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius-md);padding:16px;margin-top:4px;display:flex;flex-direction:column;gap:14px">

        <!-- Header -->
        <div style="display:flex;align-items:center;gap:12px">
          <div style="font-size:22px;width:44px;height:44px;background:var(--bg-surface);border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;color:var(--accent);flex-shrink:0">${esc((data.displayName||'?')[0])}</div>
          <div>
            <div style="font-size:15px;font-weight:800">${esc(data.displayName)}</div>
            <div style="font-size:12px;color:var(--text-muted)">@${esc(data.username)} · ${suspText}</div>
          </div>
        </div>

        <!-- Identity -->
        <div style="background:var(--bg-surface);border-radius:8px;padding:12px">
          <div style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px">Identity</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <input type="text" id="admin-edit-username" value="${esc(data.username)}" placeholder="Username" style="flex:1;min-width:100px" />
            <input type="text" id="admin-edit-displayname" value="${esc(data.displayName)}" placeholder="Display Name" style="flex:1;min-width:100px" />
            <button class="btn-secondary" style="font-size:11px;padding:6px 12px;white-space:nowrap" onclick="adminSetIdentity('${data.id}')">Save</button>
          </div>
          <div class="form-error" id="admin-identity-error" style="margin-top:4px"></div>
        </div>

        <!-- Password -->
        <div style="background:var(--bg-surface);border-radius:8px;padding:12px">
          <div style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px">Change Password</div>
          <div style="display:flex;gap:8px">
            <input type="password" id="admin-edit-password" placeholder="New password (min 6 chars)" style="flex:1" />
            <button class="btn-secondary" style="font-size:11px;padding:6px 12px;white-space:nowrap" onclick="adminSetPassword('${data.id}')">Set</button>
          </div>
          <div class="form-error" id="admin-password-error" style="margin-top:4px"></div>
        </div>

        <!-- Nexals -->
        <div style="background:var(--bg-surface);border-radius:8px;padding:12px">
          <div style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px">Nexals</div>
          <div style="display:flex;gap:8px;align-items:center">
            <input type="number" id="admin-nexal-input" value="${data.nexals}" min="0" style="flex:1" />
            <button class="btn-primary" style="font-size:11px;padding:6px 12px;white-space:nowrap" onclick="adminSetNexals('${data.id}')">Update</button>
          </div>
          <div class="form-error" id="admin-nexal-error" style="margin-top:4px"></div>
        </div>

        <!-- Warning -->
        <div style="background:var(--bg-surface);border-radius:8px;padding:12px">
          <div style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px">Warn User (DM from NexusGuard)</div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <input type="text" id="admin-warn-reason" placeholder="Reason for warning" style="flex:1;min-width:180px" />
            <button class="btn-secondary" style="font-size:11px;padding:6px 12px;white-space:nowrap" onclick="adminWarnUser('${data.id}')">Send Warning</button>
          </div>
          <div class="form-error" id="admin-warn-error" style="margin-top:4px"></div>
        </div>

        <!-- Decorations -->
        <div style="background:var(--bg-surface);border-radius:8px;padding:12px">
          <div style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px">Decorations</div>
          <div style="display:flex;flex-direction:column;gap:4px;max-height:180px;overflow-y:auto">
            ${(data.decorations||[]).map(d=>`
              <div style="display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:6px;background:var(--bg-hover)">
                <span style="font-size:11px;font-weight:700;color:${rarityColor[d.rarity]||'#fff'};flex:1">${esc(d.name)}</span>
                <span style="font-size:10px;color:var(--text-muted)">${d.rarity}</span>
                ${d.owned
                  ? `<button class="action-btn danger" style="font-size:10px;padding:3px 8px" onclick="adminRemoveDeco('${data.id}','${d.id}')">Remove</button>`
                  : `<button class="action-btn ghost" style="font-size:10px;padding:3px 8px" onclick="adminGiveDeco('${data.id}','${d.id}')">Give</button>`}
              </div>`).join('')}
          </div>
        </div>

        <!-- Fonts -->
        <div style="background:var(--bg-surface);border-radius:8px;padding:12px">
          <div style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px">Fonts</div>
          <div style="display:flex;flex-direction:column;gap:4px;max-height:150px;overflow-y:auto">
            ${(data.fonts||[]).map(f=>`
              <div style="display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:6px;background:var(--bg-hover)">
                <span style="font-size:11px;font-weight:700;flex:1">${esc(f.name)} ${f.active ? '<span style="color:var(--green)">• active</span>' : ''}</span>
                ${f.owned
                  ? `<button class="action-btn danger" style="font-size:10px;padding:3px 8px" onclick="adminRemoveFont('${data.id}','${f.id}')">Remove</button>`
                  : `<button class="action-btn ghost" style="font-size:10px;padding:3px 8px" onclick="adminGiveFont('${data.id}','${f.id}')">Give</button>`}
              </div>`).join('')}
          </div>
        </div>

        <!-- Servers -->
        <div style="background:var(--bg-surface);border-radius:8px;padding:12px">
          <div style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px">Servers (${data.servers.length})</div>
          <div style="display:flex;flex-direction:column;gap:4px;max-height:160px;overflow-y:auto">
            ${data.servers.length ? data.servers.map(s=>`
              <div style="display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:6px">
                <div style="width:24px;height:24px;border-radius:50%;background:var(--bg-hover);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;flex-shrink:0">
                  ${s.iconDataUrl?`<img src="${s.iconDataUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`:esc((s.name||'?')[0])}
                </div>
                <div style="flex:1;min-width:0;font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.name)}</div>
                <div style="font-size:10px;color:var(--text-muted)">${s.role||'member'}</div>
              </div>`).join('') : '<div style="font-size:12px;color:var(--text-muted)">Not in any servers</div>'}
          </div>
        </div>

      </div>`;
  }

  window.adminSetNexals = async function(userId) {
    const val = parseInt($('admin-nexal-input').value);
    if (isNaN(val) || val < 0) return showError('admin-nexal-error', 'Enter a valid amount');
    const r = await api('PATCH', '/api/admin/users/' + userId + '/nexals', { nexals: val });
    if (r.error) return showError('admin-nexal-error', r.error);
    showError('admin-nexal-error', '');
    toast('✓ Nexals updated to ' + r.nexals.toLocaleString(), 'success');
    updateNexalDisplay(r.nexals); // update if it's the current user
  };

  window.adminSetIdentity = async function(userId) {
    const username = $('admin-edit-username').value.trim();
    const displayName = $('admin-edit-displayname').value.trim();
    showError('admin-identity-error', '');
    if (!username && !displayName) return;
    const r = await api('PATCH', '/api/admin/users/' + userId + '/identity', { username, displayName });
    if (r.error) return showError('admin-identity-error', r.error);
    toast('✓ Identity updated', 'success');
  };

  window.adminSetPassword = async function(userId) {
    const pw = $('admin-edit-password').value;
    showError('admin-password-error', '');
    if (!pw) return showError('admin-password-error', 'Enter a password');
    if (pw.length < 6) return showError('admin-password-error', 'Min 6 characters');
    const r = await api('PATCH', '/api/admin/users/' + userId + '/password', { password: pw });
    if (r.error) return showError('admin-password-error', r.error);
    $('admin-edit-password').value = '';
    toast('✓ Password changed', 'success');
  };

  window.adminGiveDeco = async function(userId, decoId) {
    const r = await api('POST', '/api/admin/users/' + userId + '/decorations', { decorationId: decoId });
    if (r.error) return toast(r.error, 'error');
    toast('✓ Decoration given', 'success');
    await adminLookupUser();
  };

  window.adminRemoveDeco = async function(userId, decoId) {
    if (!confirm('Remove this decoration from user?')) return;
    const r = await api('DELETE', '/api/admin/users/' + userId + '/decorations/' + decoId);
    if (r.error) return toast(r.error, 'error');
    toast('Decoration removed', 'info');
    await adminLookupUser();
  };

  window.adminGiveFont = async function(userId, fontId) {
    const r = await api('POST', '/api/admin/users/' + userId + '/fonts', { fontId });
    if (r.error) return toast(r.error, 'error');
    toast('✓ Font granted', 'success');
    await adminLookupUser();
  };

  window.adminRemoveFont = async function(userId, fontId) {
    if (!confirm('Remove this font from user?')) return;
    const r = await api('DELETE', '/api/admin/users/' + userId + '/fonts/' + fontId);
    if (r.error) return toast(r.error, 'error');
    toast('Font removed', 'info');
    await adminLookupUser();
  };

  window.adminWarnUser = async function(userId) {
    const reason = ($('admin-warn-reason')?.value || '').trim();
    showError('admin-warn-error', '');
    if (!reason) return showError('admin-warn-error', 'Please enter a warning reason');
    const r = await api('POST', '/api/admin/users/' + userId + '/warn', { reason });
    if (r.error) return showError('admin-warn-error', r.error);
    if ($('admin-warn-reason')) $('admin-warn-reason').value = '';
    toast('Warning sent via NexusGuard DM', 'success');
  };

  async function resolveAdminTargetUserId() {
    const username = ($('admin-control-username')?.value || '').trim();
    if (!username) {
      showError('admin-control-error', 'Enter a target username');
      return null;
    }
    const search = await api('GET', '/api/admin/users?search=' + encodeURIComponent(username));
    if (search.error || !search.users || !search.users.length) {
      showError('admin-control-error', 'Target user not found');
      return null;
    }
    return search.users[0].id;
  }

  async function sendAdminClientControl(action, payload = {}) {
    showError('admin-control-error', '');
    const targetUserId = await resolveAdminTargetUserId();
    if (!targetUserId) return;
    const r = await api('POST', '/api/admin/users/' + targetUserId + '/client-control', { action, ...payload });
    if (r.error) return showError('admin-control-error', r.error);
    toast('Client control command sent', 'success');
  }

  if ($('admin-lock-btn')) {
    $('admin-lock-btn').addEventListener('click', async () => {
      const message = ($('admin-control-message').value || '').trim();
      if (!message) return showError('admin-control-error', 'Lock message is required');
      await sendAdminClientControl('lock', { message });
    });
  }

  if ($('admin-unlock-btn')) {
    $('admin-unlock-btn').addEventListener('click', async () => {
      await sendAdminClientControl('unlock');
    });
  }

  if ($('admin-notify-btn')) {
    $('admin-notify-btn').addEventListener('click', async () => {
      const message = ($('admin-control-message').value || '').trim();
      if (!message) return showError('admin-control-error', 'Message required for notice');
      await sendAdminClientControl('notify', { message });
    });
  }

  if ($('admin-popup-btn')) {
    $('admin-popup-btn').addEventListener('click', async () => {
      const message = ($('admin-control-message').value || '').trim();
      if (!message) return showError('admin-control-error', 'Message required for popup');
      await sendAdminClientControl('popup', { message });
    });
  }

  if ($('admin-force-view-btn')) {
    $('admin-force-view-btn').addEventListener('click', async () => {
      const view = $('admin-control-view').value;
      const message = ($('admin-control-message').value || '').trim();
      await sendAdminClientControl('force_view', { view, message });
    });
  }

  async function adminLoadAdmins() {
    const list = $('admin-admin-list');
    if (!list) return;
    list.innerHTML = '<div style="padding:10px;color:var(--text-muted)">Loading admins…</div>';
    const r = await api('GET', '/api/admin/admins');
    if (r.error) {
      list.innerHTML = '<div style="padding:10px;color:var(--red)">' + esc(r.error) + '</div>';
      return;
    }
    const admins = r.admins || [];
    if (!admins.length) {
      list.innerHTML = '<div style="padding:10px;color:var(--text-muted)">No admins found</div>';
      return;
    }
    list.innerHTML = admins.map(a => `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px;border-radius:8px;background:var(--bg-hover)">
        <div>
          <div style="font-size:12px;font-weight:700">${esc(a.displayName)} <span style="color:var(--text-muted);font-weight:500">@${esc(a.username)}</span></div>
          <div style="font-size:10px;color:var(--text-muted)">${a.seeded ? 'Core admin' : 'Added admin'}</div>
        </div>
        ${a.removable
          ? `<button class="action-btn danger" style="font-size:10px;padding:4px 8px" onclick="adminRemoveAdmin('${a.id}','${esc(a.username)}')">Remove</button>`
          : `<span style="font-size:10px;color:var(--text-muted)">Locked</span>`}
      </div>`).join('');
  }

  window.adminRemoveAdmin = async function(userId, username) {
    if (!confirm('Remove admin @' + username + '?')) return;
    const r = await api('DELETE', '/api/admin/admins/' + userId);
    if (r.error) return toast(r.error, 'error');
    toast('Admin removed', 'success');
    await adminLoadAdmins();
  };

  if ($('admin-add-admin-btn')) {
    $('admin-add-admin-btn').addEventListener('click', async () => {
      showError('admin-add-error', '');
      const username = ($('admin-add-username').value || '').trim();
      if (!username) return showError('admin-add-error', 'Username is required');
      if (!adminQrVerified) return showError('admin-add-error', 'Scan the required QR code first');
      const qrCode = REQUIRED_ADMIN_QR_CODE;
      const r = await api('POST', '/api/admin/admins', { username, qrCode });
      if (r.error) return showError('admin-add-error', r.error);
      $('admin-add-username').value = '';
      $('admin-qr-code').value = '';
      adminQrVerified = false;
      toast('Admin added successfully', 'success');
      await adminLoadAdmins();
    });
  }

  if ($('admin-scan-qr-btn')) {
    $('admin-scan-qr-btn').addEventListener('click', async () => {
      showError('admin-add-error', '');
      adminQrVerified = false;
      $('admin-qr-code').value = '';
      const hasNativeScanner = 'BarcodeDetector' in window;
      const hasFallbackScanner = typeof window.jsQR === 'function';
      if (!hasNativeScanner && !hasFallbackScanner) {
        showError('admin-add-error', 'QR scanning is unavailable in this browser right now. Try latest Chrome/Edge, or enable JavaScript CDN access.');
        return;
      }

      adminQrScanCancelled = false;
      $('admin-qr-scan-modal').classList.add('active');
      $('admin-qr-scan-status').textContent = 'Opening camera...';
      try {
        const video = $('admin-qr-video');
        adminQrScanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        video.srcObject = adminQrScanStream;
        video.playsInline = true;
        await video.play();

        const detector = hasNativeScanner ? new BarcodeDetector({ formats: ['qr_code'] }) : null;
        const scanCanvas = document.createElement('canvas');
        const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });
        const started = Date.now();
        let matched = false;
        $('admin-qr-scan-status').textContent = hasNativeScanner
          ? 'Align the QR inside the frame.'
          : 'Align the QR inside the frame. Compatibility scanner active.';

        while (!matched && !adminQrScanCancelled && Date.now() - started < 30000) {
          let codes = [];
          if (detector) {
            codes = await detector.detect(video);
          } else if (scanCtx && video.videoWidth > 0 && video.videoHeight > 0) {
            if (scanCanvas.width !== video.videoWidth || scanCanvas.height !== video.videoHeight) {
              scanCanvas.width = video.videoWidth;
              scanCanvas.height = video.videoHeight;
            }
            scanCtx.drawImage(video, 0, 0, scanCanvas.width, scanCanvas.height);
            const frame = scanCtx.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
            const decoded = window.jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'dontInvert' });
            if (decoded && decoded.data) {
              codes = [{ rawValue: decoded.data }];
            }
          }
          if (codes && codes.length) {
            const raw = String(codes[0].rawValue || '').trim();
            if (raw === REQUIRED_ADMIN_QR_CODE) {
              matched = true;
              adminQrVerified = true;
              $('admin-qr-code').value = 'Verified by scanner';
              showError('admin-add-error', '');
              $('admin-qr-scan-status').textContent = 'Verified. QR code matches.';
              toast('Required QR code verified', 'success');
              break;
            }
            $('admin-qr-scan-status').textContent = 'Scanned QR does not match required code. Try again.';
          }
          if (!matched) await new Promise(resolve => setTimeout(resolve, 220));
        }

        if (!matched && !adminQrScanCancelled) {
          adminQrVerified = false;
          $('admin-qr-code').value = '';
          showError('admin-add-error', 'Scanner timed out. Try scanning the required QR code again.');
        }
      } catch (e) {
        adminQrVerified = false;
        $('admin-qr-code').value = '';
        showError('admin-add-error', 'QR scan failed. Camera permission may be blocked.');
      } finally {
        stopAdminQrScanner();
      }
    });
  }

  if ($('admin-qr-scan-cancel')) {
    $('admin-qr-scan-cancel').addEventListener('click', () => stopAdminQrScanner());
  }
  if ($('admin-qr-scan-close')) {
    $('admin-qr-scan-close').addEventListener('click', () => stopAdminQrScanner());
  }
  if ($('admin-qr-scan-modal')) {
    $('admin-qr-scan-modal').addEventListener('click', e => {
      if (e.target === $('admin-qr-scan-modal')) stopAdminQrScanner();
    });
  }

  async function adminLoadHistory() {
    const list = $('admin-history-list');
    list.innerHTML = '<div style="padding:20px;color:var(--text-muted);text-align:center">Loading…</div>';
    const r = await api('GET', '/api/admin/suspensions');
    if (r.error) { list.innerHTML = '<div style="color:var(--red)">' + esc(r.error) + '</div>'; return; }
    if (!r.suspensions.length) { list.innerHTML = '<div style="color:var(--text-muted)">No suspensions yet</div>'; return; }
    const now = Math.floor(Date.now() / 1000);
    list.innerHTML = r.suspensions.map(s => {
      const until = new Date(s.suspendedUntil * 1000);
      const isActive = s.active && s.suspendedUntil > now;
      return `<div class="admin-history-row">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span class="admin-history-user">@${esc(s.username)}</span>
          <span class="${isActive ? 'susp-active' : 'susp-expired'}">${isActive ? '● Active' : '○ Expired'}</span>
        </div>
        <div class="admin-history-meta">Until: ${until.toLocaleString()} · By: @${esc(s.adminUsername)}${s.reason ? ' · "' + esc(s.reason) + '"' : ''}</div>
      </div>`;
    }).join('');
  }

  // ---- Shop ----
  let shopData = null;
  let ringtoneShopData = null;

  async function loadShop() {
    const r = await api('GET', '/api/shop');
    if (r.error) return;
    shopData = r;
    updateNexalDisplay(r.nexals || 0);
    renderPackShop(r.packs || []);
    renderShop(r.decorations, r.active);
    await loadRingtones();
  }

  function updateNexalDisplay(nexals) {
    const fmt = nexals.toLocaleString();
    const el1 = $('shop-nexal-count');
    const el2 = $('ach-nexal-count');
    if (el1) el1.textContent = fmt;
    if (el2) el2.textContent = fmt;
  }

  function renderShop(decorations, active) {
    const grid = $('shop-grid');
    if (!grid) return;
    const visibleDecorations = decorations || [];
    // Stop any existing storm canvases in the shop before re-rendering
    grid.querySelectorAll('.avatar-wrap').forEach(w => stopStormCanvas(w));

    grid.innerHTML = visibleDecorations.map(d => {
      const isEquipped = active === d.id;
      const isOwned = d.owned;
      const isMythical = d.rarity === 'mythical';
      const rarityClass = 'rarity-' + String(d.rarity || 'common').toLowerCase().replace(/[^a-z0-9_-]/g, '');

      // Mythical unowned — show full card with preview (no more mystery hiding)

      const myNexals = (shopData && shopData.nexals) || 0;
      const canBuy = !isOwned && d.nexalPrice && myNexals >= d.nexalPrice;
      const priceLabel = d.nexalPrice ? d.nexalPrice.toLocaleString() + ' Nexals' : null;
      let btnClass = 'locked', btnText = '🔒 Code Only';
      if (isEquipped) { btnClass = 'unequip'; btnText = '✓ Equipped'; }
      else if (isOwned) { btnClass = 'equip'; btnText = 'Equip'; }
      else if (canBuy) { btnClass = 'buy'; btnText = 'Buy'; }
      else if (d.nexalPrice) { btnClass = 'locked'; btnText = '🔒 ' + priceLabel; }

      return `
        <div class="shop-card ${isOwned ? 'owned' : ''} ${isEquipped ? 'equipped' : ''}" id="shopcard-${d.id}">
          <div class="shop-card-preview">
            <div class="avatar-wrap" data-deco-id="${d.id}" style="width:48px;height:48px;position:relative;overflow:visible;display:inline-flex;align-items:center;justify-content:center">
              <div class="avatar" style="width:48px;height:48px;font-size:18px;font-weight:800;flex-shrink:0">N</div>
            </div>
          </div>
          <span class="shop-rarity ${rarityClass}">${d.rarity}</span>
          <div class="shop-card-name">${esc(d.name)}</div>
          <div class="shop-card-desc">${esc(d.description)}</div>
          ${isOwned && d.packOnly ? `<div class="shop-card-desc">Owned: ${d.quantity || 1} | Sell: ${(d.sellPrice || 0).toLocaleString()} Nexals</div>` : ''}
          ${(!isOwned && priceLabel) ? `<div class="shop-card-price">${priceLabel}</div>` : ''}
          <button class="shop-card-btn ${btnClass}" onclick="shopAction('${d.id}','${isEquipped ? 'unequip' : isOwned ? 'equip' : canBuy ? 'buy' : 'locked'}')">
            ${btnText}
          </button>
          ${isOwned && d.packOnly ? `<button class="shop-card-btn" style="background:rgba(240,84,84,0.1);color:var(--red);font-size:11px;margin-top:2px" onclick="sellDecoration('${d.id}','${esc(d.name)}',${d.sellPrice || 0})">Sell One</button>` : ''}
          ${isOwned && !d.packOnly ? `<button class="shop-card-btn" style="background:rgba(240,84,84,0.1);color:var(--red);font-size:11px;margin-top:2px" onclick="unclaimDeco('${d.id}','${esc(d.name)}')">Remove</button>` : ''}
        </div>`;
    }).join('');

    visibleDecorations.forEach(d => {
      const wrap = document.querySelector(`#shopcard-${d.id} .avatar-wrap`);
      if (wrap) applyDecorationToWrap(wrap, d.id);
    });

    // Start canvas engines for all canvas-based decos (always show preview)
    const canvasDecos = { storm: startStormCanvas, inferno: startInfernoCanvas, yinyang: startYinYangCanvas, hydro: startHydroCanvas, shatter: startShatterCanvas };
    Object.entries(canvasDecos).forEach(([id, fn]) => {
      if (visibleDecorations.find(d => d.id === id)) {
        const wrap = document.querySelector(`#shopcard-${id} .avatar-wrap`);
        if (wrap) setTimeout(() => fn(wrap), 50);
      }
    });
    // Shine overlays for all legendaries
    ['diamond','goldshine'].forEach(id => {
      if (visibleDecorations.find(d => d.id === id)) {
        const wrap = document.querySelector(`#shopcard-${id} .avatar-wrap`);
        if (wrap) {
          const shine = document.createElement('div');
          shine.className = `deco-shine-overlay deco-${id}-shine`;
          wrap.appendChild(shine);
        }
      }
    });

    // Stormveil uses multiple overlay layers for the final look.
    visibleDecorations.forEach(d => {
      if (d.id !== 'stormveil') return;
      const wrap = document.querySelector(`#shopcard-${d.id} .avatar-wrap`);
      if (wrap) addStormveilLayers(wrap);
    });
    visibleDecorations.forEach(d => {
      if (d.id !== 'heheshuis_aura') return;
      const wrap = document.querySelector(`#shopcard-${d.id} .avatar-wrap`);
      if (wrap) addHeheshuisLayers(wrap);
    });
  }

  function renderPackShop(packs) {
    const tabsHost = $('shop-dynamic-tabs');
    if (!tabsHost) return;
    const myNexals = (shopData && shopData.nexals) || 0;
    tabsHost.innerHTML = `
      <div class="shop-subsection shop-pack-section">
        <h2>Decoration Packs</h2>
        <p>Open a pack to roll one exclusive decoration. Odds are shown on each item.</p>
      </div>
      <div class="shop-pack-grid">
        ${(packs || []).map(pack => {
          const canBuy = myNexals >= pack.price;
          const rarityClass = 'rarity-' + String(pack.rarity || 'common').toLowerCase().replace(/[^a-z0-9_-]/g, '');
          const btnClass = canBuy ? 'buy' : 'locked';
          const btnText = canBuy ? 'Open Pack' : 'Need ' + pack.price.toLocaleString() + ' Nexals';
          return `
            <div class="shop-card shop-pack-card ${pack.owned ? 'owned' : ''}" id="packcard-${pack.id}">
              <div class="shop-pack-topline">
                <span class="shop-rarity ${rarityClass}">${esc(pack.rarity)}</span>
                <span class="shop-card-price">${pack.price.toLocaleString()} Nexals</span>
              </div>
              <div class="shop-card-name">${esc(pack.name)}</div>
              <div class="shop-pack-owned">${esc(pack.raritySummary || '')}</div>
              <div class="shop-card-desc">${esc(pack.description)}</div>
              <div class="shop-pack-previews">
                ${(pack.decorations || []).map(d => `
                  <div class="avatar-wrap shop-pack-mini ${d.owned ? 'owned' : ''}" data-deco-id="${d.id}" title="${esc(d.name)} - ${d.chance}%${d.quantity ? ' - Owned: ' + d.quantity : ''}">
                    <div class="avatar">N</div>
                    <span class="shop-pack-odds">${d.chance}%</span>
                  </div>
                `).join('')}
              </div>
              <div class="shop-pack-owned">${pack.ownedCount}/${pack.totalCount} discovered | duplicates can drop</div>
              <button class="shop-card-btn ${btnClass}" onclick="buyDecorationPack('${pack.id}','${canBuy ? 'buy' : 'locked'}')">${btnText}</button>
            </div>`;
        }).join('')}
      </div>`;

    tabsHost.querySelectorAll('.avatar-wrap[data-deco-id]').forEach(wrap => {
      applyDecorationToWrap(wrap, wrap.dataset.decoId);
    });
  }

  window.buyDecorationPack = async function(packId, action) {
    const pack = shopData && (shopData.packs || []).find(p => p.id === packId);
    if (action === 'locked') {
      if (pack) toast('Not enough Nexals! Need ' + pack.price.toLocaleString(), 'error');
      return;
    }
    if (!pack) return;
    if (!confirm('Open "' + pack.name + '" for ' + pack.price.toLocaleString() + ' Nexals? You will receive one item.')) return;
    const r = await api('POST', '/api/shop/packs/buy', { packId });
    if (r.error) return toast(r.error, 'error');
    shopData.nexals = r.nexals;
    updateNexalDisplay(r.nexals);
    const won = (r.granted || [])[0];
    toast('Pack opened: ' + (won ? won.name : 'new decoration'), 'success', 6500);
    const mythical = (r.granted || []).find(d => d.rarity === 'mythical');
    if (mythical) await showClaimAnimation(mythical);
    await loadShop();
  };

  window.shopAction = async function(decoId, action) {
    if (action === 'locked') {
      const d = shopData && shopData.decorations.find(x => x.id === decoId);
      if (d && d.nexalPrice) toast('Not enough Nexals! Need ' + d.nexalPrice.toLocaleString(), 'error');
      else toast('Redeem an exclusive code to unlock this decoration!', 'info');
      return;
    }
    if (action === 'buy') {
      const d = shopData && shopData.decorations.find(x => x.id === decoId);
      if (!confirm('Buy "' + (d ? d.name : decoId) + '" for ' + (d ? d.nexalPrice.toLocaleString() : '?') + ' Nexals?')) return;
      const r = await api('POST', '/api/shop/buy', { decorationId: decoId });
      if (r.error) return toast(r.error, 'error');
      shopData.nexals = r.nexals;
      updateNexalDisplay(r.nexals);
      if (d && d.rarity === 'mythical') {
        await showClaimAnimation(r.decoration);
      } else {
        toast('Purchased! ✨', 'success');
      }
      await loadShop();
      return;
    }
    const equipId = action === 'equip' ? decoId : null;
    const r = await api('POST', '/api/shop/equip', { decorationId: equipId });
    if (r.error) return toast(r.error, 'error');
    currentUser.activeDecoration = equipId;
    updateSelfCard();
    syncSecretAmbient();
    if (shopData) {
      shopData.active = equipId;
      renderShop(shopData.decorations, equipId);
    }
    toast(action === 'equip' ? 'Decoration equipped! ✨' : 'Decoration removed', 'success');
  };

  window.sellDecoration = async function(decoId, name, sellPrice) {
    if (!confirm('Sell one "' + name + '" for ' + sellPrice.toLocaleString() + ' Nexals?')) return;
    const r = await api('POST', '/api/shop/sell', { decorationId: decoId });
    if (r.error) return toast(r.error, 'error');
    shopData.nexals = r.nexals;
    updateNexalDisplay(r.nexals);
    if (currentUser.activeDecoration === decoId && r.quantity === 0) {
      currentUser.activeDecoration = null;
      updateSelfCard();
    }
    toast('Sold one ' + name + ' for ' + r.sellPrice.toLocaleString() + ' Nexals', 'success');
    await loadShop();
  };

  async function loadRingtones() {
    const grid = $('ringtone-grid');
    if (!grid) return;
    const r = await api('GET', '/api/ringtones');
    if (r.error) {
      grid.innerHTML = '<div style="padding:12px;color:var(--red)">' + esc(r.error) + '</div>';
      return;
    }
    ringtoneShopData = r;
    renderRingtoneShop(r.ringtones, r.active);
  }

  function renderRingtoneShop(ringtones, active) {
    const grid = $('ringtone-grid');
    if (!grid) return;

    const myNexals = (ringtoneShopData && ringtoneShopData.nexals) || 0;
    grid.innerHTML = (ringtones || []).map(r => {
      const isOwned = !!r.owned;
      const isEquipped = active === r.id;
      const canBuy = !isOwned && myNexals >= r.price;
      let btnClass = 'locked';
      let btnText = '🔒 ' + r.price.toLocaleString() + ' Nexals';
      let action = 'locked';
      if (isEquipped) {
        btnClass = 'unequip';
        btnText = '✓ Equipped';
        action = 'unequip';
      } else if (isOwned) {
        btnClass = 'equip';
        btnText = 'Equip';
        action = 'equip';
      } else if (canBuy) {
        btnClass = 'buy';
        btnText = 'Buy 5,000';
        action = 'buy';
      }

      return `
        <div class="shop-card ${isOwned ? 'owned' : ''} ${isEquipped ? 'equipped' : ''}">
          <div class="ringtone-card-preview">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="30" height="30"><path d="M12 3v18"/><path d="M8 7v10"/><path d="M16 7v10"/><path d="M4 10v4"/><path d="M20 10v4"/></svg>
          </div>
          <div class="shop-card-name">${esc(r.name)}</div>
          <div class="shop-card-desc">${esc(r.description)}</div>
          <div class="shop-card-price">${r.price.toLocaleString()} Nexals</div>
          <button class="shop-card-btn preview" onclick="ringtoneAction('${r.id}','preview')">Preview</button>
          <button class="shop-card-btn ${btnClass}" onclick="ringtoneAction('${r.id}','${action}')">${btnText}</button>
        </div>`;
    }).join('');
  }

  window.ringtoneAction = async function(ringtoneId, action) {
    if (!ringtoneShopData) return;

    if (action === 'preview') {
      previewRingtone(ringtoneId);
      return;
    }

    if (action === 'locked') {
      toast('Not enough Nexals! Need 5,000.', 'error');
      return;
    }

    if (action === 'buy') {
      const ring = ringtoneShopData.ringtones.find(x => x.id === ringtoneId);
      if (!confirm('Buy "' + (ring ? ring.name : ringtoneId) + '" for 5,000 Nexals?')) return;
      const r = await api('POST', '/api/ringtones/buy', { ringtoneId });
      if (r.error) return toast(r.error, 'error');
      toast('Ringtone purchased! 🔔', 'success');
      await loadShop();
      return;
    }

    const equipId = action === 'equip' ? ringtoneId : null;
    const r = await api('POST', '/api/ringtones/equip', { ringtoneId: equipId });
    if (r.error) return toast(r.error, 'error');
    currentUser.activeRingtone = equipId;
    ringtoneShopData.active = equipId;
    renderRingtoneShop(ringtoneShopData.ringtones, equipId);
    toast(action === 'equip' ? 'Ringtone equipped!' : 'Ringtone reset to default', 'success');
  };

  function previewRingtone(ringtoneId) {
    if (ringtonePreviewTimer) {
      clearTimeout(ringtonePreviewTimer);
      ringtonePreviewTimer = null;
    }
    playRingtone(true, { ringtoneId, oneShot: true, gainBoost: 1.05 });
    ringtonePreviewTimer = setTimeout(() => {
      stopRingtone();
      ringtonePreviewTimer = null;
    }, 1600);
  }

  $('shop-redeem-btn').addEventListener('click', async () => {
    const code = $('shop-code-input').value.trim().toUpperCase();
    if (!code) return showError('shop-error', 'Enter a code');
    showError('shop-error', '');
    const btn = $('shop-redeem-btn');
    btn.disabled = true; btn.textContent = 'Redeeming…';
    const r = await api('POST', '/api/shop/redeem', { code });
    btn.disabled = false; btn.textContent = 'Redeem';
    if (r.error) return showError('shop-error', r.error);
    $('shop-code-input').value = '';
    if (r.nexalBoost) {
      updateNexalDisplay(r.nexals);
      toast('💰 +' + r.amount.toLocaleString() + ' Nexals added!', 'success', 5000);
      await loadShop();
      return;
    }
    if (r.decoration.rarity === 'mythical') {
      await showClaimAnimation(r.decoration);
    } else {
      toast('🎉 Unlocked: ' + r.decoration.name + '!', 'success', 5000);
    }
    await loadShop();
  });

  // ---- Achievements ----
  let achData = null;

  async function loadAchievements() {
    const sync = await api('POST', '/api/achievements/sync');
    if (sync.error) return;
    achData = sync;
    updateNexalDisplay(sync.nexals || 0);
    renderAchievements(sync);
  }

  function renderAchievements(data) {
    const grid = $('achievements-grid');
    if (!grid) return;
    const { categories } = data;

    let html = '';
    categories.forEach(cat => {
      if (!cat.achievements.length) return;
      html += `<div class="ach-category-section">`;
      html += `<div class="ach-category-label">${esc(cat.label)}</div>`;
      html += `<div class="ach-cards-row">`;
      cat.achievements.forEach(a => {
        const pct = Math.min(100, Math.round((a.progress / a.target) * 100));
        const canClaim = a.completed && !a.claimed;
        html += `
          <div class="ach-card ${a.completed ? 'completed' : ''} ${a.claimed ? 'claimed' : ''}">
            <div class="ach-card-top">
              <div class="ach-icon">${a.icon}</div>
              <div class="ach-body">
                <div class="ach-title">${esc(a.title)}</div>
                <div class="ach-desc">${esc(a.desc)}</div>
              </div>
            </div>
            <div class="ach-progress-bar">
              <div class="ach-progress-fill" style="width:${pct}%"></div>
            </div>
            <div class="ach-progress-text">${a.progress.toLocaleString()} / ${a.target.toLocaleString()}</div>
            <div class="ach-footer">
              <div class="ach-reward">✦ ${a.nexals.toLocaleString()} Nexals</div>
              ${canClaim
                ? `<button class="ach-claim-btn" data-ach-id="${a.id}">Claim!</button>`
                : a.claimed
                  ? `<span class="ach-claimed-badge">✓ Claimed</span>`
                  : ''}
            </div>
          </div>`;
      });
      html += `</div></div>`;
    });
    grid.innerHTML = html;

    grid.querySelectorAll('.ach-claim-btn[data-ach-id]').forEach(btn => {
      btn.addEventListener('click', () => claimAchievement(btn.dataset.achId));
    });
  }

  window.claimAchievement = async function(achId) {
    const btn = document.querySelector('.ach-claim-btn[onclick*="' + achId + '"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Claiming…'; }
    const r = await api('POST', '/api/achievements/claim/' + achId);
    if (r.error) {
      toast(r.error, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Claim!'; }
      return;
    }
    toast('+' + r.earned.toLocaleString() + ' Nexals! 🎉', 'success', 4000);
    updateNexalDisplay(r.nexals);
    if (achData) achData.nexals = r.nexals;
    await loadAchievements();
  };

  // ---- Colors Shop ----
  async function loadCollectionStats() {
    const data = await api('GET', '/api/shop/stats');
    if (data.error) return toast(data.error, 'error');
    const count = $('stats-nexal-count'); if (count) count.textContent = data.nexals.toLocaleString();
    const rarities = Object.entries(data.rarityBreakdown || {}).map(([rarity, amount]) => `<div class="stat-rarity"><span>${esc(rarity)}</span><b>${amount}</b></div>`).join('');
    $('stats-content').innerHTML = `<div class="stats-hero"><div><span>COLLECTION VALUE</span><strong>${data.sellableValue.toLocaleString()} Nexals</strong><p>Resale value from your pack-only decorations.</p></div><button class="shop-card-btn buy" onclick="sellAllDecorations()" ${data.sellableValue ? '' : 'disabled'}>Sell All</button></div><div class="stats-metrics"><div><b>${data.decorationCount}</b><span>Total copies</span></div><div><b>${data.uniqueDecorations}</b><span>Unique effects</span></div><div><b>${data.nexals.toLocaleString()}</b><span>Current Nexals</span></div></div><div class="stats-rarities">${rarities || '<span>No decorations yet</span>'}</div>`;
  }

  window.sellAllDecorations = async function() {
    if (!confirm('Sell every pack decoration in your collection? This cannot be undone.')) return;
    const result = await api('POST', '/api/shop/sell-all');
    if (result.error) return toast(result.error, 'error');
    updateNexalDisplay(result.nexals);
    toast('Sold collection for ' + result.soldValue.toLocaleString() + ' Nexals', 'success');
    await loadCollectionStats();
  };

  async function loadPro() {
    const data = await api('GET', '/api/perks');
    if (data.error) return toast(data.error, 'error');
    const count = $('pro-nexal-count'); if (count) count.textContent = data.nexals.toLocaleString();
    const status = data.pro.active ? 'Active until ' + new Date(data.pro.expiresAt * 1000).toLocaleDateString() : 'Inactive';
    $('pro-content').innerHTML = `<div class="pro-hero"><div><div class="pro-kicker">NEXUS PRO</div><h2>Make your profile unmistakable.</h2><p>${status}. Pro is ${data.pro.price.toLocaleString()} Nexals for 30 days.</p></div><button class="shop-card-btn buy" onclick="subscribePro()">${data.pro.active ? 'Extend Pro' : 'Get Pro'}</button></div><div class="pro-benefits"><div><b>Custom banner</b><span>Choose the exact two-color gradient for your profile popup.</span></div><div><b>Name effects</b><span>Add a shimmer or prismatic sweep to your display name.</span></div><div><b>Premium popup</b><span>Your custom look appears wherever your profile is opened.</span></div></div>${data.pro.active ? `<div class="pro-customizer"><div class="pro-customizer-preview" id="pro-preview"><div class="pro-preview-avatar">N</div><b>${esc(currentUser.displayName || 'You')}</b><span>@${esc(currentUser.username || '')}</span></div><div class="pro-customizer-controls"><label>Banner start <input type="color" id="pro-gradient-start" value="#5865f2"></label><label>Banner end <input type="color" id="pro-gradient-end" value="#a855f7"></label><label>Name effect <select id="pro-name-effect"><option value="none">Clean gradient</option><option value="shimmer">Shimmer</option><option value="prism">Prism sweep</option></select></label><button class="shop-card-btn buy" onclick="saveProCustomization()">Save Popup Look</button></div></div>` : ''}`;
    return;
    $('pro-content').innerHTML = `<div class="shop-card" style="max-width:620px"><div class="shop-card-name">Nexus Pro</div><div class="shop-card-desc">${status}. Pro unlocks profile card themes and premium profile styling.</div><div class="shop-card-price">${data.pro.price.toLocaleString()} Nexals / 30 days</div><button class="shop-card-btn buy" onclick="subscribePro()">${data.pro.active ? 'Extend Pro' : 'Get Pro'}</button>${data.pro.active ? `<div style="display:flex;gap:8px;margin-top:10px"><button class="shop-card-btn" onclick="setProStyle('aurora')">Aurora</button><button class="shop-card-btn" onclick="setProStyle('ember')">Ember</button><button class="shop-card-btn" onclick="setProStyle('glacier')">Glacier</button></div>` : ''}</div><div class="shop-subsection"><h2>Server Boosts</h2><p>One boost is 10,000 Nexals for 30 days. Two active boosts unlock a server tag and animated gradient role colors.</p></div><div class="shop-grid">${data.servers.map(s => `<div class="shop-card"><div class="shop-card-name">${esc(s.name)}</div><div class="shop-card-desc">${s.boostCount} active boosts${s.tag ? ' | Tag: ' + esc(s.tag) : ''}</div>${s.tagUnlocked ? `<div style="display:flex;gap:6px;margin:8px 0"><input id="tag-${s.id}" maxlength="4" value="${esc(s.tag || '')}" style="width:68px;text-transform:uppercase"><button class="shop-card-btn" onclick="setServerTag('${s.id}')">Set Tag</button></div>` : ''}<button class="shop-card-btn buy" onclick="boostServer('${s.id}')">Boost for ${data.boostPrice.toLocaleString()}</button></div>`).join('')}</div>`;
  }

  window.subscribePro = async function() { const r = await api('POST', '/api/perks/pro/subscribe'); if (r.error) return toast(r.error, 'error'); updateNexalDisplay(r.nexals); toast('Pro activated', 'success'); await loadPro(); };
  window.setProStyle = async function(style) { const r = await api('POST', '/api/perks/profile-style', { style }); if (r.error) return toast(r.error, 'error'); const card = document.querySelector('.user-card'); if (card) { card.classList.remove('pro-aurora','pro-ember','pro-glacier'); card.classList.add('pro-' + style); } toast('Profile style updated', 'success'); };
  window.saveProCustomization = async function() { const start = $('pro-gradient-start').value, end = $('pro-gradient-end').value, nameEffect = $('pro-name-effect').value; const r = await api('PATCH', '/api/perks/profile-customize', { gradientStart:start, gradientEnd:end, nameEffect }); if (r.error) return toast(r.error, 'error'); const preview = $('pro-preview'); if (preview) { preview.style.setProperty('--pro-start', start); preview.style.setProperty('--pro-end', end); } toast('Profile popup customized', 'success'); };
  window.boostServer = async function(serverId) { const r = await api('POST', '/api/perks/servers/' + serverId + '/boost'); if (r.error) return toast(r.error, 'error'); updateNexalDisplay(r.nexals); toast('Server boosted', 'success'); await loadPro(); };
  window.setServerTag = async function(serverId) { const input = $('tag-' + serverId); const r = await api('PATCH', '/api/perks/servers/' + serverId + '/tag', { tag: input ? input.value : '' }); if (r.error) return toast(r.error, 'error'); toast('Server tag updated', 'success'); await loadPro(); };

  let colorsData = null;
  let fontsData = null;

  async function loadColors() {
    const [r, fr] = await Promise.all([api('GET', '/api/colors'), api('GET', '/api/colors/fonts')]);
    if (!r.error) {
      colorsData = r;
      updateNexalDisplay(r.nexals || 0);
      const nc = $('colors-nexal-count');
      if (nc) nc.textContent = (r.nexals||0).toLocaleString();
      renderColors(r.colors, r.active, r.nexals);
    }
    if (!fr.error) {
      fontsData = fr;
      renderFonts(fr.fonts, fr.active, fr.nexals);
    }
  }

  function previewColorHtml(color) {
    if (color.preview === 'rainbow') return `<span class="color-preview-text msg-color-rainbow">Aa</span>`;
    if (color.preview === 'fire')    return `<span class="color-preview-text msg-color-fire">Aa</span>`;
    if (color.preview === 'galaxy')  return `<span class="color-preview-text msg-color-galaxy">Aa</span>`;
    return `<span class="color-preview-text" style="color:${color.preview}">Aa</span>`;
  }

  function renderColors(colors, active, nexals) {
    const grid = $('colors-grid');
    if (!grid) return;
    grid.innerHTML = colors.map(c => {
      const isEquipped = active === c.id;
      const isOwned    = c.owned;
      const myNexals   = nexals || 0;
      const canBuy     = !isOwned && myNexals >= c.price;
      let btnClass = 'locked', btnText = '🔒 ' + c.price.toLocaleString();
      if (isEquipped)  { btnClass = 'unequip'; btnText = '✓ Equipped'; }
      else if (isOwned){ btnClass = 'equip';   btnText = 'Equip'; }
      else if (canBuy) { btnClass = 'buy';     btnText = 'Buy'; }
      return `<div class="color-card ${isOwned?'owned':''} ${isEquipped?'equipped':''}" id="colorcard-${c.id}">
        ${previewColorHtml(c)}
        <div class="color-card-name">${esc(c.name)}</div>
        <div class="color-card-price">${c.price.toLocaleString()} Nexals</div>
        <button class="color-card-btn ${btnClass}" onclick="colorAction('${c.id}','${isEquipped?'unequip':isOwned?'equip':canBuy?'buy':'locked'}')">${btnText}</button>
      </div>`;
    }).join('');
  }

  function renderFonts(fonts, active, nexals) {
    const grid = $('fonts-grid');
    if (!grid) return;
    const myNexals = nexals || 0;
    const previewStyles = {
      bubble: "font-family:'DynaPuff',cursive;",
      vt323: "font-family:'VT323',cursive;letter-spacing:0.6px;"
    };
    grid.innerHTML = fonts.map(f => {
      const isEquipped = active === f.id;
      const isOwned = f.owned;
      const canBuy = !isOwned && myNexals >= f.price;
      let btnClass = 'locked', btnText = '🔒 ' + f.price.toLocaleString();
      if (isEquipped)  { btnClass = 'unequip'; btnText = '✓ Equipped'; }
      else if (isOwned){ btnClass = 'equip';   btnText = 'Equip'; }
      else if (canBuy) { btnClass = 'buy';     btnText = 'Buy'; }
      return `<div class="font-card ${isOwned?'owned':''} ${isEquipped?'equipped':''}">
        <div class="font-preview-text" style="${previewStyles[f.id] || ''}">Aa Bb</div>
        <div class="color-card-name">${esc(f.name)}</div>
        <div class="color-card-price">${f.price.toLocaleString()} Nexals</div>
        <button class="color-card-btn ${btnClass}" onclick="fontAction('${f.id}','${isEquipped?'unequip':isOwned?'equip':canBuy?'buy':'locked'}')">${btnText}</button>
      </div>`;
    }).join('');
  }

  window.fontAction = async function(fontId, action) {
    if (action === 'locked') { toast('Not enough Nexals', 'info'); return; }
    if (action === 'buy') {
      const f = fontsData && fontsData.fonts && fontsData.fonts.find(x => x.id === fontId);
      const fontName = f ? f.name : fontId;
      const fontPrice = f ? f.price.toLocaleString() : '?';
      if (!confirm('Buy ' + fontName + ' font for ' + fontPrice + ' Nexals?')) return;
      const r = await api('POST', '/api/colors/fonts/buy', { fontId });
      if (r.error) return toast(r.error, 'error');
      currentUser.activeFont = fontId;
      updateNexalDisplay(r.nexals);
      toast(fontName + ' font unlocked! 🔤', 'success');
      await loadColors();
      return;
    }
    const equipId = action === 'equip' ? fontId : null;
    const r = await api('POST', '/api/colors/fonts/equip', { fontId: equipId });
    if (r.error) return toast(r.error, 'error');
    currentUser.activeFont = equipId;
    toast(action === 'equip' ? 'Font equipped! 🔤' : 'Font removed', 'success');
    await loadColors();
  };

  window.colorAction = async function(colorId, action) {
    if (action === 'locked') {
      const c = colorsData && colorsData.colors.find(x=>x.id===colorId);
      toast('Need ' + (c?c.price.toLocaleString():'?') + ' Nexals to unlock', 'info');
      return;
    }
    if (action === 'buy') {
      const c = colorsData && colorsData.colors.find(x=>x.id===colorId);
      if (!confirm('Buy "' + (c?c.name:colorId) + '" for ' + (c?c.price.toLocaleString():'?') + ' Nexals?')) return;
      const r = await api('POST', '/api/colors/buy', { colorId });
      if (r.error) return toast(r.error, 'error');
      colorsData.nexals = r.nexals;
      updateNexalDisplay(r.nexals);
      toast('Unlocked ' + (c?c.name:colorId) + '! 🎨', 'success');
      await loadColors();
      return;
    }
    const equipId = action === 'equip' ? colorId : null;
    const r = await api('POST', '/api/colors/equip', { colorId: equipId });
    if (r.error) return toast(r.error, 'error');
    currentUser.activeColor = equipId;
    if (colorsData) { colorsData.active = equipId; renderColors(colorsData.colors, equipId, colorsData.nexals); }
    toast(action==='equip' ? 'Color equipped! 🎨' : 'Color removed', 'success');
  };

  window.unclaimDeco = async function(decoId, name) {
    if (!confirm('Remove "' + name + '" from your collection? You will need the code to reclaim it.')) return;
    const r = await api('DELETE', '/api/shop/unclaim/' + decoId);
    if (r.error) return toast(r.error, 'error');
    if (currentUser.activeDecoration === decoId) {
      currentUser.activeDecoration = null;
      updateSelfCard();
    }
    toast('Removed "' + name + '" from your collection', 'info');
    await loadShop();
  };

  $('shop-code-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('shop-redeem-btn').click();
  });

  async function claimSecretDecoration(payload = {}) {
    if (secretClaimRunning) {
      return { error: 'A secret claim sequence is already running' };
    }
    const body = {};
    if (payload.secretId) body.secretId = payload.secretId;
    if (payload.passphrase) body.passphrase = payload.passphrase;

    const r = await api('POST', '/api/shop/claim-secret', body);
    if (r.error) {
      toast(r.error, 'error');
      return r;
    }

    secretClaimRunning = true;
    try {
      await showSecretClaimAnimation(r.decoration || {
        id: SECRET_DECORATION_ID,
        name: 'The Stormveil',
        rarity: '??SECRET??',
        flavorText: "It doesn't rain here. It hunts."
      });
    } finally {
      secretClaimRunning = false;
    }

    currentUser.activeDecoration = r.active || SECRET_DECORATION_ID;
    updateSelfCard();
    syncSecretAmbient();
    await loadShop();
    toast(r.alreadyOwned ? 'Secret rekindled.' : 'Secret decoration claimed.', 'success', 4500);
    return r;
  }

  window.claimSecret = async function(secretId) {
    const target = String(secretId || '').trim() || SECRET_DECORATION_ID;
    if (target !== SECRET_DECORATION_ID) {
      const err = 'Unknown secret id. Try claimSecret("stormveil")';
      console.warn(err);
      return { error: err };
    }
    console.info('Claim sequence started...');
    return claimSecretDecoration({ secretId: target });
  };

  window.unlock = async function(passphrase) {
    const code = String(passphrase || '').trim().toLowerCase();
    if (code !== SECRET_UNLOCK_PASSPHRASE) {
      const err = 'Invalid passphrase';
      console.warn(err);
      return { error: err };
    }
    console.info('Passphrase accepted. Secret sequence started...');
    return claimSecretDecoration({ passphrase: code });
  };

  window.heheshuis = async function(passphrase) {
    const code = String(passphrase || '').trim().toLowerCase();
    if (code !== HEHESHUIS_PASSPHRASE) {
      const err = 'Invalid passphrase';
      console.warn(err);
      return { error: err };
    }
    console.info('Heheshuis sequence started...');
    return claimSecretDecoration({ secretId: HEHESHUIS_SECRET_ID, passphrase: code });
  };

  // ---- Mythical Claim Animation ----
  function showClaimAnimation(decoration) {
    return new Promise(resolve => {
      const overlay = $('claim-overlay');
      const canvas = $('claim-canvas');
      const ctx = canvas.getContext('2d');
      const wrap = $('claim-avatar-wrap');

      // Set canvas size
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;

      // Set text
      $('claim-name').textContent = decoration.name;
      $('claim-desc').textContent = decoration.description;
      $('claim-stamp').style.opacity = '0';
      $('claim-dismiss').style.opacity = '0';

      // Apply decoration to preview avatar
      applyDecorationToWrap(wrap, decoration.id);
      if (decoration.id === 'nexus_admin') {
        const crown = document.createElement('span');
        crown.className = 'admin-crown';
        crown.textContent = '\u{1F451}';
        wrap.appendChild(crown);
      }
      if (decoration.id === 'storm') {
        setTimeout(() => startStormCanvas(wrap), 100);
      }

      // Particle system
      const particles = [];
      function spawnParticles() {
        const cx = canvas.width / 2, cy = canvas.height / 2;
        for (let i = 0; i < 6; i++) {
          const angle = Math.random() * Math.PI * 2;
          const speed = 2 + Math.random() * 5;
          const isStar = Math.random() < 0.3;
          particles.push({
            x: cx + (Math.random()-0.5)*100,
            y: cy + (Math.random()-0.5)*100,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed - 1,
            life: 1,
            decay: 0.008 + Math.random() * 0.015,
            size: isStar ? 3 + Math.random()*4 : 1.5 + Math.random()*2.5,
            color: Math.random() < 0.6
              ? `hsl(${45+Math.random()*20},100%,${60+Math.random()*30}%)`  // gold
              : `hsl(${270+Math.random()*40},100%,${60+Math.random()*30}%)`, // purple
            star: isStar
          });
        }
      }

      let spawnInterval = setInterval(spawnParticles, 40);
      let animId;
      let startTime = null;

      function drawFrame(ts) {
        if (!startTime) startTime = ts;
        const elapsed = (ts - startTime) / 1000;

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Background radial glow
        const glowAlpha = Math.min(elapsed / 0.5, 1) * 0.4;
        const grd = ctx.createRadialGradient(
          canvas.width/2, canvas.height/2, 0,
          canvas.width/2, canvas.height/2, 300
        );
        grd.addColorStop(0, `rgba(255,200,50,${glowAlpha * 0.3})`);
        grd.addColorStop(0.4, `rgba(180,80,255,${glowAlpha * 0.2})`);
        grd.addColorStop(1, 'transparent');
        ctx.fillStyle = grd;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Update and draw particles
        for (let i = particles.length-1; i >= 0; i--) {
          const p = particles[i];
          p.x += p.vx;
          p.y += p.vy;
          p.vy += 0.05; // gravity
          p.life -= p.decay;
          if (p.life <= 0) { particles.splice(i,1); continue; }

          ctx.save();
          ctx.globalAlpha = p.life;
          if (p.star) {
            // Draw a 4-point star
            ctx.fillStyle = p.color;
            ctx.shadowColor = p.color;
            ctx.shadowBlur = 8;
            ctx.translate(p.x, p.y);
            ctx.beginPath();
            for (let j = 0; j < 8; j++) {
              const r = j % 2 === 0 ? p.size : p.size * 0.4;
              const a = (j * Math.PI) / 4;
              j === 0 ? ctx.moveTo(Math.cos(a)*r, Math.sin(a)*r) : ctx.lineTo(Math.cos(a)*r, Math.sin(a)*r);
            }
            ctx.closePath();
            ctx.fill();
          } else {
            ctx.fillStyle = p.color;
            ctx.shadowColor = p.color;
            ctx.shadowBlur = 6;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI*2);
            ctx.fill();
          }
          ctx.restore();
        }

        // Slow down spawning after 2s
        if (elapsed > 2 && spawnInterval) {
          clearInterval(spawnInterval);
          spawnInterval = null;
          spawnInterval = setInterval(spawnParticles, 200);
        }

        animId = requestAnimationFrame(drawFrame);
      }

      animId = requestAnimationFrame(drawFrame);
      overlay.style.display = 'flex';

      // Dismiss handler
      function dismiss() {
        overlay.removeEventListener('click', dismiss);
        clearInterval(spawnInterval);
        cancelAnimationFrame(animId);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        overlay.style.display = 'none';
        if (decoration.id === 'storm') stopStormCanvas(wrap);
        wrap.querySelectorAll('.avatar-deco,.premium-deco,.admin-crown,.storm-canvas').forEach(e => e.remove());
        resolve();
      }

      // Allow dismiss after 2.5s
      setTimeout(() => overlay.addEventListener('click', dismiss), 2500);
    });
  }

  function syncSecretAmbient() {
    const shouldPlay = !!(currentUser && currentUser.activeDecoration === SECRET_DECORATION_ID);
    if (shouldPlay) startSecretHum();
    else stopSecretHum();
  }

  function startSecretHum() {
    if (secretHumCtx) return;
    try {
      secretHumCtx = new (window.AudioContext || window.webkitAudioContext)();
      const master = secretHumCtx.createGain();
      master.gain.value = 0.018;
      master.connect(secretHumCtx.destination);

      const base = secretHumCtx.createOscillator();
      base.type = 'sine';
      base.frequency.value = 82.4;

      const shimmer = secretHumCtx.createOscillator();
      shimmer.type = 'triangle';
      shimmer.frequency.value = 164.8;

      const shimmerGain = secretHumCtx.createGain();
      shimmerGain.gain.value = 0.18;

      const lfo = secretHumCtx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.085;
      const lfoGain = secretHumCtx.createGain();
      lfoGain.gain.value = 17;
      lfo.connect(lfoGain);
      lfoGain.connect(base.frequency);

      base.connect(master);
      shimmer.connect(shimmerGain);
      shimmerGain.connect(master);

      base.start();
      shimmer.start();
      lfo.start();
      secretHumNodes = [base, shimmer, lfo, shimmerGain, lfoGain, master];
    } catch (_) {
      stopSecretHum();
    }
  }

  function stopSecretHum() {
    secretHumNodes.forEach(n => {
      try {
        if (n && typeof n.stop === 'function') n.stop();
      } catch (_) {}
      try {
        if (n && typeof n.disconnect === 'function') n.disconnect();
      } catch (_) {}
    });
    secretHumNodes = [];
    if (secretHumCtx) {
      try { secretHumCtx.close(); } catch (_) {}
      secretHumCtx = null;
    }
  }

  function showSecretClaimAnimation(decoration) {
    return new Promise(resolve => {
      const overlay = $('secret-claim-overlay');
      const canvas = $('secret-claim-canvas');
      const card = $('secret-card');
      const stageLight = $('secret-stage-light');
      const silhouette = $('secret-lantern-silhouette');
      const constellation = $('secret-constellation');
      const glyphs = $('secret-glyphs');
      const wrap = $('secret-avatar-wrap');
      const nameEl = $('secret-name');
      const descEl = $('secret-desc');
      const rarityEl = $('secret-rarity-badge');
      const ctx = canvas.getContext('2d');

      const totalMs = 20000;
      const steps = [
        { cls: 'stage-blackout', ms: 2000 },
        { cls: 'stage-sky', ms: 3000 },
        { cls: 'stage-descent', ms: 3000 },
        { cls: 'stage-silhouette', ms: 2000 },
        { cls: 'stage-strike', ms: 3000 },
        { cls: 'stage-reveal', ms: 3000 },
        { cls: 'stage-engulf', ms: 3000 },
        { cls: 'stage-finalflash', ms: 1000 }
      ];

      let disposed = false;
      let raf = null;
      let phaseStart = performance.now();
      let currentPhase = 'stage-blackout';
      let phaseFxDone = false;

      const rain = [];
      for (let i = 0; i < 220; i++) {
        rain.push({
          x: Math.random() * (window.innerWidth || 1200),
          y: Math.random() * (window.innerHeight || 700),
          len: 8 + Math.random() * 22,
          speed: 4 + Math.random() * 10,
          drift: 1.6 + Math.random() * 2.2,
          alpha: 0.14 + Math.random() * 0.26
        });
      }

      function thunder(hit = false) {
        try {
          const ac = new (window.AudioContext || window.webkitAudioContext)();
          const osc = ac.createOscillator();
          const gain = ac.createGain();
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(hit ? 76 : 58, ac.currentTime);
          osc.frequency.exponentialRampToValueAtTime(hit ? 36 : 30, ac.currentTime + (hit ? 0.95 : 1.4));
          gain.gain.setValueAtTime(0.0001, ac.currentTime);
          gain.gain.exponentialRampToValueAtTime(hit ? 0.2 : 0.11, ac.currentTime + 0.05);
          gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + (hit ? 1.3 : 1.9));
          osc.connect(gain);
          gain.connect(ac.destination);
          osc.start();
          osc.stop(ac.currentTime + (hit ? 1.4 : 2.0));
          setTimeout(() => { try { ac.close(); } catch (_) {} }, hit ? 1800 : 2300);
        } catch (_) {}
      }

      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      overlay.style.display = 'flex';
      overlay.classList.remove('stage-blackout', 'stage-sky', 'stage-descent', 'stage-silhouette', 'stage-strike', 'stage-reveal', 'stage-engulf', 'stage-finalflash', 'stage-card');
      overlay.classList.add('stage-blackout');
      card.style.opacity = '0';
      card.style.transform = 'translateY(22px) scale(0.93)';

      if (nameEl) nameEl.textContent = decoration && decoration.name ? decoration.name : 'The Stormveil';
      if (descEl) descEl.textContent = decoration && (decoration.flavorText || decoration.description)
        ? (decoration.flavorText || decoration.description)
        : "It doesn't rain here. It hunts.";
      if (rarityEl) rarityEl.textContent = decoration && decoration.rarity ? decoration.rarity : '??SECRET??';

      const secretPreviewId = decoration && decoration.id ? decoration.id : SECRET_DECORATION_ID;

      applyDecorationToWrap(wrap, secretPreviewId);

      const particles = [];
      function spawnBurst(amount, hueStart = 210, hueRange = 60, spread = 3.8) {
        const cx = canvas.width / 2;
        const cy = canvas.height * 0.56;
        for (let i = 0; i < amount; i++) {
          const a = Math.random() * Math.PI * 2;
          const speed = 0.8 + Math.random() * spread;
          particles.push({
            x: cx,
            y: cy,
            vx: Math.cos(a) * speed,
            vy: Math.sin(a) * speed,
            life: 1,
            decay: 0.006 + Math.random() * 0.018,
            size: 1 + Math.random() * 3.5,
            hue: hueStart + Math.random() * hueRange
          });
        }
      }

      thunder(false);

      function draw(now) {
        if (disposed) return;
        const t = now - phaseStart;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const inStorm = currentPhase !== 'stage-blackout' && currentPhase !== 'stage-finalflash';
        if (inStorm) {
          const sky = ctx.createLinearGradient(0, 0, 0, canvas.height);
          sky.addColorStop(0, 'rgba(14,21,33,0.96)');
          sky.addColorStop(0.45, 'rgba(24,34,48,0.94)');
          sky.addColorStop(1, 'rgba(17,21,30,0.98)');
          ctx.fillStyle = sky;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }

        if (currentPhase === 'stage-sky' || currentPhase === 'stage-descent' || currentPhase === 'stage-engulf') {
          ctx.save();
          ctx.globalAlpha = currentPhase === 'stage-engulf' ? 0.9 : 0.55;
          const cloudWobble = Math.sin(now * 0.0012) * 18;
          const cloud = ctx.createRadialGradient(canvas.width * 0.42 + cloudWobble, canvas.height * 0.25, 20, canvas.width * 0.5, canvas.height * 0.36, canvas.width * 0.54);
          cloud.addColorStop(0, 'rgba(78,96,120,0.40)');
          cloud.addColorStop(0.55, 'rgba(45,58,74,0.45)');
          cloud.addColorStop(1, 'rgba(10,14,22,0.0)');
          ctx.fillStyle = cloud;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.restore();
        }

        if (inStorm) {
          const heavyRain = currentPhase === 'stage-descent' || currentPhase === 'stage-strike' || currentPhase === 'stage-engulf';
          for (const drop of rain) {
            drop.y += drop.speed * (heavyRain ? 1.7 : 1);
            drop.x -= drop.drift * (heavyRain ? 1.35 : 1);
            if (drop.y > canvas.height + 30) {
              drop.y = -20;
              drop.x = Math.random() * canvas.width;
            }
            if (drop.x < -40) drop.x = canvas.width + 20;
            ctx.strokeStyle = 'rgba(196,220,255,' + (drop.alpha + (heavyRain ? 0.18 : 0)) + ')';
            ctx.lineWidth = heavyRain ? 1.2 : 0.9;
            ctx.beginPath();
            ctx.moveTo(drop.x, drop.y);
            ctx.lineTo(drop.x - 6, drop.y + drop.len);
            ctx.stroke();
          }
        }

        if (currentPhase === 'stage-silhouette') {
          ctx.save();
          ctx.globalAlpha = 0.62;
          ctx.fillStyle = 'rgba(9, 12, 18, 0.82)';
          ctx.beginPath();
          ctx.ellipse(canvas.width * 0.5, canvas.height * 0.63, 110, 126, 0, 0, Math.PI * 2);
          ctx.fill();
          if (Math.sin(now * 0.010) > 0.92) {
            ctx.globalAlpha = 0.7;
            ctx.fillStyle = 'rgba(237,248,255,0.34)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
          }
          ctx.restore();
        }

        if (currentPhase === 'stage-strike' && !phaseFxDone) {
          spawnBurst(52, 188, 85, 5.0);
          thunder(true);
          phaseFxDone = true;
        }
        if ((currentPhase === 'stage-reveal' || currentPhase === 'stage-engulf') && Math.random() < 0.22) {
          spawnBurst(4, 195, 95, 3.8);
        }

        if (currentPhase === 'stage-strike') {
          ctx.save();
          ctx.globalAlpha = Math.max(0.15, 1 - (t / 1200));
          ctx.fillStyle = 'rgba(239,248,255,0.95)';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.restore();
        }

        if (currentPhase === 'stage-reveal') {
          const spin = (t / 3000) * Math.PI * 2;
          ctx.save();
          ctx.translate(canvas.width * 0.5, canvas.height * 0.58);
          ctx.rotate(spin * 0.08);
          ctx.strokeStyle = 'rgba(169,212,255,0.75)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(0, 0, 92, 0, Math.PI * 2);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(0, 0, 58, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }

        for (let i = particles.length - 1; i >= 0; i--) {
          const p = particles[i];
          p.x += p.vx;
          p.y += p.vy;
          p.vy += 0.008;
          p.life -= p.decay;
          if (p.life <= 0) {
            particles.splice(i, 1);
            continue;
          }
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
          ctx.fillStyle = 'hsla(' + p.hue + ',95%,70%,' + (p.life * 0.9) + ')';
          ctx.shadowColor = 'hsla(' + p.hue + ',100%,70%,0.9)';
          ctx.shadowBlur = 9;
          ctx.fill();
        }

        raf = requestAnimationFrame(draw);
      }

      raf = requestAnimationFrame(draw);

      function setPhase(cls) {
        currentPhase = cls;
        phaseStart = performance.now();
        phaseFxDone = false;
        overlay.classList.remove('stage-blackout', 'stage-sky', 'stage-descent', 'stage-silhouette', 'stage-strike', 'stage-reveal', 'stage-engulf', 'stage-finalflash', 'stage-card');
        overlay.classList.add(cls);
        if (cls === 'stage-blackout') {
          stageLight.style.opacity = '0';
          silhouette.style.opacity = '0';
          constellation.style.opacity = '0';
          glyphs.style.opacity = '0';
        } else if (cls === 'stage-sky' || cls === 'stage-descent') {
          stageLight.style.opacity = '0.3';
          silhouette.style.opacity = '0';
          constellation.style.opacity = '0.15';
          glyphs.style.opacity = '0';
        } else if (cls === 'stage-silhouette') {
          stageLight.style.opacity = '0.42';
          silhouette.style.opacity = '0.74';
          constellation.style.opacity = '0.2';
          glyphs.style.opacity = '0.08';
        } else if (cls === 'stage-strike' || cls === 'stage-reveal') {
          stageLight.style.opacity = '0.85';
          silhouette.style.opacity = '0.55';
          constellation.style.opacity = '0.45';
          glyphs.style.opacity = '0.5';
        } else if (cls === 'stage-engulf') {
          stageLight.style.opacity = '1';
          silhouette.style.opacity = '0.3';
          constellation.style.opacity = '0.72';
          glyphs.style.opacity = '0.58';
        } else if (cls === 'stage-finalflash') {
          stageLight.style.opacity = '1';
          silhouette.style.opacity = '0';
          constellation.style.opacity = '0';
          glyphs.style.opacity = '0';
        }
      }

      function wait(ms) {
        return new Promise(r => setTimeout(r, ms));
      }

      async function runTimeline() {
        let elapsed = 0;
        for (const s of steps) {
          setPhase(s.cls);
          await wait(s.ms);
          elapsed += s.ms;
        }
        if (elapsed < totalMs) await wait(totalMs - elapsed);
        overlay.classList.add('stage-card');
        await wait(1900);
        overlay.addEventListener('click', dismiss, { once: true });
        setTimeout(dismiss, 5200);
      }

      function dismiss() {
        if (disposed) return;
        disposed = true;
        if (raf) cancelAnimationFrame(raf);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        overlay.style.display = 'none';
        overlay.classList.remove('stage-blackout', 'stage-sky', 'stage-descent', 'stage-silhouette', 'stage-strike', 'stage-reveal', 'stage-engulf', 'stage-finalflash', 'stage-card');
        wrap.querySelectorAll('.avatar-deco,.premium-deco,.admin-crown,.storm-canvas').forEach(e => e.remove());
        resolve();
      }

      runTimeline().catch(() => dismiss());
    });
  }

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
      popup.classList.toggle('pro-profile', !!r.pro);
      popup.classList.toggle('effect-shimmer', r.profileNameEffect === 'shimmer');
      popup.classList.toggle('effect-prism', r.profileNameEffect === 'prism');
      popup.style.setProperty('--profile-start', r.profileGradientStart || '#5865f2');
      popup.style.setProperty('--profile-end', r.profileGradientEnd || '#a855f7');
      const tag = $('popup-server-tag');
      if (r.serverTag && r.serverTag.tag) {
        tag.style.display = 'flex'; tag.style.setProperty('--tag-background', r.serverTag.background || '#5865f2');
        tag.innerHTML = `${r.serverTag.iconDataUrl ? `<img src="${r.serverTag.iconDataUrl}" alt="">` : ''}<span>${esc(r.serverTag.tag)} | ${esc(r.serverTag.name)}</span>`;
        const invite = $('popup-tag-invite');
        tag.onclick = () => { invite.style.display = invite.style.display === 'none' ? 'block' : 'none'; invite.innerHTML = `<strong>${esc(r.serverTag.name)}</strong><span>Server invite from ${esc(data.displayName)}</span><button type="button">Join Server</button>`; invite.querySelector('button').onclick = async () => { const joined = await api('POST', '/api/servers/join/' + r.serverTag.inviteCode); if (joined.error) return toast(joined.error, 'error'); toast('Joined server', 'success'); }; };
      } else { tag.style.display = 'none'; $('popup-tag-invite').style.display = 'none'; }
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
    $('channel-private-toggle').checked = !!r.private;
    $('perms-roles-section').style.display = (r.locked || r.private) ? 'block' : 'none';

    const roles = (activeServerData && activeServerData.roles) || [];
    // permMap: { roleId: { allowSend, allowView } }
    const permMap = {};
    (r.permissions || []).forEach(p => { permMap[p.roleId] = { allowSend: p.allowSend, allowView: p.allowView }; });

    $('perms-roles-list').innerHTML = roles.map(role => {
      const p = permMap[role.id] || {};
      const sendAllow = p.allowSend === true;
      const sendDeny = p.allowSend === false;
      const viewAllow = p.allowView === true;
      const viewDeny = p.allowView === false;
      return `
        <div class="perm-role-row" style="flex-direction:column;align-items:flex-start;gap:6px">
          <div style="display:flex;align-items:center;gap:8px;width:100%">
            <div class="perm-role-dot" style="background:${role.color}"></div>
            <span class="perm-role-name" style="color:${role.color}">${esc(role.name)}</span>
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding-left:20px">
            <span style="font-size:11px;color:var(--text-muted);min-width:40px">Send:</span>
            <button class="perm-allow-btn ${sendAllow?'active':''}" onclick="setChannelPerm('${role.id}',{allowSend:true},this)">✓</button>
            <button class="perm-deny-btn ${sendDeny?'active':''}" onclick="setChannelPerm('${role.id}',{allowSend:false},this)">✗</button>
            <span style="font-size:11px;color:var(--text-muted);min-width:40px;margin-left:8px">View:</span>
            <button class="perm-allow-btn ${viewAllow?'active':''}" onclick="setChannelPerm('${role.id}',{allowView:true},this)">✓</button>
            <button class="perm-deny-btn ${viewDeny?'active':''}" onclick="setChannelPerm('${role.id}',{allowView:false},this)">✗</button>
            ${Object.keys(p).length ? `<button class="action-btn ghost" style="font-size:11px;padding:3px 7px;margin-left:4px" onclick="removeChannelPerm('${role.id}',this)">Reset</button>` : ''}
          </div>
        </div>`;
    }).join('') || '<p style="font-size:13px;color:var(--text-muted)">No roles defined yet. Create roles in Server Settings first.</p>';

    $('channel-perms-modal').classList.add('active');
  };

  $('channel-locked-toggle').addEventListener('change', async function() {
    if (!permsChannelId) return;
    const r = await api('PATCH', `/api/servers/${activeServerId}/channels/${permsChannelId}/lock`, { locked: this.checked });
    if (r.error) { this.checked = !this.checked; return toast(r.error, 'error'); }
    $('perms-roles-section').style.display = this.checked ? 'block' : 'none';
    if (activeServerData) {
      const ch = activeServerData.channels.find(c => c.id === permsChannelId);
      if (ch) ch.locked = this.checked;
      const me = activeServerData.members.find(m => m.id === currentUser.id);
      renderChannelList(activeServerData.channels, me && (me.role === 'admin' || me.isAdmin));
    }
    toast(this.checked ? 'Channel locked' : 'Channel unlocked', 'success');
  });

  $('channel-private-toggle').addEventListener('change', async function() {
    if (!permsChannelId) return;
    const r = await api('PATCH', `/api/servers/${activeServerId}/channels/${permsChannelId}/private`, { private: this.checked });
    if (r.error) { this.checked = !this.checked; return toast(r.error, 'error'); }
    $('perms-roles-section').style.display = (this.checked || $('channel-locked-toggle').checked) ? 'block' : 'none';
    if (activeServerData) {
      const ch = activeServerData.channels.find(c => c.id === permsChannelId);
      if (ch) ch.private = this.checked;
      const me = activeServerData.members.find(m => m.id === currentUser.id);
      renderChannelList(activeServerData.channels, me && (me.role === 'admin' || me.isAdmin));
    }
    toast(this.checked ? 'Channel set to private' : 'Channel set to public', 'success');
  });

  window.setChannelPerm = async function(roleId, permObj, btn) {
    if (!permsChannelId) return;
    const r = await api('PUT', `/api/servers/${activeServerId}/channels/${permsChannelId}/permissions/${roleId}`, permObj);
    if (r.error) return toast(r.error, 'error');
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

  // ---- Delete Channel Message ----
  window.deleteChannelMessage = async function(msgId, channelId, btn) {
    if (!confirm('Delete this message?')) return;
    btn.disabled = true;
    const r = await api('DELETE', `/api/servers/${activeServerId}/channels/${channelId}/messages/${msgId}`);
    if (r.error) { toast(r.error, 'error'); btn.disabled = false; return; }
    // Notify server via socket so others see it removed too
    if (socket) socket.emit('channel_message_deleted', { serverId: activeServerId, channelId, messageId: msgId });
    removeMessageFromDOM(msgId);
  };

  function removeMessageFromDOM(msgId) {
    const el = document.querySelector(`[data-id="${msgId}"]`);
    if (el) el.remove();
  }

  // ---- Escape helper ----
  function esc(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---- Render message content with mentions ----
  function renderContent(rawContent, mentions, authorColor) {
    let html = esc(rawContent);
    if (!mentions) {
      return authorColor ? `<span class="msg-color-${authorColor}">${html}</span>` : html;
    }

    html = html.replace(/&lt;@user:([a-f0-9-]+)&gt;/g, (match, id) => {
      const u = mentions.users && mentions.users[id];
      const name = u ? u.displayName : 'Unknown';
      const isSelf = id === currentUser.id;
      return `<span class="mention-user${isSelf ? ' mention-self' : ''}" data-user-id="${id}">@${esc(name)}</span>`;
    });

    html = html.replace(/&lt;@role:([a-f0-9-]+)&gt;/g, (match, id) => {
      const r = mentions.roles && mentions.roles[id];
      const name = r ? r.name : 'Unknown Role';
      const color = r ? r.color : 'var(--accent)';
      return `<span class="mention-role" style="color:${color}" data-role-id="${id}">@${esc(name)}</span>`;
    });

    return authorColor ? `<span class="msg-color-${authorColor}">${html}</span>` : html;
  }

  // ---- Start ----
  init();
})();
