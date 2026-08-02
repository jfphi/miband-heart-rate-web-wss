import { createHrThrottle, generateRoomCode } from '../util.js';

function resolveWsUrl(cfg) {
  if (cfg?.wsUrl) return cfg.wsUrl;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

export function createWssTransport(cfg) {
  let ws = null;
  let roomCode = null;
  let clientId = null;
  let role = null;
  let name = null;
  let onRoster = null;
  let onError = null;
  let members = new Map();
  let openPromise = null;

  const sendHr = createHrThrottle(async ({ bpm, contact, ts }) => {
    send({ type: 'hr', bpm, contact, ts });
  });

  function send(msg) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket 尚未連線');
    }
    ws.send(JSON.stringify(msg));
  }

  function emitRoster() {
    if (!onRoster) return;
    onRoster(Array.from(members.values()));
  }

  function upsertMember(partial) {
    const prev = members.get(partial.clientId) || {
      clientId: partial.clientId,
      name: '匿名',
      role: 'viewer',
      bpm: null,
      contact: false,
      online: true,
      updatedAt: null,
    };
    members.set(partial.clientId, { ...prev, ...partial });
    emitRoster();
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
          members.set(m.clientId, {
            clientId: m.clientId,
            name: m.name,
            role: m.role,
            bpm: m.bpm ?? null,
            contact: Boolean(m.contact),
            online: m.online !== false,
            updatedAt: m.updatedAt ?? null,
          });
        });
        emitRoster();
        break;
      }
      case 'roster': {
        if (msg.action === 'leave' || msg.action === 'offline') {
          const existing = members.get(msg.clientId);
          if (existing) {
            members.set(msg.clientId, {
              ...existing,
              online: false,
              updatedAt: msg.updatedAt ?? Date.now(),
            });
          }
        } else if (msg.member) {
          upsertMember(msg.member);
        }
        emitRoster();
        break;
      }
      case 'hr': {
        upsertMember({
          clientId: msg.clientId,
          name: msg.name,
          role: 'publisher',
          bpm: msg.bpm,
          contact: Boolean(msg.contact),
          online: true,
          updatedAt: msg.ts ?? Date.now(),
        });
        break;
      }
      case 'error':
        onError?.(msg.message || '伺服器錯誤');
        break;
      default:
        break;
    }
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return openPromise || Promise.resolve();
    }

    openPromise = new Promise((resolve, reject) => {
      const url = resolveWsUrl(cfg);
      ws = new WebSocket(url);

      ws.addEventListener('open', () => resolve());
      ws.addEventListener('message', (ev) => handleMessage(ev.data));
      ws.addEventListener('error', () => {
        onError?.(`無法連線到 ${url}`);
        reject(new Error(`無法連線到 ${url}`));
      });
      ws.addEventListener('close', () => {
        if (clientId) {
          const self = members.get(clientId);
          if (self) {
            members.set(clientId, { ...self, online: false, updatedAt: Date.now() });
            emitRoster();
          }
        }
      });
    });

    return openPromise;
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
    }) {
      roomCode = String(code || '').toUpperCase();
      role = joinRole;
      name = joinName || '匿名';
      clientId = id;
      onRoster = rosterCb;
      onError = errorCb;

      if (!roomCode) throw new Error('缺少房間碼');

      await connect();
      send({
        type: 'join',
        room: roomCode,
        role,
        name,
        clientId,
      });

      return { roomCode, clientId };
    },

    async publishHr(payload) {
      if (role !== 'publisher') return false;
      return sendHr(payload);
    },

    async leaveRoom() {
      try {
        if (ws && ws.readyState === WebSocket.OPEN) {
          send({ type: 'leave' });
          ws.close();
        }
      } catch {
        /* ignore */
      }
      ws = null;
      openPromise = null;
      members.clear();
      roomCode = null;
    },

    getShareUrl({ roomCode: code, role: shareRole = 'viewer' }) {
      const page = shareRole === 'publisher' ? 'publish.html' : 'watch.html';
      const url = new URL(page, window.location.href);
      url.searchParams.set('room', code);
      return url.toString();
    },
  };
}
