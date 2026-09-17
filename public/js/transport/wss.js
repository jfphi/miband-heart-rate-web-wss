import {
  createHrThrottle,
  createMicThrottle,
  generateRoomCode,
  normalizeContact,
  reconnectDelayMs,
  runWsPingTick,
  WS_PING_INTERVAL_MS,
} from '../util.js';

function resolveWsUrl(cfg) {
  if (cfg?.wsUrl) return cfg.wsUrl;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

function closeSocket(socket) {
  if (!socket) return;
  try {
    if (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING
    ) {
      socket.close();
    }
  } catch {
    /* ignore */
  }
}

function memberFromServer(m) {
  return {
    clientId: m.clientId,
    name: m.name,
    role: m.role,
    bpm: m.bpm ?? null,
    contact: normalizeContact(m.contact),
    db: m.db ?? null,
    soundUpdatedAt: m.soundUpdatedAt ?? null,
    online: m.online !== false,
    updatedAt: m.updatedAt ?? m.ts ?? null,
  };
}

export function createWssTransport(cfg) {
  let ws = null;
  let roomCode = null;
  let clientId = null;
  let role = null;
  let name = null;
  let onRoster = null;
  let onError = null;
  let onStatus = null;
  let members = new Map();
  let openPromise = null;
  let shouldReconnect = false;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  /** Bumped on leave / new join to cancel in-flight reconnect work. */
  let sessionGen = 0;
  let pingTimer = null;
  /** @type {number | null} */
  let lastPongAt = null;

  const sendHr = createHrThrottle(async ({ bpm, contact, ts }) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket 尚未連線');
    }
    ws.send(JSON.stringify({ type: 'hr', bpm, contact, ts }));
  });

  const sendMic = createMicThrottle(async ({ db, ts }) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket 尚未連線');
    }
    ws.send(JSON.stringify({ type: 'mic', db, ts }));
  });

  function clearReconnect() {
    if (reconnectTimer != null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function clearPing() {
    if (pingTimer != null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  function startPing() {
    if (pingTimer != null) return;
    pingTimer = setInterval(() => {
      const socket = ws;
      if (!socket) return;
      runWsPingTick({
        readyState: socket.readyState,
        lastPongAt,
        sendPing: () => {
          socket.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
        },
        close: () => closeSocket(socket),
      });
    }, WS_PING_INTERVAL_MS);
  }

  function notePong() {
    lastPongAt = Date.now();
  }

  function isSession(gen) {
    return gen === sessionGen && shouldReconnect;
  }

  function send(msg) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket 尚未連線');
    }
    ws.send(JSON.stringify(msg));
  }

  function trySend(msg) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  function sendJoin() {
    send({
      type: 'join',
      room: roomCode,
      role,
      name,
      clientId,
    });
  }

  function emitRoster() {
    if (!onRoster) return;
    onRoster(Array.from(members.values()));
  }

  function markSelfOffline() {
    if (!clientId) return;
    const self = members.get(clientId);
    if (self) {
      members.set(clientId, { ...self, online: false, updatedAt: Date.now() });
      emitRoster();
    }
  }

  function upsertMember(partial) {
    const prev = members.get(partial.clientId) || {
      clientId: partial.clientId,
      name: '匿名',
      role: 'viewer',
      bpm: null,
      contact: null,
      db: null,
      soundUpdatedAt: null,
      online: true,
      updatedAt: null,
    };
    const next = { ...prev, ...partial };
    if (Object.prototype.hasOwnProperty.call(partial, 'contact')) {
      next.contact = normalizeContact(partial.contact);
    }
    members.set(partial.clientId, next);
    emitRoster();
  }

  function haltPublishing() {
    sendHr.stopKeepalive();
    sendMic.stopKeepalive();
    sendHr.pause();
    sendMic.pause();
    sendMic.reset();
  }

  function handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      onError?.('無法解析伺服器訊息');
      return;
    }

    switch (msg.type) {
      case 'joined': {
        members.clear();
        (msg.members || []).forEach((m) => {
          members.set(m.clientId, memberFromServer(m));
        });
        emitRoster();
        onStatus?.('connected', '房間已連線');
        if (role === 'publisher') {
          void sendHr.flush().catch(() => {});
          void sendMic.flush().catch(() => {});
        }
        break;
      }
      case 'roster': {
        if (msg.action === 'leave' || msg.action === 'offline') {
          const existing = members.get(msg.clientId);
          if (existing) {
            members.set(msg.clientId, {
              ...existing,
              online: false,
              updatedAt: msg.updatedAt ?? msg.ts ?? Date.now(),
            });
          }
        } else if (msg.member) {
          upsertMember(memberFromServer(msg.member));
        }
        emitRoster();
        break;
      }
      case 'hr': {
        const cleared = Boolean(msg.cleared) || msg.bpm == null;
        upsertMember({
          clientId: msg.clientId,
          name: msg.name,
          role: 'publisher',
          bpm: cleared ? null : msg.bpm,
          contact: normalizeContact(msg.contact),
          online: true,
          updatedAt: msg.ts ?? Date.now(),
        });
        break;
      }
      case 'mic': {
        const cleared = Boolean(msg.cleared);
        upsertMember({
          clientId: msg.clientId,
          name: msg.name,
          role: 'publisher',
          db: cleared ? null : (msg.db ?? null),
          soundUpdatedAt: msg.ts ?? null,
          online: true,
        });
        break;
      }
      case 'session_replaced': {
        shouldReconnect = false;
        haltPublishing();
        onStatus?.('replaced', msg.message || '連線已由其他分頁取代');
        break;
      }
      case 'pong':
        notePong();
        break;
      case 'error':
        onError?.(msg.message || '伺服器錯誤');
        break;
      default:
        break;
    }
  }

  function scheduleReconnect(gen) {
    if (!isSession(gen) || !roomCode || !clientId) return;
    clearReconnect();
    const delay = reconnectDelayMs(reconnectAttempt);
    reconnectAttempt += 1;
    onStatus?.('reconnecting', '連線中斷，重連中…');

    reconnectTimer = setTimeout(async () => {
      if (!isSession(gen) || !roomCode || !clientId) return;
      try {
        if (ws && ws.readyState === WebSocket.CLOSED) ws = null;
        openPromise = null;
        await connect(gen);
        if (!isSession(gen)) {
          closeSocket(ws);
          ws = null;
          openPromise = null;
          return;
        }
        sendJoin();
        reconnectAttempt = 0;
      } catch {
        // Async socket failures reschedule via `close` only.
      }
    }, delay);
  }

  function connect(gen) {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return openPromise || Promise.resolve();
    }

    const url = resolveWsUrl(cfg);
    let socket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      // Constructor sync throw never emits close — schedule once here.
      if (isSession(gen)) {
        queueMicrotask(() => {
          if (isSession(gen) && !ws) scheduleReconnect(gen);
        });
      }
      return Promise.reject(err);
    }

    ws = socket;
    openPromise = new Promise((resolve, reject) => {
      let settled = false;

      socket.addEventListener('open', () => {
        if (!isSession(gen)) {
          settled = true;
          closeSocket(socket);
          reject(new Error('連線已取消'));
          return;
        }
        settled = true;
        lastPongAt = Date.now();
        try {
          socket.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
        } catch {
          /* ignore */
        }
        resolve();
      });
      socket.addEventListener('message', (ev) => {
        if (ws !== socket || gen !== sessionGen) return;
        handleMessage(ev.data);
      });
      socket.addEventListener('error', () => {
        if (!settled) {
          settled = true;
          reject(new Error(`無法連線到 ${url}`));
        }
        if (isSession(gen) && ws === socket) {
          onStatus?.('reconnecting', '連線中斷，重連中…');
        }
      });
      socket.addEventListener('close', () => {
        const isActiveSocket = ws === socket;
        if (isActiveSocket) {
          ws = null;
          openPromise = null;
        }
        if (isActiveSocket && gen === sessionGen) {
          markSelfOffline();
        }
        if (!settled) {
          settled = true;
          reject(new Error(`無法連線到 ${url}`));
        }
        // Only the live socket may arm reconnect — stale sockets must not fight it.
        if (isActiveSocket && isSession(gen)) {
          scheduleReconnect(gen);
        }
      });
    });

    return openPromise;
  }

  function startPublisherKeepalives() {
    if (role !== 'publisher') return;
    const canSend = () => Boolean(ws) && ws.readyState === WebSocket.OPEN;
    sendHr.startKeepalive(canSend, (err) => onError?.(err?.message || String(err)));
    sendMic.startKeepalive(canSend, (err) => onError?.(err?.message || String(err)));
  }

  return {
    backend: 'wss',

    async createRoom() {
      return { roomCode: generateRoomCode() };
    },

    async joinRoom({
      roomCode: code,
      role: joinRole,
      name: joinName,
      clientId: id,
      onRoster: rosterCb,
      onError: errorCb,
      onStatus: statusCb,
    }) {
      // Invalidate any prior session / in-flight reconnect before starting fresh.
      shouldReconnect = false;
      clearReconnect();
      sendHr.stopKeepalive();
      sendMic.stopKeepalive();
      sendMic.reset();
      clearPing();
      lastPongAt = null;
      closeSocket(ws);
      ws = null;
      openPromise = null;

      sessionGen += 1;
      const gen = sessionGen;

      roomCode = String(code || '').toUpperCase();
      role = joinRole;
      name = joinName || '匿名';
      clientId = id;
      onRoster = rosterCb;
      onError = errorCb;
      onStatus = statusCb;
      shouldReconnect = true;
      reconnectAttempt = 0;
      members.clear();

      if (!roomCode) throw new Error('缺少房間碼');

      startPing();
      startPublisherKeepalives();

      onStatus?.('connecting', '加入房間中…');
      try {
        await connect(gen);
      } catch (err) {
        if (!isSession(gen)) {
          closeSocket(ws);
          ws = null;
          throw new Error('連線已取消');
        }
        // Background reconnect is armed (close or constructor path).
        onStatus?.('reconnecting', '連線中斷，重連中…');
        return { roomCode, clientId };
      }

      if (!isSession(gen)) {
        closeSocket(ws);
        ws = null;
        throw new Error('連線已取消');
      }
      try {
        sendJoin();
      } catch {
        if (!isSession(gen)) throw new Error('連線已取消');
        onStatus?.('reconnecting', '連線中斷，重連中…');
        return { roomCode, clientId };
      }

      return { roomCode, clientId };
    },

    async publishHr(payload) {
      if (role !== 'publisher') return false;
      return sendHr({
        bpm: payload.bpm,
        contact: payload.contact,
        ts: payload.ts,
      });
    },

    pauseHr() {
      sendHr.pause();
    },

    resumeHr() {
      return sendHr.resume();
    },

    clearHr() {
      sendHr.pause();
      trySend({ type: 'hr_clear' });
    },

    async publishMic(payload) {
      if (role !== 'publisher') return false;
      return sendMic({ db: payload.db, ts: payload.ts });
    },

    pauseMic() {
      sendMic.pause();
    },

    resumeMic() {
      return sendMic.resume();
    },

    clearMic() {
      sendMic.reset();
      sendMic.pause();
      trySend({ type: 'mic_clear' });
    },

    async leaveRoom() {
      shouldReconnect = false;
      sessionGen += 1;
      clearReconnect();
      clearPing();
      sendHr.stopKeepalive();
      sendMic.stopKeepalive();
      sendMic.reset();
      lastPongAt = null;

      const socket = ws;
      try {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'leave' }));
        }
      } catch {
        /* ignore */
      }
      closeSocket(socket);

      ws = null;
      openPromise = null;
      members.clear();
      roomCode = null;
      clientId = null;
      reconnectAttempt = 0;
    },

    getShareUrl({ roomCode: code, role: shareRole = 'viewer' }) {
      const page = shareRole === 'publisher' ? 'publish.html' : 'watch.html';
      const url = new URL(page, window.location.href);
      url.searchParams.set('room', code);
      return url.toString();
    },
  };
}
