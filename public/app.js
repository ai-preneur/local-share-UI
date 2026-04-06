// Local Share — app.js
// Extracted from index.html for maintainability and nonce-based CSP.
// Served with cache-busting query param from server.



  'use strict';

  // ── Config (set in public/config.js — edit that file, not this one) ────────
  const _cfg      = window.APP_CONFIG || {};
  const API_URL   = _cfg.BACKEND_URL || '';   // Render backend base URL
  const WS_URL    = API_URL
    ? API_URL.replace(/^http/, 'ws')           // https://x.onrender.com → wss://x.onrender.com
    : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

  // ── Globals ────────────────────────────────────────────────────────────────
  let ws, myId, myLocalIp = '', selectedDeviceId = 'all';
  let connectedDevices = {};
  let myDevice = { id: null, name: '', localIp: '' }; // own device info
  const pendingReceipts = new Map();
  const pendingReadQueue = [];

  // ── Session history ────────────────────────────────────────────────────────
  // Stored in sessionStorage (same tab/session only, cleared when tab closes).
  // Max 200 messages — oldest dropped automatically.
  const HISTORY_KEY  = 'localshare_history';
  const HISTORY_MAX  = 200;

  function loadHistory() {
    try { return JSON.parse(sessionStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
  }

  function saveToHistory(entry) {
    try {
      const hist = loadHistory();
      hist.push(entry);
      if (hist.length > HISTORY_MAX) hist.splice(0, hist.length - HISTORY_MAX);
      sessionStorage.setItem(HISTORY_KEY, JSON.stringify(hist));
    } catch {} // sessionStorage full — ignore silently
  }

  function renderHistory() {
    const hist = loadHistory();
    if (!hist.length) return;
    document.getElementById('empty-state')?.remove();
    const container = document.getElementById('messages');
    // Add a "session restored" separator
    const sep = document.createElement('div');
    sep.className = 'sys-msg';
    sep.innerHTML = '— session history —';
    container.appendChild(sep);
    hist.forEach(entry => addMessageDOM(entry.msg, entry.side, false));
  }

  // ── Theme ──────────────────────────────────────────────────────────────────
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.getElementById('theme-toggle').textContent = theme === 'dark' ? '🌙' : '☀️';
    localStorage.setItem('wifisend_theme', theme);
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'dark' ? 'light' : 'dark');
  }

  // Apply saved theme on load (default: dark)
  applyTheme(localStorage.getItem('wifisend_theme') || 'dark');

  // ── Random name ────────────────────────────────────────────────────────────
  const ADJ  = ['Swift','Crimson','Neon','Fuzzy','Silent','Quantum','Cosmic','Amber','Obsidian','Jade',
                 'Turbo','Misty','Lucky','Blazing','Frosty','Clever','Nimble','Rusty','Solar','Arctic',
                 'Dapper','Velvet','Copper','Onyx','Mossy','Peppy','Stormy','Golden','Cobalt','Sandy'];
  const NOUN = ['Falcon','Otter','Panda','Koala','Mango','Cactus','Comet','Badger','Lynx','Raven',
                 'Quasar','Bison','Iguana','Walrus','Cobra','Ferret','Gecko','Lemur','Moose','Toucan',
                 'Piranha','Narwhal','Platypus','Wombat','Axolotl','Dingo','Kestrel','Manatee','Ocelot','Tapir'];

  function randomName() {
    return `${ADJ[Math.random()*ADJ.length|0]} ${NOUN[Math.random()*NOUN.length|0]}`;
  }

  // ── UUID / name persistence ────────────────────────────────────────────────
  function getOrCreateUuid() {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    // Use sessionStorage so each browser TAB gets its own UUID.
    // This prevents multiple open tabs from terminating each other's connection.
    let uuid = sessionStorage.getItem('wifisend_tab_uuid');
    if (!uuid || !UUID_RE.test(uuid)) {
      uuid = crypto.randomUUID
        ? crypto.randomUUID()
        : ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g,c=>(c^crypto.getRandomValues(new Uint8Array(1))[0]&15>>c/4).toString(16));
      sessionStorage.setItem('wifisend_tab_uuid', uuid);
    }
    return uuid;
  }

  function getSavedName() { return localStorage.getItem('wifisend_name') || ''; }
  function saveName(n)    { localStorage.setItem('wifisend_name', n); }
  function newMsgId()     { return `${Date.now()}-${Math.random().toString(36).slice(2,8)}`; }

  const myUuid = getOrCreateUuid();

  // ── Security helpers ───────────────────────────────────────────────────────
  function esc(str) {
    return String(str)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  // Validates URL — only http/https allowed (fixes javascript: XSS)
  // validateUrl: returns the canonicalised URL string if safe, or null.
  // Separated from HTML escaping so the URL can be used in any context.
  function validateUrl(str) {
    try {
      const u = new URL(str);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
    } catch {}
    return null;
  }
  // safeUrl: for use in href= attributes inside innerHTML templates.
  // Returns the HTML-escaped URL, or '#' if invalid.
  function safeUrl(str) {
    const url = validateUrl(str);
    return url ? esc(url) : '#';
  }
  function isValidUrl(str) { return validateUrl(str) !== null; }

  // ── Toast ──────────────────────────────────────────────────────────────────
  let toastTimer;
  function showToast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg; el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }

  // ── WebRTC local IP ────────────────────────────────────────────────────────
  async function detectLocalIp() {
    return new Promise(resolve => {
      const ips = new Set();
      try {
        const pc = new RTCPeerConnection({ iceServers: [] });
        pc.createDataChannel('');
        pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => resolve(''));
        let done = false;
        const finish = () => { if(done) return; done=true; try{pc.close();}catch{} resolve([...ips].filter(ip=>!ip.startsWith('169.254'))[0]||''); };
        pc.onicecandidate = e => { if (!e?.candidate) { finish(); return; } const m = e.candidate.candidate.match(/(\d+\.\d+\.\d+\.\d+)/); if(m) ips.add(m[1]); };
        setTimeout(finish, 2000);
      } catch { resolve(''); }
    });
  }

  // ── Dropdown ───────────────────────────────────────────────────────────────
  function toggleDropdown() {
    const dd  = document.getElementById('device-dropdown');
    const btn = document.getElementById('recipient-btn');
    const ov  = document.getElementById('overlay');
    if (dd.classList.contains('open')) { closeDropdown(); return; }
    renderDropdown();
    dd.classList.add('open');
    btn.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    ov.classList.add('open');
  }

  function closeDropdown() {
    document.getElementById('device-dropdown').classList.remove('open');
    document.getElementById('recipient-btn').classList.remove('open');
    document.getElementById('recipient-btn').setAttribute('aria-expanded', 'false');
    document.getElementById('overlay').classList.remove('open');
  }

  // Ask the server for a fresh device list by re-sending our registration.
  // The server responds with a welcome containing the current device list.
  function refreshDevices() {
    const btn = document.getElementById('dd-refresh-btn');
    if (btn) btn.classList.add('spinning');
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'register',
        uuid: myUuid,
        name: document.getElementById('name-input').value,
        localIp: myLocalIp
      }));
      // Re-render after a short delay to show updated list
      setTimeout(() => {
        if (btn) btn.classList.remove('spinning');
        renderDropdown();
      }, 600);
    } else {
      if (btn) btn.classList.remove('spinning');
      showToast('Not connected — please wait.');
    }
  }

  function renderDropdown() {
    const dd      = document.getElementById('device-dropdown');
    const others  = Object.values(connectedDevices);

    const selfName = myDevice.name || document.getElementById('name-input').value || 'This Device';
    let html = `<div class="dd-section" class="dd-section-top">
      <div class="dd-label">Your Device</div>
      <div class="dd-item no-cursor">
        <div class="dd-avatar">🖥️</div>
        <div class="dd-info">
          <div class="dd-name">${esc(selfName)}</div>
          <div class="dd-sub">${myDevice.localIp ? esc(myDevice.localIp) : 'this browser'}</div>
        </div>
        <span class="you-badge">YOU</span>
      </div>
    </div>`;

    html += `<div class="dd-section">
      <div class="dd-label">Broadcast</div>
      <div class="dd-item ${selectedDeviceId==='all'?'selected':''}" data-select="all" role="option">
        <div class="dd-avatar">🌐</div>
        <div class="dd-info">
          <div class="dd-name">Everyone</div>
          <div class="dd-sub">${others.length ? `Send to ${others.length} other device${others.length!==1?'s':''}` : 'No other devices yet'}</div>
        </div>
      </div>
    </div>`;

    if (others.length > 0) {
      html += `<div class="dd-section"><div class="dd-label">Nearby Devices</div>`;
      others.forEach(d => {
        const isSelected = selectedDeviceId === d.id;
        html += `<div class="dd-item ${isSelected?'selected-purple':''}" data-select="${d.id}" role="option" tabindex="0">
          <div class="dd-avatar">📱</div>
          <div class="dd-info">
            <div class="dd-name">${esc(d.name)}</div>
            <div class="dd-sub">${d.localIp ? esc(d.localIp) : 'IP unknown'}</div>
          </div>
        </div>`;
      });
      html += `</div>`;
    }

    html += `<button class="dd-refresh-btn" id="dd-refresh-btn" aria-label="Refresh device list">
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
        <path d="M10.5 2A5 5 0 1 0 11 6"/>
        <polyline points="8.5,0 10.5,2 8.5,4"/>
      </svg>
      Refresh devices
    </button>`;

    dd.innerHTML = html;

    // Wire delegated click listener after DOM is updated
    dd.addEventListener('click', e => {
      const item = e.target.closest('[data-select]');
      if (item) { selectDevice(item.dataset.select === 'all' ? 'all' : Number(item.dataset.select)); return; }
      if (e.target.closest('#dd-refresh-btn')) { refreshDevices(); }
    }, { once: true }); // once:true — re-added on each render
  }

  function selectDevice(id) {
    selectedDeviceId = id;
    updateRecipientBtn();
    closeDropdown();
  }

  function updateRecipientBtn() {
    const label = document.getElementById('recipient-label');
    const dot   = document.getElementById('rdot');
    const badge = document.getElementById('count-badge');
    badge.textContent = Object.keys(connectedDevices).length; // only OTHER devices

    if (selectedDeviceId === 'all') {
      label.textContent = 'Everyone';
      dot.className = 'rdot';
    } else {
      const d = connectedDevices[selectedDeviceId];
      if (d) { label.textContent = d.name; dot.className = 'rdot purple'; }
      else   { selectedDeviceId = 'all'; updateRecipientBtn(); }
    }
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────
  // Flash the radar rings when a device joins
  function flashRadar() {
    const wrap = document.querySelector('.radar-wrap');
    if (!wrap) return;
    const rings = wrap.querySelectorAll('.radar-ring');
    rings.forEach(r => {
      r.classList.remove('flash');
      void r.offsetWidth; // force reflow
      r.classList.add('flash');
      r.addEventListener('animationend', () => r.classList.remove('flash'), { once: true });
    });
  }

  function connect() {
    ws = new WebSocket(WS_URL);
    ws.onopen  = () => {
      setStatus(false, 'Registering…');
      // No timeout, no myId clearing — keep it simple and reliable
    };
    ws.onclose = () => {
      setStatus(false);
      setTimeout(connect, 3000);
    };
    ws.onerror = () => ws.close();

    ws.onmessage = ({ data }) => {
      let msg; try { msg = JSON.parse(data); } catch { return; }

      if (msg.type === 'hello') {
        ws.send(JSON.stringify({ type: 'register', uuid: myUuid, name: document.getElementById('name-input').value, localIp: myLocalIp }));
      }

      if (msg.type === 'welcome') {
        myId = msg.id;
        setStatus(true);
        document.getElementById('my-id-label').textContent = `ID:${myId}`;
        myDevice = { id: myId, name: document.getElementById('name-input').value, localIp: myLocalIp };
        connectedDevices = {};
        msg.devices.forEach(d => { connectedDevices[d.id] = d; });
        updateRecipientBtn();
      }

      if (msg.type === 'device_joined') {
        connectedDevices[msg.device.id] = msg.device;
        updateRecipientBtn();
        addSystemMsg(`${msg.device.name} joined`);
        flashRadar();
      }

      if (msg.type === 'device_left') {
        const d = connectedDevices[msg.id];
        if (d) {
          addSystemMsg(`${d.name} left`);
          delete connectedDevices[msg.id];
          if (selectedDeviceId === msg.id) { selectedDeviceId = 'all'; }
          updateRecipientBtn();
        }
      }

      if (msg.type === 'device_updated') {
        if (connectedDevices[msg.device.id]) {
          connectedDevices[msg.device.id] = { ...connectedDevices[msg.device.id], ...msg.device };
          updateRecipientBtn();
        }
      }

      if (['send_text','send_link','send_file'].includes(msg.type)) {
        if (msg.self) {
          const el = addMessage(msg, 'self');
          if (el && msg.msgId) {
            const total = msg.recipientCount || 0;
            pendingReceipts.set(msg.msgId, { el, total, delivered: new Set(), read: new Set() });
            updateReceiptEl(msg.msgId);
          }
        } else {
          addMessage(msg, 'other');
          if (msg.msgId && msg.senderId != null) {
            document.visibilityState === 'visible'
              ? sendReadReceipt(msg.msgId, msg.senderId)
              : pendingReadQueue.push({ msgId: msg.msgId, senderId: msg.senderId });
          }
        }
      }

      if (msg.type === 'receipt' && msg.msgId) {
        const r = pendingReceipts.get(msg.msgId);
        if (!r) return;
        if (msg.status === 'delivered') r.delivered.add(msg.recipientId);
        if (msg.status === 'read')      { r.read.add(msg.recipientId); r.delivered.add(msg.recipientId); }
        updateReceiptEl(msg.msgId);
      }

      if (msg.type === 'error') showToast(msg.message || 'An error occurred.');
    };
  }

  function sendReadReceipt(msgId, senderId) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'mark_read', msgId, senderId }));
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      while (pendingReadQueue.length) {
        const { msgId, senderId } = pendingReadQueue.shift();
        sendReadReceipt(msgId, senderId);
      }
    }
  });

  // ── Receipt ────────────────────────────────────────────────────────────────
  function tickSvg() {
    return `<svg class="tick" viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><path d="M1.5 5.5 L4 8 L8.5 2.5"/></svg>`;
  }

  function updateReceiptEl(msgId) {
    const r = pendingReceipts.get(msgId);
    if (!r || !r.el) return;
    const el = r.el.querySelector('.msg-receipt');
    if (!el) return;

    const { total, delivered, read } = r;

    if (total === 0) {
      el.className = 'msg-receipt no-recipients';
      el.innerHTML = `<span class="receipt-label">No one else online</span>`;
      return;
    }

    const dCount = delivered.size, rCount = read.size;
    let cls = 'msg-receipt', icon = '', label = '';

    if (rCount >= total)      { cls += ' read';         icon = `<span class="receipt-icon">${tickSvg()}${tickSvg()}</span>`; label = total===1?'Read':'Read by all'; }
    else if (rCount > 0)      { cls += ' partial-read'; icon = `<span class="receipt-icon">${tickSvg()}${tickSvg()}</span>`; label = `Read ${rCount}/${total}`; }
    else if (dCount >= total) { cls += ' delivered';    icon = `<span class="receipt-icon">${tickSvg()}${tickSvg()}</span>`; label = 'Delivered'; }
    else if (dCount > 0)      { cls += ' delivered';    icon = `<span class="receipt-icon">${tickSvg()}${tickSvg()}</span>`; label = `Delivered ${dCount}/${total}`; }
    else                      { cls += ' sent';          icon = `<span class="receipt-icon">${tickSvg()}</span>`;             label = 'Sent'; }

    el.className = cls;
    el.innerHTML = `${icon}<span class="receipt-label">${label}</span>`;
  }

  // ── Status ─────────────────────────────────────────────────────────────────
  function setStatus(on, label) {
    document.getElementById('status-dot').className = `status-dot ${on ? 'connected' : 'disconnected'}`;
    document.getElementById('status-text').textContent = on ? 'Connected' : (label || 'Reconnecting…');
  }

  // ── Name change ────────────────────────────────────────────────────────────
  // name-input change listener moved to wireEvents()

  // ── Message rendering ──────────────────────────────────────────────────────
  // addMessage: public API — renders AND saves to session history
  function addMessage(msg, side) {
    saveToHistory({ msg, side });
    return addMessageDOM(msg, side, true);
  }

  function addMessageDOM(msg, side, scroll) {
    document.getElementById('empty-state')?.remove();
    const container = document.getElementById('messages');
    const div = document.createElement('div');
    div.className = `msg ${side}`;

    const time     = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const fromName = side === 'self' ? 'You' : (msg.from?.name || 'Unknown');

    let badge = '', content = '';
    if (msg.type === 'send_text') {
      badge   = '<span class="msg-type-badge badge-text">text</span>';
      content = `<div>${esc(msg.content).replace(/\n/g,'<br>')}</div>`;
    } else if (msg.type === 'send_link') {
      badge = '<span class="msg-type-badge badge-link">link</span>';
      // Security: safeUrl validates protocol — blocks javascript: URIs
      const href    = safeUrl(msg.content);
      const blocked = href === '#';
      // Extract and show domain prominently — anti-phishing UX
      let domainTag = '';
      if (!blocked) {
        try {
          const domain = new URL(msg.content).hostname;
          domainTag = `<span class='link-domain'>${esc(domain)}</span>`;
        } catch {}
      }
      content = `<div class="msg-link${blocked?' blocked':''}">
        <a href="${href}" ${blocked ? '' : 'target="_blank" rel="noopener noreferrer"'}>${esc(msg.content)}</a>
        ${domainTag}
        ${blocked ? '<span class="url-blocked-label"> (unsafe URL blocked)</span>' : ''}
      </div>`;
    } else if (msg.type === 'send_file') {
      badge = '<span class="msg-type-badge badge-file">file</span>';
      // File URLs are server-generated relative paths (/uploads/...).
      // Validate they are safe relative paths — no absolute URLs with arbitrary schemes.
      const rawFileUrl = String(msg.file.url || '');
      const isSafeFileUrl = /^\/uploads\/[a-zA-Z0-9_\-\.]+$/.test(rawFileUrl);
      if (isSafeFileUrl) {
        const absoluteFileUrl = API_URL + rawFileUrl;  // Render serves the file
        content = `<a class="file-card" href="${esc(absoluteFileUrl)}" download="${esc(msg.file.name)}">
          <div class="file-icon">${fileIcon(msg.file.mimetype)}</div>
          <div><div class="file-name">${esc(msg.file.name)}</div><div class="file-size">${fmtSize(msg.file.size)}</div></div>
        </a>`;
      } else {
        content = `<div class="file-card-error">⚠️ File link unavailable</div>`;
      }
    }

    const toTag     = msg.toName ? `<span>→ ${esc(msg.toName)}</span>` : '';
    const receiptRow = side === 'self'
      ? `<div class="msg-receipt sent"><span class="receipt-icon">${tickSvg()}</span><span class="receipt-label">Sent</span></div>`
      : '';

    div.innerHTML = `
      <div class="msg-meta"><span>${esc(fromName)}</span><span>${time}</span>${toTag}</div>
      <div class="msg-bubble">${badge}${content}</div>
      ${receiptRow}`;

    container.appendChild(div);
    if (scroll !== false) container.scrollTop = container.scrollHeight;
    return div;
  }

  function addSystemMsg(text) {
    const container = document.getElementById('messages');
    const div = document.createElement('div');
    div.className = 'sys-msg';
    div.textContent = `— ${text} —`;  // textContent: no innerHTML, no XSS
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  // ── Send actions ───────────────────────────────────────────────────────────
  function sendText() {
    const input = document.getElementById('text-input');
    const content = input.value.trim();
    if (!content || ws?.readyState !== WebSocket.OPEN) return;
    if (selectedDeviceId !== 'all' && !connectedDevices[selectedDeviceId]) {
      selectedDeviceId = 'all';
      updateRecipientBtn();
    }
    ws.send(JSON.stringify({ type: 'send_text', content, to: selectedDeviceId, msgId: newMsgId() }));
    input.value = '';
  }

  function sendLink() {
    const input = document.getElementById('link-input');
    let content = input.value.trim();
    if (!content || ws?.readyState !== WebSocket.OPEN) return;
    if (!/^https?:\/\//i.test(content)) content = 'https://' + content;
    if (!isValidUrl(content)) {
      input.classList.add('invalid');
      showToast('Invalid link — please enter a valid URL.');
      setTimeout(() => input.classList.remove('invalid'), 2000);
      return;
    }
    if (selectedDeviceId !== 'all' && !connectedDevices[selectedDeviceId]) {
      selectedDeviceId = 'all';
      updateRecipientBtn();
      showToast('Selected device left — sending to everyone instead.');
    }
    ws.send(JSON.stringify({ type: 'send_link', content, to: selectedDeviceId, msgId: newMsgId() }));
    input.value = '';
    input.classList.remove('invalid');
  }

  async function uploadFile(file) {
    if (!file) return;
    const progress = document.getElementById('upload-progress');
    const fill     = document.getElementById('progress-fill');
    const pct      = document.getElementById('upload-pct');
    const label    = document.getElementById('upload-label');

    progress.classList.add('show');
    label.textContent = file.name;
    fill.style.width = '0%'; pct.textContent = '0%';

    const msgId = newMsgId();
    const fd = new FormData();
    fd.append('file', file);
    if (selectedDeviceId !== 'all' && !connectedDevices[selectedDeviceId]) {
      selectedDeviceId = 'all';
      updateRecipientBtn();
    }
    fd.append('to', selectedDeviceId);
    // uuid is now sent via X-Session-UUID header (validated before multer)
    fd.append('msgId',  msgId);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', API_URL + '/upload');
    xhr.setRequestHeader('X-Session-UUID', myUuid); // validated server-side before multer
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) { const p = Math.round(e.loaded/e.total*100); fill.style.width=p+'%'; pct.textContent=p+'%'; }
    };
    xhr.onload = () => {
      progress.classList.remove('show');
      document.getElementById('file-input').value = '';
      if (xhr.status === 200) {
        const json = JSON.parse(xhr.responseText);
        const selfMsg = {
          type: 'send_file', msgId, self: true,
          from: { id: myId, name: document.getElementById('name-input').value },
          file: { name: file.name, url: json.url, size: file.size, mimetype: file.type },
          timestamp: Date.now(),
          recipientCount: json.recipientCount || 0
        };
        const el = addMessage(selfMsg, 'self');
        if (el && msgId) {
          pendingReceipts.set(msgId, { el, total: selfMsg.recipientCount, delivered: new Set(), read: new Set() });
          updateReceiptEl(msgId);
        }
      } else {
        try { showToast(JSON.parse(xhr.responseText).error || 'Upload failed.'); } catch { showToast('Upload failed.'); }
      }
    };
    xhr.onerror = () => { progress.classList.remove('show'); showToast('Upload error.'); };
    xhr.send(fd);
  }

  function switchTab(tab) {
    document.querySelectorAll('.tab-btn').forEach((b, i) => {
      const t = ['text','link','file'][i];
      b.classList.toggle('active', t === tab);
      b.setAttribute('aria-selected', t === tab);
    });
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.getElementById(`panel-${tab}`).classList.add('active');
  }

  // Keyboard shortcuts and drag-drop are wired in wireEvents() below.

  // ── Helpers ────────────────────────────────────────────────────────────────
  function fileIcon(mime = '') {
    if (mime.startsWith('image/')) return '🖼️';
    if (mime.startsWith('video/')) return '🎬';
    if (mime.startsWith('audio/')) return '🎵';
    if (mime.includes('pdf'))      return '📄';
    if (mime.includes('zip')||mime.includes('rar')||mime.includes('7z')) return '🗜️';
    if (mime.includes('word')||mime.includes('document')) return '📝';
    if (mime.includes('sheet')||mime.includes('excel'))   return '📊';
    return '📁';
  }

  function fmtSize(b) {
    if (b < 1024)    return `${b} B`;
    if (b < 1048576) return `${(b/1024).toFixed(1)} KB`;
    return `${(b/1048576).toFixed(1)} MB`;
  }

  // ── Ping ───────────────────────────────────────────────────────────────────
  // Collects all readable device info from the browser and sends it as a
  // text message to Everyone so all connected devices can see who just pinged.
  async function sendPing() {
    if (ws?.readyState !== WebSocket.OPEN) { showToast('Not connected.'); return; }

    const btn = document.querySelector('.ping-btn');
    btn?.classList.add('fired');
    setTimeout(() => btn?.classList.remove('fired'), 500);

    // ── Collect device info ──────────────────────────────────────────────────
    const info = [];

    // Name
    const name = document.getElementById('name-input').value || 'Unknown';
    info.push(`Name: ${name}`);

    // Device ID (assigned by server)
    if (myId) info.push(`Session ID: ${myId}`);

    // Local IP (WebRTC-detected)
    if (myLocalIp) info.push(`Local IP: ${myLocalIp}`);

    // User Agent — OS / Browser
    const ua = navigator.userAgent;
    const browser = (() => {
      if (/Edg/.test(ua))     return 'Microsoft Edge';
      if (/OPR/.test(ua))     return 'Opera';
      if (/Chrome/.test(ua))  return 'Chrome';
      if (/Firefox/.test(ua)) return 'Firefox';
      if (/Safari/.test(ua))  return 'Safari';
      return 'Unknown Browser';
    })();
    const os = (() => {
      if (/iPhone/.test(ua))  return 'iOS (iPhone)';
      if (/iPad/.test(ua))    return 'iOS (iPad)';
      if (/Android/.test(ua)) return 'Android';
      if (/Win/.test(ua))     return 'Windows';
      if (/Mac/.test(ua))     return 'macOS';
      if (/Linux/.test(ua))   return 'Linux';
      return 'Unknown OS';
    })();
    info.push(`Browser: ${browser}`);
    info.push(`OS: ${os}`);

    // Screen resolution & pixel ratio
    info.push(`Screen: ${screen.width}×${screen.height} (${window.devicePixelRatio}x dpr)`);

    // Language
    info.push(`Language: ${navigator.language}`);

    // Platform (deprecated but still widely available)
    if (navigator.platform) info.push(`Platform: ${navigator.platform}`);

    // Online status
    info.push(`Network: ${navigator.onLine ? 'Online' : 'Offline'}`);

    // Connection type if available
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn) {
      const parts = [];
      if (conn.effectiveType) parts.push(conn.effectiveType);
      if (conn.downlink)      parts.push(`↓ ${conn.downlink} Mbps`);
      if (conn.rtt)           parts.push(`RTT ${conn.rtt}ms`);
      if (parts.length) info.push(`Connection: ${parts.join(', ')}`);
    }

    // Timestamp
    info.push(`Time: ${new Date().toLocaleString()}`);

        const sep = '\u2500'.repeat(30);
    const content = '\uD83D\uDCE1 Ping from ' + name + '\n' + sep + '\n' + info.join('\n');

    ws.send(JSON.stringify({
      type: 'send_text',
      content,
      to: 'all',
      msgId: newMsgId()
    }));
  }

  // ── Hard Reset ─────────────────────────────────────────────────────────────
  // Clears sessionStorage, unregisters service workers, busts all caches,
  // then forces a full reload bypassing the browser cache.
  async function hardReset() {
    // 1. Clear session history and tab UUID so a fresh session starts
    sessionStorage.clear();

    // 2. Unregister all service workers (this forces SW re-install on reload)
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }

    // 3. Delete all Cache Storage caches (SW cache, app shell, etc.)
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }

    // 4. Hard reload — bypass all browser cache (Ctrl+Shift+R equivalent)
    location.reload(true);
  }

  // ── LAN trust warning ─────────────────────────────────────────────────────
  function dismissLanWarning() {
    const el = document.getElementById('lan-warning');
    if (el) el.remove();
    sessionStorage.setItem('lan_warning_dismissed', '1');
  }
  // Auto-dismiss if already seen this session
  if (sessionStorage.getItem('lan_warning_dismissed')) {
    document.getElementById('lan-warning')?.remove();
  }

  // ── Modal ──────────────────────────────────────────────────────────────────
  function openModal(id) {
    document.getElementById('modal-backdrop').classList.add('open');
    document.getElementById('modal-' + id).setAttribute('open', '');
    document.body.style.overflow = 'hidden';
  }
  function closeModal() {
    document.getElementById('modal-backdrop').classList.remove('open');
    document.querySelectorAll('.modal[open]').forEach(m => m.removeAttribute('open'));
    document.body.style.overflow = '';
  }
  // Escape key handler moved to wireEvents()

  // ── DOM event wiring ───────────────────────────────────────────────────────
  // All event handlers are wired here — zero onclick/onchange in HTML.
  // This is required for nonce-based CSP (inline handlers are never nonce-exempt).
  function wireEvents() {
    // Overlay + dropdown
    document.getElementById('overlay')        ?.addEventListener('click',  closeDropdown);
    document.getElementById('recipient-btn')  ?.addEventListener('click',  toggleDropdown);

    // Header
    document.getElementById('theme-toggle')?.addEventListener('click', toggleTheme);

    // LAN warning
    document.getElementById('lan-dismiss-btn')?.addEventListener('click',  dismissLanWarning);

    // Toolbar
    document.getElementById('ping-btn')       ?.addEventListener('click',  sendPing);
    document.getElementById('reset-btn')      ?.addEventListener('click',  hardReset);

    // Tabs
    document.getElementById('tab-text')       ?.addEventListener('click',  () => switchTab('text'));
    document.getElementById('tab-link')       ?.addEventListener('click',  () => switchTab('link'));
    document.getElementById('tab-file')       ?.addEventListener('click',  () => switchTab('file'));

    // Send buttons
    document.getElementById('send-text-btn')  ?.addEventListener('click',  sendText);
    document.getElementById('send-link-btn')  ?.addEventListener('click',  sendLink);

    // File input
    document.getElementById('file-input')     ?.addEventListener('change', e => uploadFile(e.target.files[0]));

    // Text input keyboard shortcuts
    document.getElementById('text-input')?.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
    });
    document.getElementById('link-input')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); sendLink(); }
    });
    document.getElementById('link-input')?.addEventListener('input', () => {
      document.getElementById('link-input').classList.remove('invalid');
    });

    // Footer legal buttons
    document.getElementById('footer-terms-btn')     ?.addEventListener('click', () => openModal('terms'));
    document.getElementById('footer-disclaimer-btn')?.addEventListener('click', () => openModal('disclaimer'));

    // Modal close buttons
    document.getElementById('terms-close-btn')      ?.addEventListener('click', closeModal);
    document.getElementById('disclaimer-close-btn') ?.addEventListener('click', closeModal);

    // Modal backdrop
    document.getElementById('modal-backdrop')       ?.addEventListener('click', closeModal);

    // Drag and drop on file zone
    const dropZone = document.getElementById('drop-zone');
    if (dropZone) {
      dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
      dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
      dropZone.addEventListener('drop',      e => {
        e.preventDefault(); dropZone.classList.remove('drag-over');
        const file = e.dataTransfer.files[0]; if (file) uploadFile(file);
      });
    }

    // Escape key closes modals
    // Escape key handler moved to wireEvents()

    // Name change
    document.getElementById('name-input')?.addEventListener('change', e => {
      saveName(e.target.value);
      myDevice.name = e.target.value;
      if (ws?.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'set_name', name: e.target.value, localIp: myLocalIp }));
    });
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  const _yr  = new Date().getFullYear();
  const _cfg2 = window.APP_CONFIG || {};
  document.getElementById('footer-year').textContent = _yr;
  document.querySelectorAll('#terms-year, #disclaimer-year').forEach(el => el.textContent = _yr);
  // Update footer links from config
  const _orgLink     = document.querySelector('footer a[href*="beehta"]');
  const _authorLink  = document.querySelector('footer a[href*="kash-pram"]');
  const _sponsorLink = document.querySelector('.donate-btn');
  if (_cfg2.ORG_URL    && _orgLink)     { _orgLink.href = _cfg2.ORG_URL;    _orgLink.textContent = _cfg2.ORG_NAME    || _orgLink.textContent; }
  if (_cfg2.AUTHOR_URL && _authorLink)  { _authorLink.href = _cfg2.AUTHOR_URL; }
  if (_cfg2.SPONSOR_URL && _sponsorLink){ _sponsorLink.href = _cfg2.SPONSOR_URL; }

  (async () => {
    const savedName = getSavedName();
    const name = savedName || randomName();
    if (!savedName) saveName(name);
    document.getElementById('name-input').value = name;

    myLocalIp = await detectLocalIp(); // still used for grouping hint

    wireEvents();        // wire all DOM event handlers (required for nonce CSP)
    renderHistory();     // restore session messages before connecting
    updateRecipientBtn();
    connect();
  })();

