import { dbToWaveAmp, meterZone, pushLevelSample } from './audio/waveform.js';
import { formatDisplayVersion, loadConfig } from './config.js';
import { pushHrSample } from './hr-chart.js';
import { chooseFocus, mountLiveReadout } from './live-readout.js';
import { mountLovensePanel } from './lovense-panel.js';
import { createTransport } from './transport/index.js';
import {
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
  roster: document.getElementById('roster'),
  live: document.getElementById('liveReadout'),
  empty: document.getElementById('empty'),
  error: document.getElementById('error'),
};

el.roomCode.textContent = room || '------';
el.viewerName.textContent = `你是：${name}`;

const readout = mountLiveReadout(el.live, { showSignal: true });

let members = [];
/** @type {string | null} */
let focusedId = null;
/** @type {string[]} */
let previousIds = [];
/** @type {Map<string, { t: number, bpm: number }[]>} */
const hrHistory = new Map();
/** @type {Map<string, { t: number, db: number }[]>} */
const levelHistory = new Map();

function setStatus(kind, text) {
  el.roomStatus.className = `status ${kind}`;
  el.roomStatus.textContent = text;
}

function showError(msg) {
  el.error.hidden = !msg;
  el.error.textContent = msg || '';
}

function publishersOf(list) {
  return list.filter((m) => m.role === 'publisher');
}

function signalAt(member) {
  if (member.updatedAt != null && member.soundUpdatedAt != null) {
    return Math.max(member.updatedAt, member.soundUpdatedAt);
  }
  return member.updatedAt ?? member.soundUpdatedAt ?? null;
}

function syncHistories(list) {
  const alive = new Set();
  for (const member of publishersOf(list)) {
    alive.add(member.clientId);
    if (member.bpm == null) {
      hrHistory.set(member.clientId, []);
    } else {
      const prev = hrHistory.get(member.clientId) || [];
      const t = member.updatedAt || Date.now();
      hrHistory.set(member.clientId, pushHrSample(prev, member.bpm, t));
    }
    if (member.db == null) {
      levelHistory.set(member.clientId, []);
    } else {
      const prev = levelHistory.get(member.clientId) || [];
      const t = member.soundUpdatedAt || Date.now();
      const last = prev[prev.length - 1];
      if (!last || last.t !== t || last.db !== member.db) {
        levelHistory.set(member.clientId, pushLevelSample(prev, member.db, t));
      }
    }
  }
  for (const id of hrHistory.keys()) {
    if (!alive.has(id)) hrHistory.delete(id);
  }
  for (const id of levelHistory.keys()) {
    if (!alive.has(id)) levelHistory.delete(id);
  }
}

function renderRoster(publishers) {
  const seen = new Set();
  for (const member of publishers) {
    seen.add(member.clientId);
    let button = el.roster.querySelector(`[data-id="${CSS.escape(member.clientId)}"]`);
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'roster-item';
      button.dataset.id = member.clientId;
      button.innerHTML = `
        <span class="roster-name"></span>
        <span class="roster-bpm"></span>
        <span class="mic-meter roster-meter" hidden>
          <span class="mic-meter-fill"></span>
        </span>
      `;
      button.addEventListener('click', () => {
        focusedId = member.clientId;
        apply();
      });
      el.roster.appendChild(button);
    }
    const stale = !member.online || isStale(signalAt(member));
    button.classList.toggle('is-selected', member.clientId === focusedId);
    button.classList.toggle('is-stale', stale);
    button.querySelector('.roster-name').textContent = member.name || '匿名';
    button.querySelector('.roster-bpm').textContent = member.bpm == null ? '--' : String(member.bpm);
    const meter = button.querySelector('.roster-meter');
    const fill = button.querySelector('.mic-meter-fill');
    if (member.db == null) {
      meter.hidden = true;
    } else {
      meter.hidden = false;
      fill.style.width = `${Math.round(dbToWaveAmp(member.db) * 100)}%`;
      fill.className = `mic-meter-fill zone-${meterZone(member.db)}`;
    }
  }
  for (const button of el.roster.querySelectorAll('.roster-item')) {
    if (!seen.has(button.dataset.id)) button.remove();
  }
}

function apply() {
  const publishers = publishersOf(members);
  focusedId = chooseFocus(publishers, focusedId, previousIds);
  previousIds = publishers.map((m) => m.clientId);
  renderRoster(publishers);
  const hasPeople = publishers.length > 0;
  el.empty.hidden = hasPeople;
  el.live.hidden = !hasPeople;
  const member = publishers.find((m) => m.clientId === focusedId);
  if (!member) return;
  const stale = !member.online || isStale(signalAt(member));
  readout.setName(member.name);
  readout.setContact(member.bpm == null && member.contact == null ? undefined : member.contact);
  readout.setHrSeries(hrHistory.get(member.clientId) || [], member.bpm);
  readout.setLevelSeries(levelHistory.get(member.clientId) || [], member.db);
  readout.setStale(stale);
  readout.setSignal(stale ? 'error' : 'connected', stale ? '訊號中斷' : '即時');
  readout.setMicStatus(
    member.db == null ? 'idle' : 'listening',
    member.db == null ? '麥克風未開啟' : '正在量測音量',
  );
}

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
          syncHistories(list);
          apply();
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
      showError(err.message || String(err));
      setStatus('error', '無法加入房間');
    });

  const staleTimer = setInterval(apply, 1000);

  window.addEventListener('beforeunload', () => {
    clearInterval(staleTimer);
    readout.destroy();
    transport?.leaveRoom();
  });
}

mountLovensePanel(document.getElementById('lovensePanel'));
init();
