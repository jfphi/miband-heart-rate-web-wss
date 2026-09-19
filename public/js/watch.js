import { dbToMeterPercent, formatMicAge } from './audio/micThrottle.js';
import { pushHrSample, pruneHrHistory, renderHrSparkline } from './hr-chart.js';
import {
  createRenderScheduler,
  publisherStructureKey,
} from './render-scheduler.js';
import { formatDisplayVersion, loadConfig } from './config.js';
import { createTransport } from './transport/index.js';
import {
  formatAge,
  getOrCreateClientId,
  isStale,
  parseQuery,
} from './util.js';

const qs = parseQuery();
const room = (qs.get('room') || '').toUpperCase();
const name = qs.get('name') || '觀眾';

const el = {
  roomCode: document.getElementById('roomCode'),
  backendLabel: document.getElementById('backendLabel'),
  appVersion: document.getElementById('appVersion'),
  roomStatus: document.getElementById('roomStatus'),
  viewerName: document.getElementById('viewerName'),
  cards: document.getElementById('cards'),
  empty: document.getElementById('empty'),
  error: document.getElementById('error'),
};

el.roomCode.textContent = room || '------';
el.viewerName.textContent = `你是：${name}`;

let members = [];
let structureKey = publisherStructureKey([]);
/** @type {Map<string, { t: number, bpm: number }[]>} */
const hrHistory = new Map();
/** @type {Map<string, { t: number, bpm: number }[]>} */
const soundHistory = new Map();

function setStatus(kind, text) {
  el.roomStatus.className = `status ${kind}`;
  el.roomStatus.textContent = text;
}

function showError(msg) {
  el.error.hidden = !msg;
  el.error.textContent = msg || '';
}

function contactLabel(contact) {
  if (contact === true) return '已佩戴';
  if (contact === false) return '未接觸';
  return '未知';
}

function syncHistory(list) {
  const alive = new Set();
  for (const m of list) {
    if (m.role !== 'publisher') continue;
    alive.add(m.clientId);
    if (m.bpm == null) {
      hrHistory.set(m.clientId, []);
    } else {
      const prev = hrHistory.get(m.clientId) || [];
      const t = m.updatedAt || Date.now();
      hrHistory.set(m.clientId, pushHrSample(prev, m.bpm, t));
    }
    if (m.db == null) {
      soundHistory.set(m.clientId, []);
    } else {
      const prev = soundHistory.get(m.clientId) || [];
      const t = m.soundUpdatedAt || Date.now();
      soundHistory.set(m.clientId, pushHrSample(prev, m.db, t));
    }
  }
  for (const id of hrHistory.keys()) {
    if (!alive.has(id)) hrHistory.delete(id);
  }
  for (const id of soundHistory.keys()) {
    if (!alive.has(id)) soundHistory.delete(id);
  }
}

function render() {
  const publishers = members.filter((m) => m.role === 'publisher');
  el.empty.hidden = publishers.length > 0;
  const now = Date.now();
  el.cards.innerHTML = publishers
    .map((m) => {
      const signalAt =
        m.updatedAt != null && m.soundUpdatedAt != null
          ? Math.max(m.updatedAt, m.soundUpdatedAt)
          : (m.updatedAt ?? m.soundUpdatedAt);
      const stale = !m.online || isStale(signalAt);
      const bpm = m.bpm == null ? '--' : String(m.bpm);
      const contact = contactLabel(m.contact);
      const signal = stale ? '訊號中斷' : '即時';
      const points = pruneHrHistory(hrHistory.get(m.clientId) || [], now);
      hrHistory.set(m.clientId, points);
      const showMic = m.db != null || m.soundUpdatedAt != null;
      const soundPoints = pruneHrHistory(soundHistory.get(m.clientId) || [], now);
      soundHistory.set(m.clientId, soundPoints);
      const dbText = m.db == null ? '--' : String(m.db);
      const meter = dbToMeterPercent(m.db);
      const micBlock = showMic
        ? `
          <div class="tag">dB · ${dbText}</div>
          <div class="mic-meter" aria-hidden="true">
            <div class="mic-meter-fill" style="width: ${meter}%"></div>
          </div>
          <div class="tag">${formatMicAge(m.soundUpdatedAt)}</div>
          <div class="hr-chart-wrap">
            <div class="hr-chart-label">近 60 秒 dB</div>
            ${renderHrSparkline(soundPoints, {
              now,
              preferredMin: -80,
              preferredMax: 0,
              yScale: 'preferred',
              ariaLabel: '近 60 秒音量',
            })}
          </div>
        `
        : '';
      return `
        <article class="card ${stale ? 'stale' : ''}">
          <div class="name">${escapeHtml(m.name)}</div>
          <div class="card-bpm">${bpm}</div>
          <div class="tag">BPM · ${contact}</div>
          <div class="tag">${signal} · ${formatAge(m.updatedAt)}</div>
          <div class="hr-chart-wrap">
            <div class="hr-chart-label">近 60 秒</div>
            ${renderHrSparkline(points, { now })}
          </div>
          ${micBlock}
        </article>
      `;
    })
    .join('');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const scheduler = createRenderScheduler({
  paint: render,
  minIntervalMs: 1000,
});

async function init() {
  const cfg = await loadConfig();
  el.backendLabel.textContent = cfg.backend === 'firebase' ? 'Firebase RTDB' : 'FastAPI WSS';
  const short = formatDisplayVersion(cfg.assetVersion);
  el.appVersion.textContent = short || '—';
  el.appVersion.title = cfg.assetVersion || '';

  if (!room) {
    showError('缺少房間碼');
    setStatus('error', '無效連結');
    return;
  }

  let transport = null;
  createTransport()
    .then((t) => {
      transport = t;
      return transport.joinRoom({
        roomCode: room,
        role: 'viewer',
        name,
        clientId: getOrCreateClientId(),
        onRoster: (list) => {
          members = list;
          syncHistory(list);
          const nextKey = publisherStructureKey(list);
          const structural = nextKey !== structureKey;
          structureKey = nextKey;
          scheduler.request({ immediate: structural });
        },
        onStatus: (kind, text) => {
          if (kind === 'replaced') {
            setStatus('error', text);
            showError(text);
            return;
          }
          const label =
            kind === 'connected'
              ? '已連線監看'
              : kind === 'reconnecting'
                ? '連線中斷，重連中…'
                : text;
          setStatus(kind === 'reconnecting' ? 'connecting' : kind, label);
          if (kind === 'connected' || kind === 'reconnecting' || kind === 'connecting') {
            showError('');
          }
        },
        onError: (msg) => {
          showError(msg);
          setStatus('error', '連線錯誤');
        },
      });
    })
    .catch((err) => {
      // Hard failures only; WSS transient connect keeps reconnecting.
      showError(err.message || String(err));
      setStatus('error', '無法加入房間');
    });

  window.addEventListener('beforeunload', () => {
    scheduler.stop();
    transport?.leaveRoom();
  });

  scheduler.startClock(1000);
}

init();
