import { createTransport, getConfiguredBackend } from './transport/index.js';
import { buildPageUrl } from './util.js';

const createName = document.getElementById('createName');
const joinName = document.getElementById('joinName');
const joinRoom = document.getElementById('joinRoom');
const createBtn = document.getElementById('createBtn');
const joinBtn = document.getElementById('joinBtn');
const homeError = document.getElementById('homeError');
const backendHint = document.getElementById('backendHint');

function showError(msg) {
  homeError.hidden = !msg;
  homeError.textContent = msg || '';
}

function backendLabel(backend) {
  return backend === 'firebase' ? 'Firebase' : 'FastAPI WSS';
}

getConfiguredBackend()
  .then((backend) => {
    backendHint.textContent = backendLabel(backend);
  })
  .catch(() => {
    backendHint.textContent = '未知';
  });

createBtn.addEventListener('click', async () => {
  showError('');
  const name = (createName.value || '').trim() || '匿名';
  createBtn.disabled = true;
  try {
    const transport = await createTransport();
    const { roomCode } = await transport.createRoom({ name });
    window.location.href = buildPageUrl('publish.html', { room: roomCode, name });
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
  window.location.href = buildPageUrl('watch.html', { room, name });
});
