// Listen Together - Spicetify Extension
// Uses Cloudflare Worker WebSocket server for reliable sync

(function listenTogether() {
  if (!Spicetify.Player || !Spicetify.Platform || !Spicetify.React || !Spicetify.ReactDOM) {
    setTimeout(listenTogether, 300);
    return;
  }
  main();
})();

function main() {
  const { React, ReactDOM } = Spicetify;
  const { useState, useEffect } = React;

  // ─── Config ───────────────────────────────────────────────────────────────
  const STORAGE_KEY  = "listenTogether:username";
  const SERVER_URL   = "wss://lt-server.sermysergio.workers.dev";
  const SYNC_MS      = 2000;
  const SEEK_THRESH  = 8000;
  const SEEK_COOL    = 5000;
  const TRACK_COOL   = 3000;

  // ─── Global session state ─────────────────────────────────────────────────
  const session = {
    ws:          null,   // WebSocket connection to server
    amHost:      false,
    active:      false,
    code:        "",
    members:     [],     // [{ name }]
    myLatency:   null,
    pingMap:     {},     // ts → resolve fn
    pingTimer:   null,
    syncTimer:   null,
    applying:    false,
    lastSeekAt:  0,
    lastTrackAt: 0,
  };

  let uiCallback = null;
  function notifyUI() { uiCallback?.(); }

  const log = (...a) => console.log("[LT]", ...a);
  const err = (...a) => console.error("[LT]", ...a);

  const getUsername  = () => Spicetify.LocalStorage.get(STORAGE_KEY) || "Me";
  const saveUsername = (n) => Spicetify.LocalStorage.set(STORAGE_KEY, n);

  function makeCode() {
    const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    return Array.from({ length: 6 }, () => c[Math.floor(Math.random() * c.length)]).join("");
  }

  // ─── Send via WebSocket ───────────────────────────────────────────────────
  function send(msg) {
    if (session.ws?.readyState === WebSocket.OPEN) {
      try { session.ws.send(JSON.stringify(msg)); } catch(e) { err("send:", e); }
    }
  }

  // ─── Player helpers ───────────────────────────────────────────────────────
  function getState() {
    try {
      const d = Spicetify.Player.data;
      if (!d?.item) return null;
      return {
        uri:       d.item.uri,
        name:      d.item.name || "",
        position:  Spicetify.Player.getProgress(),
        isPlaying: Spicetify.Player.isPlaying,
        ts:        Date.now(),
      };
    } catch { return null; }
  }

  async function playUri(uri, pos) {
    const fns = [
      () => Spicetify.Platform.PlayerAPI.play({ uri }, {}, { positionMs: pos }),
      () => Spicetify.CosmosAsync.put("sp://player/v2/main", { playing_uri: uri, position: pos }),
    ];
    for (const fn of fns) {
      try { await fn(); return; } catch {}
    }
    err("playUri failed:", uri);
  }

  // ─── Apply host state ─────────────────────────────────────────────────────
  async function applyHostState(s) {
    if (!s?.uri || session.applying) return;
    if (Date.now() - s.ts > 10000) return;
    session.applying = true;
    try {
      const cur = getState();
      if (!cur) return;

      if (cur.uri !== s.uri) {
        log("Track →", s.name);
        session.lastTrackAt = Date.now();
        await playUri(s.uri, s.position);
        await new Promise(r => setTimeout(r, 1500));
        return;
      }

      const now         = Date.now();
      const canSeek     = (now - session.lastSeekAt) > SEEK_COOL &&
                          (now - session.lastTrackAt) > TRACK_COOL;

      if (canSeek) {
        const latency  = Math.min(now - s.ts, 2000);
        const expected = s.position + latency;
        const drift    = Math.abs(Spicetify.Player.getProgress() - expected);
        if (drift > SEEK_THRESH) {
          log("Seek — drift:", Math.round(drift), "ms");
          session.lastSeekAt = now;
          Spicetify.Player.seek(expected);
          await new Promise(r => setTimeout(r, 500));
        }
      }

      const playing = Spicetify.Player.isPlaying;
      if (s.isPlaying  && !playing) Spicetify.Player.play();
      if (!s.isPlaying &&  playing) Spicetify.Player.pause();

    } catch(e) { err("applyHostState:", e); }
    finally { session.applying = false; }
  }

  // ─── Apply guest command (host only) ─────────────────────────────────────
  async function applyCommand(cmd) {
    log("cmd:", cmd.action);
    try {
      if (cmd.action === "play")  Spicetify.Player.play();
      if (cmd.action === "pause") Spicetify.Player.pause();
      if (cmd.action === "next")  Spicetify.Player.next();
      if (cmd.action === "prev")  Spicetify.Player.back();
      if (cmd.action === "seek")  Spicetify.Player.seek(cmd.pos);
    } catch(e) { err("applyCommand:", e); }
    setTimeout(() => { const s = getState(); if (s) send({ type: "state", state: s }); }, 200);
  }

  // ─── Host heartbeat ───────────────────────────────────────────────────────
  function startSync() {
    stopSync();
    session.syncTimer = setInterval(() => {
      if (!session.active || !session.amHost) return;
      const s = getState();
      if (s) send({ type: "state", state: s });
      // Ping to measure latency
      const now = Date.now();
      session.pingMap[now] = (rtt) => { session.myLatency = rtt; notifyUI(); };
      send({ type: "ping", id: now });
    }, SYNC_MS);
  }

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

  function stopSync() {
    if (session.syncTimer) { clearInterval(session.syncTimer); session.syncTimer = null; }
    if (session.pingTimer) { clearInterval(session.pingTimer); session.pingTimer = null; }
  }

  // ─── Handle incoming messages ─────────────────────────────────────────────
  function onMessage(msg) {
    if (!msg?.type) return;

    if (msg.type === "state" && !session.amHost) {
      applyHostState(msg.state);
      return;
    }

    if (msg.type === "cmd" && session.amHost) {
      applyCommand(msg.cmd);
      return;
    }

    if (msg.type === "ping") {
      send({ type: "pong", id: msg.id });
      return;
    }

    if (msg.type === "pong") {
      const resolve = session.pingMap[msg.id];
      if (resolve) { resolve(Date.now() - msg.id); delete session.pingMap[msg.id]; }
      return;
    }

    if (msg.type === "joined") {
      if (!session.members.find(m => m.name === msg.user)) {
        session.members.push({ name: msg.user });
      }
      Spicetify.showNotification(`🎵 ${msg.user} joined`);
      // If we're host, send current state immediately
      if (session.amHost) {
        setTimeout(() => { const s = getState(); if (s) send({ type: "state", state: s }); }, 300);
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
      // Initial member list sent by server on join
      session.members = msg.members.map(name => ({ name }));
      notifyUI();
      return;
    }
  }

  // ─── Connect to room ──────────────────────────────────────────────────────
  function connectToRoom(code, username, asHost, onProgress) {
    const url = `${SERVER_URL}/room/${code}?name=${encodeURIComponent(username)}`;
    log("Connecting to:", url);

    const ws = new WebSocket(url);
    session.ws = ws;

    const timeout = setTimeout(() => {
      if (!session.active) {
        onProgress({ type: "timeout" });
        cleanup();
      }
    }, 15000);

    ws.onopen = () => {
      clearTimeout(timeout);
      log("WS open");
      session.active = true;
      session.amHost = asHost;
      session.code   = code;
      if (!session.members.find(m => m.name === username)) {
        session.members.push({ name: username });
      }
      if (asHost) {
        startSync();
      } else {
        startGuestPing();
      }
      onProgress({ type: "connected" });
      notifyUI();
    };

    ws.onmessage = (ev) => {
      try { onMessage(JSON.parse(ev.data)); } catch(e) { err("parse:", e); }
    };

    ws.onclose = () => {
      log("WS closed");
      if (session.active) {
        cleanup();
        renderUI();
        Spicetify.showNotification("Session ended");
      }
    };

    ws.onerror = (e) => {
      err("WS error:", e);
      clearTimeout(timeout);
      onProgress({ type: "error", msg: "Connection failed." });
      cleanup();
    };
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────
  function cleanup() {
    stopSync();
    session.active    = false;
    session.applying  = false;
    session.myLatency = null;
    session.pingMap   = {};
    session.members   = [];
    session.code      = "";
    session.amHost    = false;
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
      }
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
      if (session.active && session.amHost && session.members.length <= 1) return "host-wait";
      return "session";
    };

    const [tick,    setTick]    = useState(0);
    const [username,setUsername]= useState(getUsername());
    const [paste,   setPaste]   = useState("");
    const [error,   setError]   = useState("");
    const [loading, setLoading] = useState(false);
    const [track,   setTrack]   = useState("");

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
      try {
        connectToRoom(code, username, true, ev => {
          if (ev.type === "connected") { setLoading(false); setTick(t => t+1); }
          if (ev.type === "error")     { setError(ev.msg); setLoading(false); }
          if (ev.type === "timeout")   { setError("Connection timed out."); setLoading(false); }
        });
      } catch(ex) {
        setError("Could not connect."); setLoading(false);
      }
    }

    async function join() {
      const code = paste.trim().toUpperCase();
      if (code.length !== 6) { setError("Enter a 6-character code."); return; }
      setError(""); setLoading(true);
      try {
        connectToRoom(code, username, false, ev => {
          if (ev.type === "connected") { setLoading(false); setTick(t => t+1); }
          if (ev.type === "error")     { setError(ev.msg); setLoading(false); }
          if (ev.type === "timeout")   { setError("Timed out. Is the code correct?"); setLoading(false); }
        });
      } catch(ex) {
        setError("Could not connect."); setLoading(false);
      }
    }

    function leave() {
      send({ type: "left", user: username });
      cleanup();
      setPaste(""); setError(""); setLoading(false);
    }

    function cmd(action, extra) {
      if (session.amHost) applyCommand({ action, ...extra });
      else send({ type: "cmd", cmd: { action, ...extra } });
    }

    function Hdr({ dot = false }) {
      return e("div", { className: "lt-hd" },
        e("div", { className: "lt-hl" },
          e("div", { className: `lt-dot ${dot ? "" : "off"}` }),
          e("span", { className: "lt-ttl" }, "Listen Together")
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
        }, loading ? e(React.Fragment, null, e("span", { className: "lt-sp" }), "Connecting…") : "Join session"),
      )
    );

    // ── host-wait ─────────────────────────────────────────────────────────
    if (screen === "host-wait") return e("div", { className: "lt-panel" },
      e(Hdr, {}),
      e("div", { className: "lt-bd" },
        e("div", { className: "lt-ht" },
          e("strong", null, "Share this code "),
          "with your friends. Everyone can control playback."
        ),
        e("div", { className: "lt-lb" }, "Room code"),
        e("div", { className: "lt-cb" },
          e("span", { className: "lt-cv" }, session.code),
          e("button", { className: "lt-cp", onClick: () => copy(session.code) }, "Copy")
        ),
        e("div", { className: "lt-ld" }, e("span", { className: "lt-sp" }), "Waiting for friends…"),
        e("button", { className: "lt-btn lt-gh", style:{marginTop:4}, onClick: leave }, "Cancel"),
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

        e("div", { className: "lt-cd" },
          e("strong", null, "Everyone controls. "),
          session.amHost ? "You're the host." : "Use the controls below."
        ),

        !session.amHost && e("div", { style: { display:"flex", gap:6, marginBottom:10 } },
          [["⏮","prev"],["⏸","pause"],["▶","play"],["⏭","next"]].map(([icon, action]) =>
            e("button", {
              key: action,
              style: { flex:1, padding:"8px 0", background:"#1a1a1a", border:"1px solid #2a2a2a", borderRadius:8, color:"#888", cursor:"pointer", fontSize:14 },
              onClick: () => cmd(action),
            }, icon)
          )
        ),

        e("button", { className: "lt-btn lt-lv", onClick: leave },
          e("svg", { width:13, height:13, viewBox:"0 0 24 24", fill:"currentColor" },
            e("path", { d:"M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z" })
          ),
          "Leave session"
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

  // ─── Topbar button ────────────────────────────────────────────────────────
  new Spicetify.Topbar.Button("Listen Together",
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
      <path d="M12 3C7.03 3 3 7.03 3 12v5a3 3 0 003 3h1a1 1 0 001-1v-5a1 1 0 00-1-1H5v-1c0-3.87 3.13-7 7-7s7 3.13 7 7v1h-2a1 1 0 00-1 1v5a1 1 0 001 1h1a3 3 0 003-3v-5c0-4.97-4.03-9-9-9z"/>
    </svg>`,
    openPanel, false
  );

  log("✅ Loaded — Cloudflare edition");
}
