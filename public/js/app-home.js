import { appConfig } from './config.js';
import { createTransport, normalizeBackend } from './transport/index.js';
import { buildPageUrl } from './util.js';

const createName = document.getElementById('createName');
const joinName = document.getElementById('joinName');
const joinRoom = document.getElementById('joinRoom');
const createBtn = document.getElementById('createBtn');
const joinBtn = document.getElementById('joinBtn');
const homeError = document.getElementById('homeError');

let createBackend = normalizeBackend(appConfig.defaultBackend, 'wss');
let joinBackend = normalizeBackend(appConfig.defaultBackend, 'wss');

function showError(msg) {
  homeError.hidden = !msg;
  homeError.textContent = msg || '';
}

function bindBackendSwitch(container, getter, setter) {
  const buttons = [...container.querySelectorAll('[data-backend]')];
  const paint = () => {
    buttons.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.backend === getter());
    });
  };
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      setter(normalizeBackend(btn.dataset.backend, 'wss'));
      paint();
      showError('');
    });
  });
  paint();
}

bindBackendSwitch(
  document.getElementById('createBackend'),
  () => createBackend,
  (v) => {
    createBackend = v;
  },
);
bindBackendSwitch(
  document.getElementById('joinBackend'),
  () => joinBackend,
  (v) => {
    joinBackend = v;
  },
);

createBtn.addEventListener('click', async () => {
  showError('');
  const name = (createName.value || '').trim() || '匿名';
  createBtn.disabled = true;
  try {
    const transport = await createTransport(createBackend);
    const { roomCode } = await transport.createRoom({ name });
    const url = buildPageUrl('publish.html', {
      room: roomCode,
      name,
      backend: createBackend,
    });
    window.location.href = url;
  } catch (err) {
    showError(err.message || String(err));
    createBtn.disabled = false;
  }
});

joinBtn.addEventListener('click', () => {
  showError('');
  const name = (joinName.value || '').trim() || '觀眾';
  const room = (joinRoom.value || '').trim().toUpperCase();
  if (!room) {
    showError('請輸入房間碼');
    return;
  }
  const url = buildPageUrl('watch.html', {
    room,
    name,
    backend: joinBackend,
  });
  window.location.href = url;
});
