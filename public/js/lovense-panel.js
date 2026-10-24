import { createCommandQueue } from './lovense-command.js';
import {
  createRemoteModel,
  knobTop,
  levelFromLane,
} from './lovense-remote.js';
import { drawRemoteWave } from './lovense-wave.js';

const SDK_URL = 'https://api.lovense-api.com/basic-sdk/core.min.js';

const ICON_LOOP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 7H8a4 4 0 0 0-4 4" /><path d="M7.5 17H16a4 4 0 0 0 4-4" /><path d="M14.5 5l2 2-2 2" /><path d="M9.5 19l-2-2 2-2" /></svg>';
const ICON_FLOAT = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="9.2" /></svg>';
const ICON_SLIDER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4v16M16 4v16" /><circle cx="8" cy="9" r="2.1" fill="currentColor" stroke="none" /><circle cx="16" cy="15" r="2.1" fill="currentColor" stroke="none" /></svg>';
const ICON_SYNC = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="7" cy="12" r="2.2" /><circle cx="17" cy="12" r="2.2" /><path d="M9.2 12h5.6" /></svg>';
const ICON_WAVE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 13c2.2-4 3.8-4 6 0s3.8 4 6 0 3.8-4 6 0" /></svg>';

let sdkPromise = null;

function loadLovenseSdk() {
  if (window.LovenseBasicSdk) return Promise.resolve(window.LovenseBasicSdk);
  if (!sdkPromise) {
    sdkPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SDK_URL;
      script.async = true;
      script.onload = () => {
        if (window.LovenseBasicSdk) resolve(window.LovenseBasicSdk);
        else reject(new Error('Lovense SDK 未就緒'));
      };
      script.onerror = () => {
        sdkPromise = null;
        reject(new Error('無法載入 Lovense SDK'));
      };
      document.head.appendChild(script);
    });
  }
  return sdkPromise;
}

export function isMobileLovenseBrowser(
  ua = navigator.userAgent,
  maxTouchPoints = navigator.maxTouchPoints,
) {
  if (/Android|iPhone|iPad|Mobile/i.test(ua)) return true;
  return /Macintosh/i.test(ua) && maxTouchPoints > 1;
}

function toySummary(toys) {
  if (!Array.isArray(toys) || toys.length === 0) return '';
  return toys
    .map((toy) => {
      const name = String(toy?.nickname || toy?.name || '玩具');
      const battery = Number.isFinite(Number(toy?.battery)) ? `${toy.battery}%` : '';
      const online = toy?.connected ? '在線' : '離線';
      return [name, battery, online].filter(Boolean).join(' · ');
    })
    .join('、');
}

/**
 * @param {HTMLElement | null} root
 */
export function mountLovensePanel(root) {
  if (!root) return Promise.resolve();
  return fetch('/api/lovense/status', { cache: 'no-store', credentials: 'same-origin' })
    .then(async (res) => {
      if (!res.ok) return;
      const data = await res.json();
      if (!data?.enabled) return;
      root.hidden = false;
      bindLovensePanel(root);
    })
    .catch(() => {
      /* 沒有這條 API 時維持隱藏，不影響心率頁 */
    });
}

function bindLovensePanel(root) {
  const status = root.querySelector('#lovenseStatus');
  const connectBtn = root.querySelector('#lovenseConnect');
  const openAppBtn = root.querySelector('#lovenseOpenApp');
  const disconnectBtn = root.querySelector('#lovenseDisconnect');
  const qr = root.querySelector('#lovenseQr');
  const toys = root.querySelector('#lovenseToys');
  const remote = root.querySelector('#lovenseRemote');
  const error = root.querySelector('#lovenseError');
  if (!status || !connectBtn || !disconnectBtn || !remote) return;

  if (openAppBtn && isMobileLovenseBrowser()) openAppBtn.hidden = false;

  const showBtn = document.createElement('button');
  showBtn.id = 'lovenseShowRemote';
  showBtn.type = 'button';
  showBtn.className = 'secondary';
  showBtn.textContent = '顯示控制';
  showBtn.hidden = true;
  disconnectBtn.insertAdjacentElement('afterend', showBtn);

  remote.innerHTML = `
    <div class="remote-top">
      <button type="button" class="remote-back" aria-label="返回">‹</button>
      <div class="remote-titleblock">
        <div class="remote-heading">Remote</div>
        <div class="remote-clock">00:00</div>
      </div>
      <div class="remote-pill" hidden></div>
    </div>
    <canvas class="remote-wave" width="400" height="240" aria-hidden="true"></canvas>
    <p class="remote-count">0 Toys Connected</p>
    <div class="remote-body">
      <div class="remote-lanes"></div>
      <div class="remote-modes"></div>
    </div>
  `;

  const clock = remote.querySelector('.remote-clock');
  const pill = remote.querySelector('.remote-pill');
  const count = remote.querySelector('.remote-count');
  const canvas = remote.querySelector('canvas');
  const lanes = remote.querySelector('.remote-lanes');
  const modes = remote.querySelector('.remote-modes');
  const backBtn = remote.querySelector('.remote-back');

  /** @type {any} */
  let sdk = null;
  let ready = false;
  let stopping = false;
  let collapsed = false;
  let controlKey = '';
  let frame = 0;

  const model = createRemoteModel();
  /** @type {Map<string, ReturnType<typeof createCommandQueue>>} */
  const queues = new Map();

  function queueFor(toyId) {
    const key = toyId || '*';
    let queue = queues.get(key);
    if (!queue) {
      queue = createCommandQueue(async (plan) => {
        if (!sdk) return;
        if (plan.action === 'stop') {
          if (plan.toyId) sdk.stopToyAction({ toyId: plan.toyId });
          else sdk.stopToyAction();
          return;
        }
        if (plan.action === 'vibrate') {
          await Promise.resolve(sdk.sendToyCommand({
            vibrate: plan.level,
            ...(plan.toyId ? { toyId: plan.toyId } : {}),
          }));
          return;
        }
        if (plan.action === 'pattern') {
          await Promise.resolve(sdk.sendPatternCommand({
            strength: plan.strength,
            interval: plan.interval,
            time: plan.time ?? 0,
            ...(plan.toyId ? { toyId: plan.toyId } : {}),
          }));
        }
      });
      queues.set(key, queue);
    }
    return queue;
  }

  function dispatch(plans) {
    for (const plan of plans || []) {
      queueFor(plan.toyId).pushPlan(plan).catch((err) => {
        showError(err?.message || String(err));
      });
    }
  }

  function haltToys() {
    for (const queue of queues.values()) queue.reset();
    queues.clear();
    if (!sdk) return;
    try {
      sdk.stopToyAction();
    } catch {
      /* SDK 可能已經斷線 */
    }
  }

  function setStatus(kind, text) {
    status.className = `status ${kind}`;
    status.textContent = text;
  }

  function showError(msg) {
    if (!error) return;
    if (!msg) {
      error.hidden = true;
      error.textContent = '';
      return;
    }
    error.hidden = false;
    error.textContent = String(msg);
  }

  function onPageHide() {
    const view = model.view(Date.now());
    const active = view.looping || view.controls.some((toy) => toy.level > 0.5);
    if (!sdk || !active) return;
    try {
      sdk.stopToyAction();
    } catch {
      /* 頁面關閉時送停失敗就交給 Remote 斷線 */
    }
  }

  async function showQr() {
    if (!sdk || !qr) return;
    const code = await sdk.getQrcode();
    const url = code?.qrcodeUrl;
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      throw new Error('沒有取得 QR code');
    }
    qr.src = url;
    qr.hidden = false;
  }

  function stopPaint() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  }

  function startPaint() {
    if (frame) return;
    const loop = () => {
      frame = requestAnimationFrame(loop);
      paint(Date.now());
    };
    frame = requestAnimationFrame(loop);
  }

  function syncChrome() {
    const view = model.view(Date.now());
    const alive = view.controls.length > 0;
    remote.hidden = !(alive && !collapsed);
    showBtn.hidden = !(alive && collapsed);
    if (alive) startPaint();
    else stopPaint();
  }

  function modeButtons() {
    const specs = [
      ['loop', 'Loop', ICON_LOOP],
      ['float', 'Float', ICON_FLOAT],
      ['traditional', 'Traditional', ICON_SLIDER],
      ['sync', 'Local Sync', ICON_SYNC],
    ];
    modes.replaceChildren();
    for (const [id, label, icon] of specs) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'remote-mode';
      button.dataset.mode = id;
      button.innerHTML = `${icon}<span>${label}</span>`;
      button.addEventListener('click', () => {
        const now = Date.now();
        if (id === 'loop') dispatch(model.toggleLoop(now));
        else if (id === 'float') dispatch(model.toggleFloat(now));
        else if (id === 'traditional') dispatch(model.toggleTraditional());
        else dispatch(model.toggleLocalSync(now));
        paint(now);
      });
      modes.append(button);
    }
  }

  function paintModes(view) {
    for (const button of modes.querySelectorAll('.remote-mode')) {
      const id = button.dataset.mode;
      let on = false;
      if (id === 'loop') on = view.mode === 'loop';
      else if (id === 'float') on = view.mode === 'float';
      else if (id === 'traditional') on = view.traditional;
      else on = view.localSync;
      button.classList.toggle('is-on', on);
      button.disabled = id === 'sync' && !view.canSync;
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function buildLanes(view) {
    lanes.replaceChildren();
    for (const control of view.controls) {
      const lane = document.createElement('div');
      lane.className = 'remote-lane';
      lane.dataset.id = control.id;
      if (view.traditional) {
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0';
        slider.max = '20';
        slider.step = '1';
        slider.value = String(Math.round(control.level));
        slider.className = 'remote-slider';
        slider.style.accentColor = control.color;
        slider.setAttribute('aria-label', `${control.name} 強度`);
        const followSlider = () => {
          const now = Date.now();
          const level = Number(slider.value);
          if (model.draggingId() !== control.id) dispatch(model.begin(control.id, level, now));
          else dispatch(model.move(control.id, level, now));
        };
        slider.addEventListener('pointerdown', followSlider);
        slider.addEventListener('input', followSlider);
        slider.addEventListener('change', () => {
          dispatch(model.end(control.id, Date.now()));
        });
        slider.addEventListener('pointerup', () => {
          dispatch(model.end(control.id, Date.now()));
        });
        slider.addEventListener('keyup', () => {
          dispatch(model.end(control.id, Date.now()));
        });
        const name = document.createElement('span');
        name.className = 'remote-orb-name';
        name.textContent = control.name;
        lane.append(slider, name);
      } else {
        const knob = document.createElement('div');
        knob.className = 'remote-knob';
        const orb = document.createElement('button');
        orb.type = 'button';
        orb.className = 'remote-orb';
        orb.innerHTML = ICON_WAVE;
        orb.style.color = control.color;
        orb.style.borderColor = control.color;
        orb.setAttribute('role', 'slider');
        orb.setAttribute('aria-valuemin', '0');
        orb.setAttribute('aria-valuemax', '20');
        orb.setAttribute('aria-label', `${control.name} 強度`);
        const name = document.createElement('span');
        name.className = 'remote-orb-name';
        name.textContent = control.name;
        knob.append(orb, name);
        lane.append(knob);
        lane.addEventListener('pointerdown', (event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          lane.setPointerCapture(event.pointerId);
          orb.focus();
          dispatch(model.begin(control.id, levelFromLane(event.clientY, lane.getBoundingClientRect()), Date.now()));
        });
        lane.addEventListener('pointermove', (event) => {
          if (model.draggingId() !== control.id) return;
          dispatch(model.move(control.id, levelFromLane(event.clientY, lane.getBoundingClientRect()), Date.now()));
        });
        lane.addEventListener('pointerup', () => {
          dispatch(model.end(control.id, Date.now()));
        });
        lane.addEventListener('pointercancel', () => {
          dispatch(model.end(control.id, Date.now()));
        });
        orb.addEventListener('keydown', (event) => {
          const current = Number(orb.getAttribute('aria-valuenow')) || 0;
          let next = current;
          if (event.key === 'ArrowUp' || event.key === 'ArrowRight') next = Math.min(20, current + 1);
          else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') next = Math.max(0, current - 1);
          else return;
          event.preventDefault();
          const now = Date.now();
          dispatch(model.begin(control.id, next, now));
          dispatch(model.end(control.id, now));
        });
      }
      lanes.append(lane);
    }
  }

  function placeLanes(view) {
    for (const control of view.controls) {
      const lane = lanes.querySelector(`[data-id="${CSS.escape(control.id)}"]`);
      if (!lane) continue;
      const slider = lane.querySelector('.remote-slider');
      if (slider) {
        if (model.draggingId() !== control.id) slider.value = String(Math.round(control.level));
        continue;
      }
      const knob = lane.querySelector('.remote-knob');
      const orb = lane.querySelector('.remote-orb');
      if (!knob || !orb) continue;
      knob.style.top = `${knobTop(control.level, lane.clientHeight)}px`;
      const shown = Math.round(control.level);
      orb.setAttribute('aria-valuenow', String(shown));
      orb.setAttribute('aria-valuetext', String(shown));
    }
  }

  function draw(view, now) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(rect.width * dpr);
    const height = Math.round(rect.height * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawRemoteWave(ctx, {
      series: view.series,
      now,
      width: rect.width,
      height: rect.height,
    });
  }

  function paint(now) {
    dispatch(model.tick(now));
    const view = model.view(now);
    clock.textContent = view.clock;
    pill.textContent = view.pill;
    pill.hidden = !view.pill;
    count.textContent = view.countLabel;
    paintModes(view);
    const key = `${view.traditional ? 'slider' : 'orb'}|${view.controls.map((toy) => toy.id).join(',')}`;
    if (key !== controlKey) {
      controlKey = key;
      buildLanes(view);
    }
    placeLanes(view);
    if (!remote.hidden) draw(view, now);
  }

  function applyToys(list) {
    const online = (Array.isArray(list) ? list : [])
      .filter((toy) => toy?.connected && toy.id)
      .map((toy) => ({
        id: String(toy.id),
        name: String(toy.nickname || toy.name || 'Toy'),
        connected: true,
      }));
    const before = model.view(Date.now()).controls.length;
    model.setToys(online, Date.now());
    const after = model.view(Date.now()).controls.length;
    if (!after) {
      if (before > 0) haltToys();
      collapsed = false;
      controlKey = '';
    } else if (before === 0) {
      collapsed = false;
    }
    if (qr && after > 0) qr.hidden = true;
    if (toys) {
      const text = toySummary(list);
      toys.hidden = !text || (after > 0 && !collapsed);
      toys.textContent = text;
    }
    syncChrome();
  }

  async function connect() {
    if (sdk || stopping) return;
    showError('');
    connectBtn.disabled = true;
    setStatus('connecting', '正在授權…');
    try {
      const res = await fetch('/api/lovense/session', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('無法取得玩具授權');
      const session = await res.json();
      const Ctor = await loadLovenseSdk();
      sdk = new Ctor({
        platform: session.platform,
        authToken: session.authToken,
        uid: session.uid,
      });
      if (openAppBtn) openAppBtn.disabled = false;
      sdk.on('sdkError', (data) => {
        showError(data?.message || '玩具連線發生錯誤');
      });
      sdk.on('appStatusChange', (connected) => {
        if (connected) {
          setStatus('ok', '手機 App 已連線');
          return;
        }
        setStatus('idle', '手機 App 已斷線');
        if (qr) qr.hidden = true;
        applyToys([]);
        if (ready) {
          showQr().catch((err) => showError(err.message || String(err)));
        }
      });
      sdk.on('toyInfoChange', (list) => applyToys(list));
      sdk.on('toyOnlineChange', (online) => {
        if (!online) applyToys([]);
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Lovense SDK 尚未就緒')), 15000);
        sdk.on('ready', () => {
          ready = true;
          clearTimeout(timer);
          resolve();
        });
      });
      await showQr();
      window.addEventListener('pagehide', onPageHide);
      disconnectBtn.disabled = false;
      setStatus('connecting', '請用 Lovense Remote 掃描 QR code');
    } catch (err) {
      showError(err?.message || String(err));
      setStatus('error', '授權失敗');
      connectBtn.disabled = false;
      try {
        sdk?.destroy();
      } catch {
        /* ignore */
      }
      sdk = null;
    }
  }

  function disconnect() {
    stopping = true;
    window.removeEventListener('pagehide', onPageHide);
    model.stopSession();
    haltToys();
    collapsed = false;
    controlKey = '';
    syncChrome();
    try {
      sdk?.destroy();
    } catch {
      /* ignore */
    }
    sdk = null;
    ready = false;
    stopping = false;
    if (openAppBtn) openAppBtn.disabled = true;
    if (qr) {
      qr.hidden = true;
      qr.removeAttribute('src');
    }
    if (toys) {
      toys.hidden = true;
      toys.textContent = '';
    }
    disconnectBtn.disabled = true;
    connectBtn.disabled = false;
    setStatus('idle', '尚未連接');
    showError('');
  }

  modeButtons();
  backBtn.addEventListener('click', () => {
    collapsed = true;
    if (toys && toys.textContent) toys.hidden = false;
    syncChrome();
  });
  showBtn.addEventListener('click', () => {
    collapsed = false;
    if (toys) toys.hidden = true;
    syncChrome();
  });
  connectBtn.addEventListener('click', () => {
    connect();
  });
  openAppBtn?.addEventListener('click', () => {
    if (!sdk) return;
    try {
      sdk.connectLovenseAPP();
    } catch (err) {
      showError(err?.message || String(err));
    }
  });
  disconnectBtn.addEventListener('click', disconnect);
}
