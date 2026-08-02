import { createTransport, getConfiguredBackend } from './transport/index.js';
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
  roomStatus: document.getElementById('roomStatus'),
  viewerName: document.getElementById('viewerName'),
  cards: document.getElementById('cards'),
  empty: document.getElementById('empty'),
  error: document.getElementById('error'),
};

el.roomCode.textContent = room || '------';
el.viewerName.textContent = `你是：${name}`;

let members = [];

function setStatus(kind, text) {
  el.roomStatus.className = `status ${kind}`;
  el.roomStatus.textContent = text;
}

function showError(msg) {
  el.error.hidden = !msg;
  el.error.textContent = msg || '';
}

function render() {
  const publishers = members.filter((m) => m.role === 'publisher');
  el.empty.hidden = publishers.length > 0;
  el.cards.innerHTML = publishers
    .map((m) => {
      const stale = !m.online || isStale(m.updatedAt);
      const bpm = m.bpm == null ? '--' : String(m.bpm);
      const contact =
        m.contact === true ? '已佩戴' : m.contact === false ? '未接觸' : '未知';
      const signal = stale ? '訊號中斷' : '即時';
      return `
        <article class="card ${stale ? 'stale' : ''}">
          <div class="name">${escapeHtml(m.name)}</div>
          <div class="card-bpm">${bpm}</div>
          <div class="tag">BPM · ${contact}</div>
          <div class="tag">${signal} · ${formatAge(m.updatedAt)}</div>
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

async function init() {
  const backend = await getConfiguredBackend();
  el.backendLabel.textContent = backend === 'firebase' ? 'Firebase RTDB' : 'FastAPI WSS';

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
          render();
          setStatus('connected', '已連線監看');
        },
        onError: (msg) => {
          showError(msg);
          setStatus('error', '連線錯誤');
        },
      });
    })
    .then(() => setStatus('connected', '已連線監看'))
    .catch((err) => {
      showError(err.message || String(err));
      setStatus('error', '無法加入房間');
    });

  window.addEventListener('beforeunload', () => {
    transport?.leaveRoom();
  });

  setInterval(render, 1000);
}

init();
