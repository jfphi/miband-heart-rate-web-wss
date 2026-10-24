import { createMicLevel, isMicSupported } from './audio/micLevel.js';
import {
  hasPersistedBleSession,
  errorText,
  isCancelledError,
  mapBleUiStatus,
  MiBandBle,
} from './ble.js';
import { formatDisplayVersion, loadConfig } from './config.js';
import { mountLiveReadout } from './live-readout.js';
import { mountLovensePanel } from './lovense-panel.js';
import { createTransport } from './transport/index.js';
import { getOrCreateClientId, parseQuery } from './util.js';

const qs = parseQuery();
const room = (qs.get('room') || '').toUpperCase();
const name = qs.get('name') || '匿名';

const el = {
  roomCode: document.getElementById('roomCode'),
  backendLabel: document.getElementById('backendLabel'),
  appVersion: document.getElementById('appVersion'),
  roomStatus: document.getElementById('roomStatus'),
  bleStatus: document.getElementById('bleStatus'),
  rosterMeta: document.getElementById('rosterMeta'),
  error: document.getElementById('error'),
  connectBle: document.getElementById('connectBle'),
  disconnectBle: document.getElementById('disconnectBle'),
  copyLink: document.getElementById('copyLink'),
  openMic: document.getElementById('openMic'),
  stopMic: document.getElementById('stopMic'),
};

const readout = mountLiveReadout(document.getElementById('liveReadout'));
readout.setName(name);

el.roomCode.textContent = room || '------';

function setStatus(node, kind, text) {
  node.className = `status ${kind}`;
  node.textContent = text;
}

function showError(msg) {
  const text = errorText(msg);
  if (!text || isCancelledError(msg) || isCancelledError(text)) {
    el.error.hidden = true;
    el.error.textContent = '';
    return;
  }
  el.error.hidden = false;
  el.error.textContent = text;
}

function syncBleConnectLabel() {
  el.connectBle.textContent = hasPersistedBleSession() ? '重新連線' : '連接小米手環';
}

if (!room) {
  showError('缺少房間碼，請從首頁建立房間');
  el.connectBle.disabled = true;
}

let transport = null;
const clientId = getOrCreateClientId();
let allowMicPublish = false;
let bucketDb = null;
let bucketTimer = null;
const micSupported = isMicSupported();

function clearLocalHr({ remote = false } = {}) {
  readout.clearHr();
  if (remote) {
    try {
      transport?.clearHr?.();
    } catch {
      /* ignore */
    }
  }
}

function syncMicButtons(status) {
  const active = status === 'listening' || status === 'requesting';
  el.openMic.disabled = !micSupported || active;
  el.stopMic.disabled = !active;
}

function stopMicBucket() {
  if (bucketTimer != null) {
    clearInterval(bucketTimer);
    bucketTimer = null;
  }
  bucketDb = null;
}

async function flushMicBucket() {
  if (bucketDb == null || !allowMicPublish) return;
  const db = bucketDb;
  const ts = Date.now();
  let published = false;
  try {
    const pending = transport?.publishMic?.({ db, ts });
    published = pending && typeof pending.then === 'function' ? await pending : Boolean(pending);
  } catch (err) {
    showError(err.message || String(err));
    return;
  }
  if (published && bucketDb === db) bucketDb = null;
}

function startMicBucket() {
  if (bucketTimer != null) return;
  bucketTimer = setInterval(() => {
    void flushMicBucket();
  }, 50);
}

function haltMic({ remote = false } = {}) {
  allowMicPublish = false;
  stopMicBucket();
  mic.stop();
  readout.clearLevel();
  if (remote) {
    try {
      transport?.clearMic?.();
    } catch {
      /* ignore */
    }
  } else {
    transport?.pauseMic?.();
  }
}

async function haltSensors({ forgetBle = true } = {}) {
  clearLocalHr({ remote: true });
  haltMic({ remote: true });
  try {
    await ble.disconnect?.({ forget: forgetBle });
  } catch {
    /* ignore */
  }
  el.connectBle.disabled = false;
  el.disconnectBle.disabled = true;
  syncBleConnectLabel();
}

syncBleConnectLabel();
if (!micSupported) {
  el.openMic.disabled = true;
  readout.setMicStatus('error', '此瀏覽器不支援麥克風音量偵測');
}

const mic = createMicLevel({
  onLevel: (db) => {
    if (!allowMicPublish) return;
    readout.pushLevel(db, Date.now());
    if (bucketDb == null || db > bucketDb) bucketDb = db;
  },
  onStatus: (status, text) => {
    readout.setMicStatus(status, text);
    syncMicButtons(status);
    if (status === 'listening') showError('');
  },
  onError: (msg) => showError(msg),
});

const ble = new MiBandBle({
  onHeartRate: async ({ bpm, contact }) => {
    const ts = Date.now();
    readout.pushHr(bpm, ts);
    readout.setContact(contact);
    try {
      await transport?.publishHr({ bpm, contact, ts });
    } catch (err) {
      showError(err.message || String(err));
    }
  },
  onStatus: (kind, text) => {
    const mapped = mapBleUiStatus(kind, text);
    if (mapped.uiText) {
      setStatus(el.bleStatus, mapped.uiKind, mapped.uiText);
    }
    if (mapped.hr === 'resume') {
      const resumed = transport?.resumeHr();
      if (resumed && typeof resumed.then === 'function') {
        void resumed.catch((err) => showError(err.message || String(err)));
      }
    } else if (mapped.hr === 'pause') {
      transport?.pauseHr();
      if (kind === 'disconnected' || kind === 'idle' || kind === 'hr-failed') {
        clearLocalHr({ remote: true });
      }
    }
  },
  onError: (msg) => showError(msg),
});

async function connectOrRestore({ allowPicker = true } = {}) {
  showError('');
  el.connectBle.disabled = true;
  try {
    let restored = false;
    if (hasPersistedBleSession() && typeof ble.tryRestore === 'function') {
      restored = Boolean(await ble.tryRestore());
    }
    if (!restored) {
      if (!allowPicker) {
        el.connectBle.disabled = false;
        syncBleConnectLabel();
        return;
      }
      await ble.connect();
    }
    el.disconnectBle.disabled = false;
    el.connectBle.textContent = '連接小米手環';
  } catch (err) {
    if (!isCancelledError(err)) {
      showError(err);
    }
    el.connectBle.disabled = false;
    syncBleConnectLabel();
  }
}

el.connectBle.addEventListener('click', () => {
  void connectOrRestore({ allowPicker: true });
});

el.disconnectBle.addEventListener('click', async () => {
  await ble.disconnect({ forget: true });
  clearLocalHr({ remote: true });
  el.connectBle.disabled = false;
  el.disconnectBle.disabled = true;
  syncBleConnectLabel();
});

el.openMic.addEventListener('click', async () => {
  showError('');
  allowMicPublish = true;
  const resumed = transport?.resumeMic?.();
  if (resumed && typeof resumed.then === 'function') {
    void resumed.catch((err) => showError(err.message || String(err)));
  }
  startMicBucket();
  await mic.start();
});

el.stopMic.addEventListener('click', () => {
  haltMic({ remote: true });
});

el.copyLink.addEventListener('click', async () => {
  if (!transport) return;
  const url = transport.getShareUrl({ roomCode: room, role: 'viewer' });
  try {
    await navigator.clipboard.writeText(url);
    el.copyLink.textContent = '已複製！';
    setTimeout(() => {
      el.copyLink.textContent = '複製監看連結';
    }, 1500);
  } catch {
    prompt('複製以下監看連結：', url);
  }
});

window.addEventListener('beforeunload', () => {
  allowMicPublish = false;
  stopMicBucket();
  mic.stop();
  readout.destroy();
  transport?.leaveRoom();
});

async function init() {
  const cfg = await loadConfig();
  el.backendLabel.textContent = cfg.backend === 'firebase' ? 'Firebase RTDB' : 'FastAPI WSS';
  const short = formatDisplayVersion(cfg.assetVersion);
  el.appVersion.textContent = short || '—';
  el.appVersion.title = cfg.assetVersion || '';
  if (!room) return;

  setStatus(el.roomStatus, 'connecting', '加入房間中…');
  try {
    transport = await createTransport();
    await transport.joinRoom({
      roomCode: room,
      role: 'publisher',
      name,
      clientId,
      onRoster: (members) => {
        const online = members.filter((m) => m.online !== false).length;
        const publishers = members.filter((m) => m.role === 'publisher').length;
        el.rosterMeta.textContent = `房間人數：${online}（發布者 ${publishers}）`;
      },
      onStatus: (kind, text) => {
        if (kind === 'replaced') {
          setStatus(el.roomStatus, 'error', text);
          showError(text);
          void haltSensors({ forgetBle: true });
          return;
        }
        const statusKind = kind === 'reconnecting' ? 'connecting' : kind;
        setStatus(el.roomStatus, statusKind, text);
        if (kind === 'connected' || kind === 'reconnecting' || kind === 'connecting') {
          showError('');
        }
      },
      onError: (msg) => {
        showError(msg);
        setStatus(el.roomStatus, 'error', '房間連線錯誤');
      },
    });
    if (ble.isConnected) {
      const resumed = transport.resumeHr();
      if (resumed && typeof resumed.then === 'function') {
        void resumed.catch((err) => showError(err.message || String(err)));
      }
    }
    if (hasPersistedBleSession()) {
      syncBleConnectLabel();
      void connectOrRestore({ allowPicker: false });
    }
  } catch (err) {
    // Hard failures only (cancelled / missing room). Transient WSS
    // connect failures resolve and keep reconnecting via onStatus.
    showError(err.message || String(err));
    setStatus(el.roomStatus, 'error', '無法加入房間');
  }
}

mountLovensePanel(document.getElementById('lovensePanel'));
init();
