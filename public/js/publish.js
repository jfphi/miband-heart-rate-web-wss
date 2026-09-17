import { createMicLevel, isMicSupported } from './audio/micLevel.js';
import { dbToMeterPercent } from './audio/micThrottle.js';
import {
  hasPersistedBleSession,
  isCancelledError,
  mapBleUiStatus,
  MiBandBle,
} from './ble.js';
import { pushHrSample, pruneHrHistory, renderHrSparkline } from './hr-chart.js';
import { createTransport, getConfiguredBackend } from './transport/index.js';
import { getOrCreateClientId, parseQuery } from './util.js';

const qs = parseQuery();
const room = (qs.get('room') || '').toUpperCase();
const name = qs.get('name') || '匿名';

const el = {
  roomCode: document.getElementById('roomCode'),
  backendLabel: document.getElementById('backendLabel'),
  roomStatus: document.getElementById('roomStatus'),
  bleStatus: document.getElementById('bleStatus'),
  bpm: document.getElementById('bpm'),
  contact: document.getElementById('contact'),
  rosterMeta: document.getElementById('rosterMeta'),
  hrChart: document.getElementById('hrChart'),
  error: document.getElementById('error'),
  connectBle: document.getElementById('connectBle'),
  disconnectBle: document.getElementById('disconnectBle'),
  copyLink: document.getElementById('copyLink'),
  micStatus: document.getElementById('micStatus'),
  micDb: document.getElementById('micDb'),
  micMeterFill: document.getElementById('micMeterFill'),
  openMic: document.getElementById('openMic'),
  stopMic: document.getElementById('stopMic'),
};

el.roomCode.textContent = room || '------';

/** @type {{ t: number, bpm: number }[]} */
let hrHistory = [];

function setStatus(node, kind, text) {
  node.className = `status ${kind}`;
  node.textContent = text;
}

function showError(msg) {
  el.error.hidden = !msg;
  el.error.textContent = msg || '';
}

function renderChart() {
  const now = Date.now();
  hrHistory = pruneHrHistory(hrHistory, now);
  el.hrChart.innerHTML = renderHrSparkline(hrHistory, { width: 640, height: 64, now });
}

function restartPulse(node) {
  node.classList.remove('pulse');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      node.classList.add('pulse');
    });
  });
}

function contactLabel(contact) {
  if (contact === true) return '佩戴狀態：已佩戴';
  if (contact === false) return '佩戴狀態：未接觸';
  return '佩戴狀態：未知';
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
let lastBpm = null;
let allowMicPublish = false;
const micSupported = isMicSupported();

function clearLocalHr({ remote = false } = {}) {
  lastBpm = null;
  el.bpm.textContent = '--';
  el.bpm.classList.remove('pulse');
  el.contact.textContent = '佩戴狀態：—';
  hrHistory = [];
  renderChart();
  if (remote) {
    try {
      transport?.clearHr?.();
    } catch {
      /* ignore */
    }
  }
}

function setLocalDb(db) {
  el.micDb.textContent = db == null ? '--' : String(db);
  el.micMeterFill.style.width = `${dbToMeterPercent(db)}%`;
}

function syncMicButtons(status) {
  const active = status === 'listening' || status === 'requesting';
  el.openMic.disabled = !micSupported || active;
  el.stopMic.disabled = !active;
}

function haltMic({ remote = false } = {}) {
  allowMicPublish = false;
  mic.stop();
  setLocalDb(null);
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

renderChart();
setInterval(renderChart, 1000);
syncBleConnectLabel();
if (!micSupported) {
  el.openMic.disabled = true;
  setStatus(el.micStatus, 'error', '此瀏覽器不支援麥克風音量偵測');
}

const mic = createMicLevel({
  onLevel: (db) => {
    setLocalDb(db);
    if (!allowMicPublish) return;
    const published = transport?.publishMic?.({ db, ts: Date.now() });
    if (published && typeof published.then === 'function') {
      void published.catch((err) => showError(err.message || String(err)));
    }
  },
  onStatus: (status, text) => {
    setStatus(el.micStatus, status, text);
    syncMicButtons(status);
    if (status === 'listening') showError('');
  },
  onError: (msg) => showError(msg),
});

const ble = new MiBandBle({
  onHeartRate: async ({ bpm, contact }) => {
    if (bpm !== lastBpm) {
      el.bpm.textContent = String(bpm);
      restartPulse(el.bpm);
      lastBpm = bpm;
      hrHistory = pushHrSample(hrHistory, bpm);
      renderChart();
    }
    el.contact.textContent = contactLabel(contact);
    try {
      await transport?.publishHr({ bpm, contact, ts: Date.now() });
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
    if (!isCancelledError?.(err)) {
      showError(err.message || String(err));
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
  mic.stop();
  transport?.leaveRoom();
});

async function init() {
  const backend = await getConfiguredBackend();
  el.backendLabel.textContent = backend === 'firebase' ? 'Firebase RTDB' : 'FastAPI WSS';
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

init();
