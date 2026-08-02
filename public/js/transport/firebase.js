import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getDatabase,
  ref,
  set,
  update,
  onValue,
  onDisconnect,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js';
import { appConfig } from '../config.js';
import { createHrThrottle, generateRoomCode } from '../util.js';

function assertFirebaseConfig() {
  const cfg = appConfig.firebase || {};
  if (!cfg.apiKey || !cfg.databaseURL || !cfg.projectId) {
    throw new Error('尚未設定 Firebase：請編輯 public/js/config.js（可參考 config.example.js）');
  }
  return cfg;
}

function toMember(clientId, raw) {
  if (!raw) return null;
  return {
    clientId,
    name: raw.name || '匿名',
    role: raw.role || 'viewer',
    bpm: typeof raw.bpm === 'number' ? raw.bpm : null,
    contact: Boolean(raw.contact),
    online: raw.online !== false,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : null,
  };
}

export function createFirebaseTransport() {
  const cfg = assertFirebaseConfig();
  const app = initializeApp(cfg, `miband-${cfg.projectId}`);
  const db = getDatabase(app);

  let roomCode = null;
  let clientId = null;
  let role = null;
  let name = null;
  let membersRef = null;
  let unsubscribe = null;
  let selfRef = null;
  let onRoster = null;

  const sendHr = createHrThrottle(async ({ bpm, contact, ts }) => {
    if (!selfRef || role !== 'publisher') return;
    await update(selfRef, {
      bpm,
      contact,
      online: true,
      updatedAt: ts,
    });
  });

  function emitRoster(snapshotVal) {
    if (!onRoster) return;
    const members = Object.entries(snapshotVal || {})
      .map(([id, raw]) => toMember(id, raw))
      .filter(Boolean);
    onRoster(members);
  }

  return {
    backend: 'firebase',

    async createRoom({ name: creatorName }) {
      const code = generateRoomCode();
      await set(ref(db, `rooms/${code}/meta`), {
        createdAt: Date.now(),
        createdByName: creatorName || '匿名',
      });
      return { roomCode: code };
    },

    async joinRoom({
      roomCode: code,
      role: joinRole,
      name: joinName,
      clientId: id,
      onRoster: rosterCb,
      onError,
    }) {
      roomCode = String(code || '').toUpperCase();
      role = joinRole;
      name = joinName || '匿名';
      clientId = id;
      onRoster = rosterCb;

      if (!roomCode) throw new Error('缺少房間碼');

      selfRef = ref(db, `rooms/${roomCode}/members/${clientId}`);
      membersRef = ref(db, `rooms/${roomCode}/members`);

      const profile = {
        name,
        role,
        bpm: null,
        contact: false,
        online: true,
        updatedAt: Date.now(),
      };

      try {
        await set(selfRef, profile);
        await onDisconnect(selfRef).update({
          online: false,
          updatedAt: serverTimestamp(),
        });

        if (unsubscribe) unsubscribe();
        unsubscribe = onValue(
          membersRef,
          (snap) => emitRoster(snap.val()),
          (err) => onError?.(err.message || String(err)),
        );
      } catch (err) {
        onError?.(err.message || String(err));
        throw err;
      }

      return { roomCode, clientId };
    },

    async publishHr(payload) {
      return sendHr(payload);
    },

    async leaveRoom() {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (selfRef) {
        try {
          await update(selfRef, { online: false, updatedAt: Date.now() });
        } catch {
          /* ignore */
        }
      }
      selfRef = null;
      membersRef = null;
      roomCode = null;
    },

    getShareUrl({ roomCode: code, role: shareRole = 'viewer' }) {
      const page = shareRole === 'publisher' ? 'publish.html' : 'watch.html';
      const url = new URL(page, window.location.href);
      url.searchParams.set('room', code);
      url.searchParams.set('backend', 'firebase');
      return url.toString();
    },
  };
}
