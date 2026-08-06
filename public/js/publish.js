import { MiBandBle } from './ble.js';
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

if (!room) {
  showError('缺少房間碼，請從首頁建立房間');
  el.connectBle.disabled = true;
}

let transport = null;
const clientId = getOrCreateClientId();
let lastBpm = null;

renderChart();
setInterval(renderChart, 1000);

const ble = new MiBandBle({
  onHeartRate: async ({ bpm, contact }) => {
    if (bpm !== lastBpm) {
      el.bpm.textContent = String(bpm);
      el.bpm.classList.remove('pulse');
      void el.bpm.offsetWidth;
      el.bpm.classList.add('pulse');
      lastBpm = bpm;
      hrHistory = pushHrSample(hrHistory, bpm);
      renderChart();
    }
    el.contact.textContent =
      contact === null || contact === undefined
        ? '佩戴狀態：未知'
        : contact
          ? '佩戴狀態：已接觸'
          : '佩戴狀態：未接觸';
    try {
      await transport?.publishHr({ bpm, contact: Boolean(contact), ts: Date.now() });
    } catch (err) {
      showError(err.message || String(err));
    }
  },
  onStatus: (kind, text) => setStatus(el.bleStatus, kind, text),
  onError: (msg) => showError(msg),
});

el.connectBle.addEventListener('click', async () => {
  showError('');
  el.connectBle.disabled = true;
  try {
    await ble.connect();
    el.disconnectBle.disabled = false;
  } catch (err) {
    showError(err.message || String(err));
    el.connectBle.disabled = false;
  }
});

el.disconnectBle.addEventListener('click', async () => {
  await ble.disconnect();
  el.connectBle.disabled = false;
  el.disconnectBle.disabled = true;
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
  } catch (err) {
    // Hard failures only (cancelled / missing room). Transient WSS
    // connect failures resolve and keep reconnecting via onStatus.
    showError(err.message || String(err));
    setStatus(el.roomStatus, 'error', '無法加入房間');
  }
}

init();
