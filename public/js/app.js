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
        const old = oldWrap.querySelector('.avatar-deco');
        if (old) old.remove();
        delete oldWrap.dataset.deco;
        stopStormCanvas(oldWrap);
        stopInfernoCanvas(oldWrap);
        stopYinYangCanvas(oldWrap);
        stopHydroCanvas(oldWrap);
        oldWrap.querySelectorAll('.admin-crown,.deco-shine-overlay').forEach(e=>e.remove());
      }
      return;
    }

    // Find the wrap — either an existing .avatar-wrap, or the direct parent
    let wrap = el.parentElement;
    if (!wrap) return;

    // If parent isn't position:relative capable, make it so
    if (!wrap.classList.contains('avatar-wrap') && getComputedStyle(wrap).position === 'static') {
      wrap.style.position = 'relative';
    }

    // Remove stale deco
    const existing = wrap.querySelector('.avatar-deco');
    if (existing) existing.remove();

    // Inject deco as a sibling after the avatar
    const decoEl = document.createElement('div');
    decoEl.className = 'avatar-deco deco-' + deco;
    wrap.appendChild(decoEl);
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
    const size = avatarEl ? avatarEl.offsetWidth || 36 : 36;
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
    const size = avatarEl ? avatarEl.offsetWidth || 36 : 36;
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
    const size = avatarEl ? avatarEl.offsetWidth || 36 : 36;
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
    const size = avatarEl ? avatarEl.offsetWidth || 36 : 36;
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

  function showSuspensionScreen(errorMsg, until, reason) {
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
  // Hardcoded admin IDs — same as server side
  const ADMIN_IDS = new Set([
    '7db80df6-0566-4fa0-bbc2-6cde9775f3a4',
    '238a8575-224a-40cb-b699-eba0d9ff7384',
  ]);

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
      if (activeView === 'shop') loadShop();
      // Show admin button instantly if user is admin
      if (currentUser && ADMIN_IDS.has(currentUser.id)) {
        const btn = $('rail-admin-btn');
        if (btn) btn.style.display = 'flex';
      }
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
        <span class="ch-hash">${c.locked ? '🔒' : c.private ? '👁' : '#'}</span>
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
            ${r.canDeleteMessages ? '<span class="role-badge" style="background:rgba(240,84,84,0.15);color:var(--red)">Can Delete</span>' : ''}
            <div class="role-actions">
              <button class="role-edit-btn" onclick="editRole('${r.id}','${esc(r.name)}','${r.color}',${r.isAdmin},${!!r.canDeleteMessages})">Edit</button>
              <button class="role-del-btn" onclick="deleteRole('${r.id}','${esc(r.name)}')">Delete</button>
            </div>
          </div>`).join('')
      : '<p style="font-size:13px;color:var(--text-muted);padding:8px 0">No custom roles yet. Create one below.</p>';
  }

  window.editRole = async function(roleId, currentName, currentColor, currentIsAdmin, currentCanDelete) {
    const name = prompt('Role name:', currentName);
    if (!name || !name.trim()) return;
    const color = prompt('Color (hex, e.g. #ff5555):', currentColor);
    const isAdminChoice = confirm('Should this role have admin permissions?');
    const canDeleteChoice = confirm('Should this role be able to delete messages?');
    const r = await api('PATCH', `/api/servers/${activeServerId}/roles/${roleId}`, {
      name: name.trim(), color: color || currentColor, isAdmin: isAdminChoice, canDeleteMessages: canDeleteChoice
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
    if (view === 'shop') loadShop();
    if (view === 'achievements') loadAchievements();
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
      ? { id: currentUser.id, displayName: currentUser.displayName, username: currentUser.username, avatarDataUrl: currentUser.avatarDataUrl }
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

    el.innerHTML = `
      <div class="avatar-wrap" style="flex-shrink:0;align-self:flex-start;margin-top:2px"><div class="avatar" id="mav-${msg.id}"></div></div>
      <div class="msg-body">
        <div class="msg-header">
          <span class="${roleClass}" ${roleStyle} ${roleTip}>${esc(author.displayName)}</span>
          <span class="msg-time">${formatTime(msg.createdAt)}</span>
        </div>
        <div class="msg-content">${renderContent(msg.content, msg.mentions)}</div>
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

    socket.on('channel_message_deleted', ({ channelId, messageId }) => {
      if (channelId === activeChannelId) removeMessageFromDOM(messageId);
    });

    socket.on('channel_error', ({ channelId, error }) => {
      if (channelId === activeChannelId) toast(error, 'error');
    });

    socket.on('screenshare_started', ({ fromId }) => {
      // The ontrack handler deals with showing the video; this is just for notification
      const peer = callState && callState.peerUser;
      toast((peer ? peer.displayName : 'Peer') + ' started screen sharing', 'info');
    });

    socket.on('account_suspended', ({ suspendedUntil }) => {
      // Immediately show suspension screen and log out
      api('POST', '/api/auth/logout').then(() => {
        currentUser = null;
        if (socket) { socket.disconnect(); socket = null; }
        showSuspensionScreen(null, suspendedUntil, null);
      });
    });

    socket.on('mentioned', ({ type, serverId: sid, channelId: cid, fromUser, preview }) => {
      const serverName = servers.find(s => s.id === sid)?.name || 'a server';
      toast(`@mention from ${fromUser.displayName} in ${serverName}: ${preview}`, 'info', 6000);
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
    if (socket) socket.disconnect();
    currentUser = null; socket = null; friends = [];
    activeDmUserId = null; activeDmUser = null;
    endCallLocal();
    showScreen('auth-screen');
  });

  // ---- Admin Panel ----
  function checkAdminStatus() {
    if (currentUser && ADMIN_IDS.has(currentUser.id)) {
      const btn = $('rail-admin-btn');
      if (btn) btn.style.display = 'flex';
    }
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
    // Kick the user live if they're online
    if (socket) socket.emit('admin_suspend_user', { targetUserId: r.userId, suspendedUntil: r.suspendedUntil });
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

    result.innerHTML = `
      <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius-md);padding:16px;margin-top:4px">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
          <div style="font-size:28px;width:48px;height:48px;background:var(--bg-surface);border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;color:var(--accent)">${esc(data.displayName[0]||'?')}</div>
          <div>
            <div style="font-size:15px;font-weight:800">${esc(data.displayName)}</div>
            <div style="font-size:12px;color:var(--text-muted)">@${esc(data.username)} · ${suspText}</div>
          </div>
        </div>

        <div style="display:flex;gap:10px;align-items:flex-end;margin-bottom:16px">
          <div class="field-group" style="margin:0;flex:1">
            <label>Nexals Balance</label>
            <input type="number" id="admin-nexal-input" value="${data.nexals}" min="0" style="width:100%" />
          </div>
          <button class="btn-primary" style="padding:9px 16px;white-space:nowrap" onclick="adminSetNexals('${data.id}')">Update</button>
        </div>
        <div class="form-error" id="admin-nexal-error"></div>

        <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px">
          Servers (${data.servers.length})
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;max-height:200px;overflow-y:auto">
          ${data.servers.length ? data.servers.map(s => `
            <div style="display:flex;align-items:center;gap:10px;padding:7px 8px;background:var(--bg-surface);border-radius:6px">
              <div style="width:28px;height:28px;border-radius:50%;background:var(--bg-hover);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;flex-shrink:0;overflow:hidden">
                ${s.iconDataUrl ? `<img src="${s.iconDataUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">` : esc(s.name[0]||'?')}
              </div>
              <div style="flex:1;min-width:0">
                <div style="font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.name)}</div>
                <div style="font-size:10px;color:var(--text-muted)">${s.memberCount} members · ${s.role || 'member'}</div>
              </div>
            </div>`).join('') : '<div style="color:var(--text-muted);font-size:12px">Not in any servers</div>'}
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

  async function loadShop() {
    const r = await api('GET', '/api/shop');
    if (r.error) return;
    shopData = r;
    updateNexalDisplay(r.nexals || 0);
    renderShop(r.decorations, r.active);
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
    // Stop any existing storm canvases in the shop before re-rendering
    grid.querySelectorAll('.avatar-wrap').forEach(w => stopStormCanvas(w));

    grid.innerHTML = decorations.map(d => {
      const isEquipped = active === d.id;
      const isOwned = d.owned;
      const isMythical = d.rarity === 'mythical';

      // Mythical unowned: show mystery OR buyable card
      const myNexalsMythical = (shopData && shopData.nexals) || 0;
      const canAffordMythical = d.nexalPrice && myNexalsMythical >= d.nexalPrice;
      if (isMythical && !isOwned && !canAffordMythical) {
        const priceHint = d.nexalPrice ? d.nexalPrice.toLocaleString() + ' Nexals to unlock' : 'Exclusive code only';
        return `
          <div class="shop-card mystery" id="shopcard-${d.id}">
            <div class="mystery-preview">
              <div class="mystery-silhouette">✦</div>
            </div>
            <span class="shop-rarity rarity-mythical">MYTHICAL</span>
            <div class="shop-card-name mystery-name">? ? ?</div>
            <div class="mystery-hint">${d.nexalPrice ? `<span style="color:#ffd700;font-weight:700">${priceHint}</span>` : 'Redeem an exclusive code<br>to reveal this decoration'}</div>
          </div>`;
      }

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
            <div class="avatar-wrap" style="width:48px;height:48px;position:relative;overflow:visible;display:inline-flex;align-items:center;justify-content:center">
              <div class="avatar" style="width:48px;height:48px;font-size:18px;font-weight:800;flex-shrink:0">N</div>
              ${d.owned ? `<div class="avatar-deco deco-${d.id}"></div>` : ''}
            </div>
          </div>
          <span class="shop-rarity rarity-${d.rarity}">${d.rarity}</span>
          <div class="shop-card-name">${esc(d.name)}</div>
          <div class="shop-card-desc">${esc(d.description)}</div>
          ${(!isOwned && priceLabel) ? `<div class="shop-card-price">${priceLabel}</div>` : ''}
          <button class="shop-card-btn ${btnClass}" onclick="shopAction('${d.id}','${isEquipped ? 'unequip' : isOwned ? 'equip' : canBuy ? 'buy' : 'locked'}')">
            ${btnText}
          </button>
          ${isOwned ? `<button class="shop-card-btn" style="background:rgba(240,84,84,0.1);color:var(--red);font-size:11px;margin-top:2px" onclick="unclaimDeco('${d.id}','${esc(d.name)}')">Remove</button>` : ''}
        </div>`;
    }).join('');

    // Start canvas engines for owned canvas-based decos
    const canvasDecos = { storm: startStormCanvas, inferno: startInfernoCanvas, yinyang: startYinYangCanvas, hydro: startHydroCanvas };
    Object.entries(canvasDecos).forEach(([id, fn]) => {
      if (decorations.find(d => d.id === id && d.owned)) {
        const wrap = document.querySelector(`#shopcard-${id} .avatar-wrap`);
        if (wrap) setTimeout(() => fn(wrap), 50);
      }
    });
    // Shine overlays for owned legendaries
    ['diamond','goldshine'].forEach(id => {
      if (decorations.find(d => d.id === id && d.owned)) {
        const wrap = document.querySelector(`#shopcard-${id} .avatar-wrap`);
        if (wrap) {
          const shine = document.createElement('div');
          shine.className = `deco-shine-overlay deco-${id}-shine`;
          wrap.appendChild(shine);
        }
      }
    });
  }

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
    if (shopData) {
      shopData.active = equipId;
      renderShop(shopData.decorations, equipId);
    }
    toast(action === 'equip' ? 'Decoration equipped! ✨' : 'Decoration removed', 'success');
  };

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
      wrap.querySelectorAll('.avatar-deco,.admin-crown,.storm-canvas').forEach(e => e.remove());
      const decoEl = document.createElement('div');
      decoEl.className = 'avatar-deco deco-' + decoration.id;
      wrap.appendChild(decoEl);
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
        wrap.querySelectorAll('.avatar-deco,.admin-crown,.storm-canvas').forEach(e => e.remove());
        resolve();
      }

      // Allow dismiss after 2.5s
      setTimeout(() => overlay.addEventListener('click', dismiss), 2500);
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
  function renderContent(rawContent, mentions) {
    // First escape HTML
    let html = esc(rawContent);
    if (!mentions) return html;

    // Replace <@user:ID> tokens
    html = html.replace(/&lt;@user:([a-f0-9-]+)&gt;/g, (match, id) => {
      const u = mentions.users && mentions.users[id];
      const name = u ? u.displayName : 'Unknown';
      const isSelf = id === currentUser.id;
      return `<span class="mention-user${isSelf ? ' mention-self' : ''}" data-user-id="${id}">@${esc(name)}</span>`;
    });

    // Replace <@role:ID> tokens
    html = html.replace(/&lt;@role:([a-f0-9-]+)&gt;/g, (match, id) => {
      const r = mentions.roles && mentions.roles[id];
      const name = r ? r.name : 'Unknown Role';
      const color = r ? r.color : 'var(--accent)';
      return `<span class="mention-role" style="color:${color}" data-role-id="${id}">@${esc(name)}</span>`;
    });

    return html;
  }

  // ---- Start ----
  init();
})();
