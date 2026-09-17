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
import { createHrThrottle, createMicThrottle, generateRoomCode, normalizeContact } from '../util.js';

function assertFirebaseConfig(cfg) {
  const firebase = cfg?.firebase || {};
  if (!firebase.apiKey || !firebase.databaseURL || !firebase.projectId) {
    throw new Error('尚未在 .env 設定 Firebase（MIBAND_FIREBASE_*）');
  }
  return firebase;
}

function toMember(clientId, raw) {
  if (!raw) return null;
  return {
    clientId,
    name: raw.name || '匿名',
    role: raw.role || 'viewer',
    bpm: typeof raw.bpm === 'number' ? raw.bpm : null,
    contact: normalizeContact(raw.contact),
    db: typeof raw.db === 'number' ? raw.db : null,
    soundUpdatedAt: typeof raw.soundUpdatedAt === 'number' ? raw.soundUpdatedAt : null,
    online: raw.online !== false,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : null,
  };
}

export function createFirebaseTransport(cfg) {
  const firebaseCfg = assertFirebaseConfig(cfg);
  const app = initializeApp(firebaseCfg, `miband-${firebaseCfg.projectId}`);
  const db = getDatabase(app);

  let roomCode = null;
  let clientId = null;
  let role = null;
  let name = null;
  let membersRef = null;
  let unsubscribe = null;
  let selfRef = null;
  let onRoster = null;
  let onStatus = null;

  const sendHr = createHrThrottle(async ({ bpm, contact, ts }) => {
    if (!selfRef || role !== 'publisher') {
      throw new Error('Firebase 尚未就緒');
    }
    await update(selfRef, {
      bpm,
      contact,
      online: true,
      updatedAt: serverTimestamp(),
    });
  });

  const sendMic = createMicThrottle(async ({ db, ts }) => {
    if (!selfRef || role !== 'publisher') {
      throw new Error('Firebase 尚未就緒');
    }
    await update(selfRef, {
      db,
      soundUpdatedAt: serverTimestamp(),
      online: true,
    });
  });

  function emitRoster(snapshotVal) {
    if (!onRoster) return;
    const members = Object.entries(snapshotVal || {})
      .map(([id, raw]) => toMember(id, raw))
      .filter(Boolean);
    onRoster(members);
  }

  function startPublisherKeepalives(onError) {
    if (role !== 'publisher') return;
    sendHr.startKeepalive(
      () => Boolean(selfRef),
      (err) => onError?.(err?.message || String(err)),
    );
    sendMic.startKeepalive(
      () => Boolean(selfRef),
      (err) => onError?.(err?.message || String(err)),
    );
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
      onStatus: statusCb,
    }) {
      sendHr.stopKeepalive();
      sendMic.stopKeepalive();
      sendMic.reset();

      roomCode = String(code || '').toUpperCase();
      role = joinRole;
      name = joinName || '匿名';
      clientId = id;
      onRoster = rosterCb;
      onStatus = statusCb;

      if (!roomCode) throw new Error('缺少房間碼');

      selfRef = ref(db, `rooms/${roomCode}/members/${clientId}`);
      membersRef = ref(db, `rooms/${roomCode}/members`);

      const profile = {
        name,
        role,
        bpm: null,
        contact: null,
        db: null,
        soundUpdatedAt: null,
        online: true,
        updatedAt: Date.now(),
      };

      onStatus?.('connecting', '加入房間中…');
      try {
        await set(selfRef, profile);
        await onDisconnect(selfRef).update({
          online: false,
          updatedAt: serverTimestamp(),
          bpm: null,
          contact: null,
          db: null,
        });

        if (unsubscribe) unsubscribe();
        unsubscribe = onValue(
          membersRef,
          (snap) => emitRoster(snap.val()),
          (err) => onError?.(err.message || String(err)),
        );

        startPublisherKeepalives(onError);
        onStatus?.('connected', '房間已連線');
      } catch (err) {
        onStatus?.('error', '無法加入房間');
        onError?.(err.message || String(err));
        throw err;
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

    async clearHr() {
      sendHr.pause();
      if (!selfRef || role !== 'publisher') return;
      try {
        await update(selfRef, {
          bpm: null,
          contact: null,
          online: true,
          updatedAt: serverTimestamp(),
        });
      } catch {
        /* ignore */
      }
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

    async clearMic() {
      sendMic.reset();
      sendMic.pause();
      if (!selfRef || role !== 'publisher') return;
      try {
        await update(selfRef, {
          db: null,
          soundUpdatedAt: serverTimestamp(),
          online: true,
        });
      } catch {
        /* ignore */
      }
    },

    async leaveRoom() {
      sendHr.stopKeepalive();
      sendMic.stopKeepalive();
      sendMic.reset();
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (selfRef) {
        try {
          await update(selfRef, {
            online: false,
            updatedAt: serverTimestamp(),
            bpm: null,
            contact: null,
            db: null,
          });
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
      return url.toString();
    },
  };
}
