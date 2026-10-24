import { createCommandQueue } from './lovense-command.js';

const SDK_URL = 'https://api.lovense-api.com/basic-sdk/core.min.js';

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

function anyToyOnline(toys) {
  return Array.isArray(toys) && toys.some((toy) => toy?.connected);
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
  const slider = root.querySelector('#lovenseSlider');
  const levelOut = root.querySelector('#lovenseLevel');
  const error = root.querySelector('#lovenseError');
  if (!status || !connectBtn || !disconnectBtn || !slider || !levelOut) return;

  if (openAppBtn && isMobileLovenseBrowser()) openAppBtn.hidden = false;

  /** @type {any} */
      let sdk = null;
      let ready = false;
      let stopping = false;

  const queue = createCommandQueue(async (plan) => {
    if (!sdk) return;
    if (plan.action === 'stop') {
      sdk.stopToyAction();
      return;
    }
    if (plan.action === 'vibrate') {
      await Promise.resolve(sdk.sendToyCommand({ vibrate: plan.level }));
    }
  });

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

  function setLevel(value, { emit = false } = {}) {
    slider.value = String(value);
    levelOut.textContent = String(value);
    if (emit) slider.dispatchEvent(new Event('input'));
  }

  function stopNow() {
    setLevel(0);
    queue.reset();
    if (!sdk) return;
    try {
      sdk.stopToyAction();
    } catch {
      /* SDK 可能已經斷線 */
    }
  }

  function onPageHide() {
    if (!sdk || slider.value === '0') return;
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

  function applyToys(list) {
    const online = anyToyOnline(list);
    slider.disabled = !online;
    if (toys) {
      const text = toySummary(list);
      toys.hidden = !text;
      toys.textContent = text;
    }
    if (!online) stopNow();
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
        else slider.disabled = false;
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
    stopNow();
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
    slider.disabled = true;
    disconnectBtn.disabled = true;
    connectBtn.disabled = false;
    setStatus('idle', '尚未連接');
    showError('');
  }

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
  slider.addEventListener('input', () => {
    levelOut.textContent = slider.value;
    queue.push(slider.value).catch((err) => {
      showError(err?.message || String(err));
    });
  });
}
