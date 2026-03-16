// CoListen - Spicetify Extension
// Sync logic: host sends timestamp with state, guest compensates for network delay.
// Position only synced on: join, track change, manual sync button.
// No continuous seeking. No loops.

(function coListen() {
  if (!Spicetify.Player || !Spicetify.Platform || !Spicetify.React || !Spicetify.ReactDOM) {
    setTimeout(coListen, 300);
    return;
  }
  main();
})();

function main() {
  const { React, ReactDOM } = Spicetify;
  const { useState, useEffect } = React;

  const STORAGE_KEY = "coListen:username";
  const POS_KEY     = "coListen:panelPos";

  function loadPanelPos() {
    try {
      const p = JSON.parse(Spicetify.LocalStorage.get(POS_KEY) || "null");
      return p && typeof p.x === "number" && typeof p.y === "number" ? p : null;
    } catch { return null; }
  }

  function savePanelPos(x, y) {
    try { Spicetify.LocalStorage.set(POS_KEY, JSON.stringify({ x, y })); } catch {}
  }

  function applyDrag(panelEl) {
    // Apply saved position
    const saved = loadPanelPos();
    if (saved) {
      panelEl.style.right  = "auto";
      panelEl.style.top    = saved.y + "px";
      panelEl.style.left   = saved.x + "px";
    }

    const header = panelEl.querySelector(".lt-hd");
    if (!header) return;

    let dragging = false;
    let startX, startY, origLeft, origTop;

    header.addEventListener("mousedown", (e) => {
      // Don't drag if clicking the X button
      if (e.target.closest(".lt-x")) return;
      dragging = true;
      const rect = panelEl.getBoundingClientRect();
      startX   = e.clientX;
      startY   = e.clientY;
      origLeft = rect.left;
      origTop  = rect.top;
      panelEl.style.right = "auto";
      panelEl.style.left  = origLeft + "px";
      panelEl.style.top   = origTop  + "px";
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx   = e.clientX - startX;
      const dy   = e.clientY - startY;
      const newX = Math.max(0, Math.min(window.innerWidth  - panelEl.offsetWidth,  origLeft + dx));
      const newY = Math.max(0, Math.min(window.innerHeight - panelEl.offsetHeight, origTop  + dy));
      panelEl.style.left = newX + "px";
      panelEl.style.top  = newY + "px";
    });

    document.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      savePanelPos(parseInt(panelEl.style.left), parseInt(panelEl.style.top));
    });
  }
  const SERVER_URL  = "wss://lt-server.sermysergio.workers.dev";
  const HEARTBEAT_MS = 4000; // only used to detect track changes & play/pause

  const session = {
    ws:              null,
    amHost:          false,
    active:          false,
    inSession:       false,
    code:            "",
    myName:          "",
    sid:             "",
    members:         [],
    myLatency:       null,
    pingMap:         {},
    pingTimer:       null,
    heartbeatTimer:  null,
    lastHostState:   null,
    reconnectTimer:  null,
    reconnectCount:  0,    // how many times we've tried to reconnect
    intentionalClose: false, // true when user clicks Leave — no reconnect
  };

  let uiCallback = null;
  function notifyUI() { uiCallback?.(); }

  const log = (...a) => console.log("[CL]", ...a);
  const err = (...a) => console.error("[CL]", ...a);
  const dbg = (...a) => console.debug("[CL:DBG]", ...a);
  function wsState(ws) {
    if (!ws) return "null";
    return ["CONNECTING","OPEN","CLOSING","CLOSED"][ws.readyState] || ws.readyState;
  }

  function getSpotifyUsername() {
    try {
      return Spicetify.Platform?.UserAPI?._product_state?.pairs?.name
          || Spicetify.Platform?.UserAPI?.getUser?.()?.displayName
          || Spicetify.LocalStorage.get("spicetify_local_storage_user_display_name")
          || "Me";
    } catch { return "Me"; }
  }
  const getUsername = () => Spicetify.LocalStorage.get(STORAGE_KEY) || getSpotifyUsername();
  const saveUsername = (n) => Spicetify.LocalStorage.set(STORAGE_KEY, n);

  function makeCode() {
    const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    return Array.from({ length: 6 }, () => c[Math.floor(Math.random() * c.length)]).join("");
  }

  // ─── Send ─────────────────────────────────────────────────────────────────
  function send(msg) {
    if (session.ws?.readyState === WebSocket.OPEN) {
      // Tag with unique session ID to filter self-echoes
      const tagged = { ...msg, _sid: session.sid };
      try { session.ws.send(JSON.stringify(tagged)); } catch(e) { err("send:", e); }
    }
  }

  // ─── Get current player state ─────────────────────────────────────────────
  function getState() {
    try {
      const d = Spicetify.Player.data;
      if (!d?.item) return null;
      // Include next 10 tracks in queue so guest can preload them
      const queue = [];
      try {
        const nextTracks = Spicetify.Queue?.nextTracks || [];
        for (let i = 0; i < Math.min(nextTracks.length, 10); i++) {
          const uri = nextTracks[i]?.uri || nextTracks[i]?.track?.uri;
          if (uri) queue.push(uri);
        }
      } catch {}
      return {
        uri:       d.item.uri,
        name:      d.item.name || "",
        position:  Spicetify.Player.getProgress(),

        queue,
        sentAt:    Date.now(),
      };
    } catch { return null; }
  }

  // ─── Play a URI ───────────────────────────────────────────────────────────
  async function playUri(uri, pos) {
    const fns = [
      () => Spicetify.Platform.PlayerAPI.play({ uri }, {}, { positionMs: pos }),
      () => Spicetify.CosmosAsync.put("sp://player/v2/main", { playing_uri: uri, position: pos }),
    ];
    for (const fn of fns) {
      try { await fn(); return true; } catch {}
    }
    err("playUri failed:", uri);
    return false;
  }

  // ─── Sync to host state (one-shot, compensating for network delay) ────────
  async function syncToState(s, reason) {
    if (!s?.uri) return;
    log(`Syncing [${reason}] — uri: ${s.uri.slice(-20)}, pos: ${s.position}, playing: ${s.isPlaying}`);

    try {
      // Compensate for network delay — only if sentAt is valid
      const now = Date.now();
      const networkDelay = (s.sentAt && !isNaN(s.sentAt))
        ? Math.max(0, Math.min(now - s.sentAt, 5000))
        : 0;
      const rawPos = (typeof s.position === "number" && !isNaN(s.position)) ? s.position : 0;
      const targetPosition = Math.floor(rawPos + networkDelay);

      log(`Network delay: ${networkDelay}ms → target: ${targetPosition}ms`);

      const cur = Spicetify.Player.data?.item;

      if (!cur || cur.uri !== s.uri) {
        log("Track change → playing", s.name, "at", targetPosition);
        await playUri(s.uri, targetPosition);
        await new Promise(r => setTimeout(r, 600));
        if (!Spicetify.Player.isPlaying) Spicetify.Player.play();
        if (s.queue?.length) syncQueueBackground(s.queue);
        return;
      }

      // Same track → seek, never stop music
      log(`Seeking to ${targetPosition}ms`);
      Spicetify.Player.seek(targetPosition);
      setTimeout(() => {
        if (!Spicetify.Player.isPlaying) Spicetify.Player.play();
      }, 200);

    } catch(e) { err("syncToState:", e); }
  }

  // ─── Sync queue in background (after music is playing) ──────────────────
  async function syncQueueBackground(queue) {
    if (!queue?.length) return;
    log("Syncing queue in background:", queue.length, "tracks");
    // Wait a bit to not interfere with current playback
    await new Promise(r => setTimeout(r, 1000));
    try {
      // Add tracks to queue one by one with small delays to avoid overwhelming Spotify
      for (const uri of queue) {
        try {
          await Spicetify.addToQueue([{ uri }]);
          await new Promise(r => setTimeout(r, 300));
        } catch {}
      }
      log("Queue sync done");
    } catch(e) { err("queue sync:", e); }
  }

  // ─── Handle incoming messages ─────────────────────────────────────────────
  function onMessage(msg) {
    if (!msg?.type) return;
    // Ignore messages we sent ourselves (server echoes to all including sender)
    if (msg._sid && msg._sid === session.sid) return;

    // ── State update from host ──────────────────────────────────────────────
    if (msg.type === "state" && !session.amHost) {
      const s = msg.state;
      if (!s) return;

      const prev = session.lastHostState;
      // Update AFTER saving prev so comparisons are correct
      session.lastHostState = s;

      // 1. First state received after joining → sync immediately
      if (!prev) {
        log("Initial sync on join — host isPlaying:", s.isPlaying);
        syncToState(s, "join").then(() => {
          if (!s.isPlaying) {
            setTimeout(() => {
              if (Spicetify.Player.isPlaying) Spicetify.Player.pause();
            }, 1200);
          }
          if (s.queue?.length) {
            setTimeout(() => syncQueueBackground(s.queue), 3000);
          }
        });
        return;
      }

      // 2. Track changed → sync to new track
      if (prev.uri !== s.uri) {
        log("Host changed track →", s.name);
        syncToState(s, "track-change");
        return;
      }

      // Play/pause not synced — guest controls their own playback independently

      // 4. Nothing changed → do nothing (no seek, no interrupt)
      return;
    }

    // ── Command from guest (host applies it) ────────────────────────────────
    if (msg.type === "cmd" && session.amHost) {
      const cmd = msg.cmd;
      log("Guest command:", cmd.action);
      // request_state: guest wants a fresh sync → host sends current state immediately
      if (cmd.action === "request_state") {
        const s = getState();
        if (s) send({ type: "state", state: s });
        return;
      }
      try {
        if (cmd.action === "play")  Spicetify.Player.play();
        if (cmd.action === "pause") Spicetify.Player.pause();
        if (cmd.action === "next")  Spicetify.Player.next();
        if (cmd.action === "prev")  Spicetify.Player.back();
        if (cmd.action === "seek")  Spicetify.Player.seek(cmd.pos);
      } catch(e) { err("cmd:", e); }
      setTimeout(() => { const s = getState(); if (s) send({ type: "state", state: s }); }, 300);
      return;
    }

    // ── Ping / pong for latency ─────────────────────────────────────────────
    if (msg.type === "ping") {
      send({ type: "pong", id: msg.id });
      return;
    }
    if (msg.type === "pong") {
      const resolve = session.pingMap[msg.id];
      if (resolve) { resolve(Date.now() - msg.id); delete session.pingMap[msg.id]; }
      return;
    }

    // ── Members ─────────────────────────────────────────────────────────────
    if (msg.type === "joined") {
      if (!session.members.find(m => m.name === msg.user)) {
        session.members.push({ name: msg.user });
      }
      Spicetify.showNotification(`🎵 ${msg.user} joined`);
      // Host sends current state to new guest immediately
      if (session.amHost) {
        setTimeout(() => { const s = getState(); if (s) send({ type: "state", state: s }); }, 200);
      }
      notifyUI();
      return;
    }

    if (msg.type === "left") {
      session.members = session.members.filter(m => m.name !== msg.user);
      Spicetify.showNotification(`👋 ${msg.user} left`);
      notifyUI();
      return;
    }

    if (msg.type === "members") {
      session.members = msg.members.map(name => ({ name }));
      notifyUI();
      return;
    }
  }

  // ─── Host heartbeat (only sends state, no seeking on guest side) ──────────
  function startHeartbeat() {
    stopHeartbeat();
    session.heartbeatTimer = setInterval(() => {
      if (!session.active || !session.amHost) return;
      const s = getState();
      if (s) send({ type: "state", state: s });
      // Measure latency
      const now = Date.now();
      session.pingMap[now] = (rtt) => { session.myLatency = rtt; notifyUI(); };
      send({ type: "ping", id: now });
    }, HEARTBEAT_MS);
  }

  // ─── Player event listeners (host only — fires immediately on change) ──────


  Spicetify.Player.addEventListener("songchange", () => {
    if (!session.active || !session.amHost) return;
    setTimeout(() => {
      const s = getState();
      if (s) {
        log("Host song change → broadcasting immediately");
        send({ type: "state", state: s });
      }
    }, 300);
  });

  // ─── Guest ping ───────────────────────────────────────────────────────────
  function startGuestPing() {
    if (session.pingTimer) clearInterval(session.pingTimer);
    session.pingTimer = setInterval(() => {
      if (!session.active) return;
      const now = Date.now();
      session.pingMap[now] = (rtt) => { session.myLatency = rtt; notifyUI(); };
      send({ type: "ping", id: now });
    }, 3000);
  }

  function stopHeartbeat() {
    if (session.heartbeatTimer) { clearInterval(session.heartbeatTimer); session.heartbeatTimer = null; }
    if (session.pingTimer)      { clearInterval(session.pingTimer);      session.pingTimer      = null; }
  }

  // ─── Connect to room ──────────────────────────────────────────────────────
  function connectToRoom(code, username, asHost, onProgress) {
    const url = `${SERVER_URL}/room/${code}?name=${encodeURIComponent(username)}`;
    log(`Connecting [attempt ${session.reconnectCount + 1}] → ${url}`);

    const ws = new WebSocket(url);
    session.ws = ws;

    const timeout = setTimeout(() => {
      if (!session.active) {
        err("Connection timeout after 15s");
        onProgress({ type: "timeout" });
        cleanup();
      }
    }, 15000);

    ws.onopen = () => {
      clearTimeout(timeout);
      log("WS open ✓ — state:", wsState(ws));
      session.active           = true;
      session.amHost           = asHost;
      session.code             = code;
      session.myName           = username;
      session.sid              = Math.random().toString(36).slice(2);
      session.reconnectCount   = 0; // reset on successful connect
      session.intentionalClose = false;
      if (!session.members.find(m => m.name === username)) {
        session.members.push({ name: username });
      }
      if (asHost) {
        startHeartbeat();
      } else {
        session.inSession = true;
        startGuestPing();
      }
      onProgress({ type: "connected" });
      notifyUI();
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        dbg("← received:", msg.type, msg._sid ? `(sid: ${msg._sid.slice(0,6)})` : "");
        onMessage(msg);
      } catch(e) { err("parse error:", e, "raw:", ev.data?.slice(0, 100)); }
    };

    ws.onclose = (ev) => {
      log(`WS closed — code: ${ev.code}, reason: "${ev.reason}", clean: ${ev.wasClean}`);

      // If user intentionally left, don't reconnect
      if (session.intentionalClose) {
        log("Intentional close — no reconnect");
        return;
      }

      if (session.active) {
        const savedCode     = session.code;
        const savedName     = session.myName;
        const savedAsHost   = session.amHost;
        const savedMembers  = [...session.members];
        const reconnectNum  = session.reconnectCount + 1;

        // Don't reconnect if too many attempts
        if (reconnectNum > 5) {
          err("Too many reconnect attempts — giving up");
          cleanup();
          renderUI();
          Spicetify.showNotification("Session lost — too many reconnect attempts");
          return;
        }

        // Keep session visually active while reconnecting
        session.reconnectCount = reconnectNum;
        Spicetify.showNotification(`⚠️ Connection lost — reconnecting (${reconnectNum}/5)…`);
        log(`Reconnecting in 2s… attempt ${reconnectNum}/5`);

        session.reconnectTimer = setTimeout(() => {
          // Restore members so UI doesn't flash empty
          session.members = savedMembers;
          connectToRoom(savedCode, savedName, savedAsHost, (ev) => {
            if (ev.type === "connected") {
              Spicetify.showNotification("✅ Reconnected!");
              notifyUI();
            }
          });
        }, 2000);
      }
    };

    ws.onerror = (ev) => {
      err("WS error:", ev.type, "— WS state:", wsState(ws));
      clearTimeout(timeout);
      if (!session.active) {
        onProgress({ type: "error", msg: "Connection failed. Check your internet." });
      }
    };
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────
  function cleanup() {
    log("Cleanup — was active:", session.active, "amHost:", session.amHost);
    stopHeartbeat();
    if (session.reconnectTimer) { clearTimeout(session.reconnectTimer); session.reconnectTimer = null; }
    session.active        = false;
    session.myLatency     = null;
    session.pingMap       = {};
    session.members       = [];
    session.code          = "";
    session.myName        = "";
    session.sid           = "";
    session.amHost        = false;
    session.inSession     = false;
    session.lastHostState = null;
    session.reconnectCount = 0;
    if (session.ws) {
      try { session.ws.close(); } catch {}
      session.ws = null;
    }
    notifyUI();
  }

  // ─── CSS ──────────────────────────────────────────────────────────────────
  if (!document.getElementById("lt-css")) {
    const el = document.createElement("style");
    el.id = "lt-css";
    el.textContent = `
      @keyframes lt-in   { from{opacity:0;transform:translateY(-5px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)} }
      @keyframes lt-spin { to{transform:rotate(360deg)} }
      #lt-root * { box-sizing:border-box; }
      #lt-root .lt-panel {
        position:fixed;top:56px;right:16px;z-index:9999;width:300px;
        background:#111;border:1px solid #1e1e1e;border-radius:14px;
        box-shadow:0 20px 60px rgba(0,0,0,.8);color:#fff;
        font-family:'Circular','Helvetica Neue',Arial,sans-serif;
        animation:lt-in .15s cubic-bezier(.16,1,.3,1);overflow:hidden;
        user-select:none;
      }
      #lt-root .lt-hd { cursor:grab; }
      #lt-root .lt-hd:active { cursor:grabbing; }
      #lt-root .lt-hd { display:flex;align-items:center;justify-content:space-between;padding:13px 15px 11px;border-bottom:1px solid #1a1a1a; }
      #lt-root .lt-hl { display:flex;align-items:center;gap:7px; }
      #lt-root .lt-dot { width:6px;height:6px;border-radius:50%;background:#1ed760;box-shadow:0 0 5px #1ed76077; }
      #lt-root .lt-dot.off { background:#252525;box-shadow:none; }
      #lt-root .lt-ttl { font-size:12px;font-weight:600;color:#ccc; }
      #lt-root .lt-x { background:none;border:none;color:#3a3a3a;cursor:pointer;font-size:16px;line-height:1;padding:0 2px;transition:color .1s; }
      #lt-root .lt-x:hover { color:#888; }
      #lt-root .lt-bd { padding:13px 15px 15px; }
      #lt-root .lt-nr { display:flex;align-items:center;gap:8px;margin-bottom:13px; }
      #lt-root .lt-av { width:28px;height:28px;border-radius:50%;background:#1ed760;color:#000;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;flex-shrink:0;text-transform:uppercase; }
      #lt-root .lt-ni { flex:1;background:transparent;border:none;border-bottom:1px solid #1e1e1e;color:#aaa;font-size:13px;padding:2px 0;outline:none;font-family:inherit;transition:border-color .15s; }
      #lt-root .lt-ni:focus { border-bottom-color:#1ed760;color:#fff; }
      #lt-root .lt-ni::placeholder { color:#303030; }
      #lt-root .lt-btn { display:flex;align-items:center;justify-content:center;gap:6px;width:100%;padding:10px 14px;border-radius:9px;border:none;font-size:13px;font-weight:600;font-family:inherit;cursor:pointer;transition:opacity .12s,transform .1s,background .12s; }
      #lt-root .lt-btn:active { transform:scale(.97); }
      #lt-root .lt-g  { background:#1ed760;color:#000; }
      #lt-root .lt-g:hover  { background:#21e865; }
      #lt-root .lt-gh { background:transparent;color:#484848;border:1px solid #1e1e1e; }
      #lt-root .lt-gh:hover { color:#777;border-color:#2a2a2a; }
      #lt-root .lt-sy { background:transparent;color:#1ed760;border:1px solid #1ed76033; }
      #lt-root .lt-sy:hover { background:#1ed76010; }
      #lt-root .lt-lv { background:transparent;color:#c0392b;border:1px solid #1e1e1e; }
      #lt-root .lt-lv:hover { background:#c0392b0d;border-color:#c0392b33; }
      #lt-root .lt-dim { opacity:.25;pointer-events:none; }
      #lt-root .lt-st { display:flex;flex-direction:column;gap:7px; }
      #lt-root .lt-dv { border:none;border-top:1px solid #1a1a1a;margin:12px 0; }
      #lt-root .lt-lb { font-size:10px;font-weight:600;color:#333;text-transform:uppercase;letter-spacing:.8px;margin-bottom:5px; }
      #lt-root .lt-cb { background:#0c0c0c;border:1px solid #1c1c1c;border-radius:10px;padding:16px;text-align:center;margin-bottom:10px; }
      #lt-root .lt-cv { font-size:32px;font-weight:800;letter-spacing:8px;color:#1ed760;font-family:'Courier New',monospace;display:block;margin-bottom:8px; }
      #lt-root .lt-cp { background:#1ed76015;border:1px solid #1ed76022;color:#1ed760;border-radius:6px;padding:4px 12px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;transition:background .12s; }
      #lt-root .lt-cp:hover { background:#1ed76025; }
      #lt-root .lt-ci { width:100%;background:#0c0c0c;border:1px solid #1c1c1c;border-radius:9px;padding:10px 13px;color:#aaa;font-size:22px;font-weight:700;font-family:'Courier New',monospace;letter-spacing:5px;outline:none;text-align:center;transition:border-color .15s;margin-bottom:8px;text-transform:uppercase; }
      #lt-root .lt-ci:focus { border-color:#2a2a2a;color:#fff; }
      #lt-root .lt-ci::placeholder { font-size:13px;letter-spacing:1px;color:#252525;font-weight:400; }
      #lt-root .lt-ht { font-size:11px;color:#333;line-height:1.5;margin-bottom:11px; }
      #lt-root .lt-ht strong { color:#4a4a4a; }
      #lt-root .lt-er { font-size:11px;color:#e74c3c;margin-bottom:8px; }
      #lt-root .lt-sp { display:inline-block;width:11px;height:11px;flex-shrink:0;border:1.5px solid #1e1e1e;border-top-color:#1ed760;border-radius:50%;animation:lt-spin .6s linear infinite; }
      #lt-root .lt-ld { display:flex;align-items:center;gap:8px;font-size:12px;color:#333;margin-bottom:10px; }
      #lt-root .lt-ml { background:#0c0c0c;border:1px solid #1a1a1a;border-radius:8px;padding:8px 11px;margin-bottom:10px; }
      #lt-root .lt-mr { display:flex;align-items:center;gap:7px;font-size:12px;color:#555;padding:3px 0; }
      #lt-root .lt-md { width:5px;height:5px;border-radius:50%;background:#1ed760;flex-shrink:0; }
      #lt-root .lt-ms { font-size:10px;margin-left:auto;font-weight:600; }
      #lt-root .lt-cd { background:#0c0c0c;border:1px solid #1a1a1a;border-radius:8px;padding:10px 11px;font-size:12px;color:#333;line-height:1.6;margin-bottom:10px; }
      #lt-root .lt-cd strong { color:#4a4a4a; }
      #lt-root .lt-ic { display:flex;align-items:center;gap:8px;margin-bottom:12px; }
      #lt-root .lt-iv { font-family:monospace;font-size:18px;font-weight:700;color:#1ed760;letter-spacing:4px; }
      #lt-root .lt-np { background:#0c0c0c;border:1px solid #1a1a1a;border-radius:8px;padding:9px 11px;margin-bottom:10px;display:flex;align-items:center;gap:8px; }
      #lt-root .lt-npd { width:6px;height:6px;border-radius:50%;background:#1ed760;box-shadow:0 0 5px #1ed76077;flex-shrink:0; }
      #lt-root .lt-npt { font-size:11px;color:#555;flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis; }
      #lt-root .lt-bar { position:fixed;bottom:90px;right:16px;z-index:9999;background:#111;border:1px solid #1e1e1e;border-radius:10px;padding:8px 14px;display:flex;align-items:center;gap:8px;font-family:'Circular','Helvetica Neue',Arial,sans-serif;font-size:12px;color:#555;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.6);animation:lt-in .2s ease; }
      #lt-root .lt-bar:hover { background:#161616; }
      #lt-root .lt-bd2 { width:6px;height:6px;border-radius:50%;background:#1ed760;box-shadow:0 0 5px #1ed76077;flex-shrink:0; }
    `;
    document.head.appendChild(el);
  }

  // ─── Panel ────────────────────────────────────────────────────────────────
  function Panel({ onClose }) {
    const getScreen = () => {
      if (!session.active && !session.ws) return "home";
      if (session.amHost && !session.inSession) return "host-wait";
      return "session";
    };

    const [tick,    setTick]    = useState(0);
    const [username,setUsername]= useState(getUsername());
    const [paste,   setPaste]   = useState("");
    const [error,   setError]   = useState("");
    const [loading, setLoading] = useState(false);
    const [track,   setTrack]   = useState("");
    const [syncing, setSyncing] = useState(false);

    const screen = getScreen();
    const e = React.createElement;

    useEffect(() => {
      uiCallback = () => setTick(t => t + 1);
      return () => { uiCallback = null; };
    }, []);

    useEffect(() => {
      const t = setInterval(() => {
        const d = Spicetify.Player.data;
        if (d?.item?.name) setTrack(d.item.name);
      }, 1000);
      return () => clearInterval(t);
    }, []);

    function onName(ev) { setUsername(ev.target.value); saveUsername(ev.target.value); }
    function av() { return (username || "?")[0].toUpperCase(); }
    function copy(t) { navigator.clipboard.writeText(t); Spicetify.showNotification("📋 Copied!"); }

    function pingColor(ms) {
      if (ms == null) return "#555";
      if (ms < 100)   return "#1ed760";
      if (ms < 300)   return "#f0a500";
      return "#e74c3c";
    }

    async function create() {
      setError(""); setLoading(true);
      const code = makeCode();
      connectToRoom(code, username, true, ev => {
        if (ev.type === "connected") { setLoading(false); setTick(t => t+1); }
        if (ev.type === "error")     { setError(ev.msg); setLoading(false); }
        if (ev.type === "timeout")   { setError("Connection timed out."); setLoading(false); }
      });
    }

    async function join() {
      const code = paste.trim().toUpperCase();
      if (code.length !== 6) { setError("Enter a 6-character code."); return; }
      setError(""); setLoading(true);
      connectToRoom(code, username, false, ev => {
        if (ev.type === "connected") { setLoading(false); setTick(t => t+1); }
        if (ev.type === "error")     { setError(ev.msg); setLoading(false); }
        if (ev.type === "timeout")   { setError("Timed out. Is the code correct?"); setLoading(false); }
      });
    }

    function leave() {
      log("User leaving session intentionally");
      session.intentionalClose = true;
      send({ type: "left", user: username });
      cleanup();
      setPaste(""); setError(""); setLoading(false);
    }

    // Manual sync button — guest resyncs to host's current position
    async function manualSync() {
      if (!session.lastHostState) return;
      setSyncing(true);
      // Request fresh state from host
      send({ type: "cmd", cmd: { action: "request_state" } });
      // Fallback: use last known state
      await syncToState(session.lastHostState, "manual");
      setTimeout(() => setSyncing(false), 1000);
    }

    function cmd(action, extra) {
      if (session.amHost) {
        // Host applies directly
        try {
          if (action === "play")  Spicetify.Player.play();
          if (action === "pause") Spicetify.Player.pause();
          if (action === "next")  Spicetify.Player.next();
          if (action === "prev")  Spicetify.Player.back();
        } catch(e) { err("cmd:", e); }
      } else {
        send({ type: "cmd", cmd: { action, ...extra } });
      }
    }

    function Hdr({ dot = false }) {
      return e("div", { className: "lt-hd" },
        e("div", { className: "lt-hl" },
          e("div", { className: `lt-dot ${dot ? "" : "off"}` }),
          e("span", { className: "lt-ttl" }, "CoListen")
        ),
        e("button", { className: "lt-x", onClick: onClose }, "×")
      );
    }

    // ── home ─────────────────────────────────────────────────────────────
    if (screen === "home") return e("div", { className: "lt-panel" },
      e(Hdr, {}),
      e("div", { className: "lt-bd" },
        e("div", { className: "lt-nr" },
          e("div", { className: "lt-av" }, av()),
          e("input", { className: "lt-ni", value: username, placeholder: "Your name", onChange: onName })
        ),
        e("div", { className: "lt-st" },
          e("button", {
            className: `lt-btn lt-g ${loading ? "lt-dim" : ""}`, onClick: create,
          }, loading ? e(React.Fragment, null, e("span", { className: "lt-sp" }), "Setting up…") : "Create session")
        ),
        e("hr", { className: "lt-dv" }),
        e("div", { className: "lt-lb" }, "Join a session"),
        e("input", {
          className: "lt-ci", placeholder: "Enter code", value: paste, maxLength: 6,
          onChange: ev => { setPaste(ev.target.value.toUpperCase()); setError(""); }
        }),
        error && e("div", { className: "lt-er" }, error),
        e("button", {
          className: `lt-btn lt-gh ${(!paste.trim() || loading) ? "lt-dim" : ""}`, onClick: join,
        }, loading ? e(React.Fragment, null, e("span", { className: "lt-spin" }), "Connecting…") : "Join session"),
      )
    );

    // ── host-wait ─────────────────────────────────────────────────────────
    if (screen === "host-wait") return e("div", { className: "lt-panel" },
      e(Hdr, {}),
      e("div", { className: "lt-bd" },
        e("div", { className: "lt-ht" },
          e("strong", null, "Share this code "),
          "with your friends."
        ),
        e("div", { className: "lt-lb" }, "Room code"),
        e("div", { className: "lt-cb" },
          e("span", { className: "lt-cv" }, session.code),
          e("button", { className: "lt-cp", onClick: () => copy(session.code) }, "Copy")
        ),
        session.members.length > 1
          ? e("div", { className: "lt-st", style:{marginTop:4} },
              e("button", { className: "lt-btn lt-g", onClick: () => { session.inSession = true; setTick(t=>t+1); } }, "Go to session →"),
              e("button", { className: "lt-btn lt-gh", onClick: leave }, "Cancel"),
            )
          : e(React.Fragment, null,
              e("div", { className: "lt-ld" }, e("span", { className: "lt-sp" }), "Waiting for friends…"),
              e("button", { className: "lt-btn lt-gh", style:{marginTop:4}, onClick: leave }, "Cancel"),
            ),
      )
    );

    // ── session ───────────────────────────────────────────────────────────
    if (screen === "session") return e("div", { className: "lt-panel" },
      e(Hdr, { dot: true }),
      e("div", { className: "lt-bd" },

        track && e("div", { className: "lt-np" },
          e("div", { className: "lt-npd" }),
          e("div", { className: "lt-npt" }, track)
        ),

        e("div", { className: "lt-ic" },
          e("span", { className: "lt-iv" }, session.code),
          e("button", { className: "lt-cp", onClick: () => copy(session.code) }, "Copy")
        ),

        session.members.length > 0 && e("div", { className: "lt-ml" },
          session.members.map(m => {
            const isMe = m.name === username;
            const ms   = isMe ? session.myLatency : null;
            const col  = pingColor(ms);
            return e("div", { key: m.name, className: "lt-mr" },
              e("div", { className: "lt-md" }), m.name,
              ms != null && e("span", { className: "lt-ms", style: { color: col } }, ms + " ms"),
              isMe && e("span", { style:{ marginLeft: ms != null ? 4 : "auto", fontSize:10, color:"#1ed760" } }, "you"),
              session.amHost && isMe && e("span", { style:{ marginLeft:4, fontSize:10, color:"#555" } }, "· host"),
            );
          })
        ),

        e("div", { className: "lt-st" },
          // Sync button (guest only)
          !session.amHost && e("button", {
            className: `lt-btn lt-sy ${syncing ? "lt-dim" : ""}`,
            onClick: manualSync,
          },
            syncing
              ? e(React.Fragment, null, e("span", { className: "lt-sp" }), "Syncing…")
              : "⟳ Sync now"
          ),

          e("button", { className: "lt-btn lt-lv", onClick: leave },
            e("svg", { width:13, height:13, viewBox:"0 0 24 24", fill:"currentColor" },
              e("path", { d:"M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z" })
            ),
            "Leave session"
          ),
        ),
      )
    );

    return null;
  }

  // ─── Status bar ───────────────────────────────────────────────────────────
  function Bar({ onClick }) {
    const e = React.createElement;
    const track = Spicetify.Player.data?.item?.name || "";
    return e("div", { className: "lt-bar", onClick },
      e("div", { className: "lt-bd2" }),
      track ? `🎵 ${track.slice(0, 28)}${track.length > 28 ? "…" : ""}` : "Session active"
    );
  }

  // ─── Mount ────────────────────────────────────────────────────────────────
  let container = null;
  let isOpen    = false;

  function renderUI() {
    if (!container) {
      container = document.createElement("div");
      container.id = "lt-root";
      document.body.appendChild(container);
    }
    if (isOpen) {
      ReactDOM.render(
        React.createElement(Panel, { onClose: () => { isOpen = false; renderUI(); } }),
        container
      );
      // Apply drag after React renders the panel
      requestAnimationFrame(() => {
        const panel = container.querySelector(".lt-panel");
        if (panel) applyDrag(panel);
      });
    } else if (session.active || session.ws) {
      ReactDOM.render(
        React.createElement(Bar, { onClick: () => { isOpen = true; renderUI(); } }),
        container
      );
    } else {
      ReactDOM.unmountComponentAtNode(container);
    }
  }

  function openPanel() { isOpen = !isOpen; renderUI(); }

  // ─── Topbar ───────────────────────────────────────────────────────────────
  new Spicetify.Topbar.Button("CoListen",
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
      <path d="M12 3C7.03 3 3 7.03 3 12v5a3 3 0 003 3h1a1 1 0 001-1v-5a1 1 0 00-1-1H5v-1c0-3.87 3.13-7 7-7s7 3.13 7 7v1h-2a1 1 0 00-1 1v5a1 1 0 001 1h1a3 3 0 003-3v-5c0-4.97-4.03-9-9-9z"/>
    </svg>`,
    openPanel, false
  );

  log("✅ CoListen loaded");
}