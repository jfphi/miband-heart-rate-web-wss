const HRS_UUID = 0x180d;
const HRM_UUID = 0x2a37;

const DEFAULT_GATT_ATTEMPTS = 4;
const DEFAULT_ADVERTISEMENT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_AUTO_RECONNECTS = 8;
const DEFAULT_RECONNECT_BASE_DELAY_MS = 2000;
const RECONNECT_DELAY_CAP_MS = 30_000;

export const BLE_DEVICE_ID_KEY = 'miband_hr_device_id';
export const BLE_AUTO_RECONNECT_KEY = 'miband_hr_auto';

const MSG = {
  emptyHr: '收到空的心率資料',
  short16: '16-bit 心率資料不足',
  short8: '8-bit 心率資料不足',
  noWebBt: '此瀏覽器不支援 Web Bluetooth，請使用 Chrome 或 Edge',
  pickBand: '選擇小米手環…',
  cancelled: '已取消連線',
  restoring: '還原手環連線…',
  idle: '未連線',
  btDropped: '藍牙已斷線',
  advertTimeout: '等待手環廣播逾時，請確認手環已開啟心率並靠近電腦',
  noGatt: '裝置缺少 GATT',
  gattDropNow: 'GATT 連線後立即斷開，請確認手環已開啟心率並靠近電腦',
  gattDrop: 'GATT 連線中斷，請確認手環已開啟心率偵測、靠近電腦後再試',
  gattFail: 'GATT 連線失敗',
  reconnectCap: '重連次數已達上限',
  hrReady: '正在啟動心率通知…',
  hrFailed: '心率通知啟動失敗',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function parseHeartRate(dataView) {
  if (!dataView || dataView.byteLength === 0) {
    throw new Error(MSG.emptyHr);
  }

  const flags = dataView.getUint8(0);
  let bpm;
  if (flags & 0x01) {
    if (dataView.byteLength < 3) throw new Error(MSG.short16);
    bpm = dataView.getUint16(1, true);
  } else {
    if (dataView.byteLength < 2) throw new Error(MSG.short8);
    bpm = dataView.getUint8(1);
  }

  let contact = null;
  if (flags & 0x04) {
    contact = !!(flags & 0x02);
  }

  return { bpm, contact, flags };
}

export function isWebBluetoothSupported() {
  return Boolean(globalThis.navigator?.bluetooth?.requestDevice);
}

export function canRestoreBleDevice() {
  return Boolean(globalThis.navigator?.bluetooth?.getDevices);
}

export function hasPersistedBleSession() {
  try {
    return (
      localStorage.getItem(BLE_AUTO_RECONNECT_KEY) === '1' &&
      Boolean(localStorage.getItem(BLE_DEVICE_ID_KEY))
    );
  } catch {
    return false;
  }
}

export function persistBleSession(deviceId) {
  try {
    localStorage.setItem(BLE_DEVICE_ID_KEY, deviceId);
    localStorage.setItem(BLE_AUTO_RECONNECT_KEY, '1');
  } catch {
    /* private mode etc. */
  }
}

export function clearPersistedBleSession() {
  try {
    localStorage.removeItem(BLE_DEVICE_ID_KEY);
    localStorage.removeItem(BLE_AUTO_RECONNECT_KEY);
  } catch {
    /* ignore */
  }
}

function readPersistedDeviceId() {
  try {
    return localStorage.getItem(BLE_DEVICE_ID_KEY);
  } catch {
    return null;
  }
}

export function isCancelledError(err) {
  const name = err instanceof Error ? err.name : '';
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /AbortError|NotFoundError/i.test(name) ||
    /已取消連線|Connection cancelled|User cancelled|AbortError|NotFoundError/i.test(msg)
  );
}

/** True only for transient GATT link drops — not "service missing" etc. */
export function isGattDisconnectedError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/not found|Unknown Characteristic|Unknown Service|SecurityError/i.test(msg)) {
    return false;
  }
  return /GATT Server is disconnected|GATT 連線後立即斷開|GATT dropped right after connect|Cannot retrieve services|\(Re\)connect first with|NetworkError: GATT/i.test(
    msg,
  );
}

/** Accept GATT HR once we are about to start notifications, not only after they succeed. */
export function shouldAcceptHrNotification({
  shouldReconnect,
  gattConnected,
  acceptingHr,
}) {
  return Boolean(shouldReconnect && gattConnected && acceptingHr);
}

/** True only after startNotifications succeeded. Drives isConnected / resumeHr. */
export function isHrStreamReady({
  shouldReconnect,
  gattConnected,
  notificationsStarted,
}) {
  return Boolean(shouldReconnect && gattConnected && notificationsStarted);
}

/**
 * Map BLE machine events to status-pill CSS kind + optional HR throttle action.
 * `hr-ready` / `hr-failed` are not CSS classes; they must not skip the pill.
 */
export function mapBleUiStatus(kind, text) {
  if (kind === 'hr-ready') {
    return {
      uiKind: 'connecting',
      uiText: text || MSG.hrReady,
      hr: null,
    };
  }
  if (kind === 'hr-failed') {
    return {
      uiKind: 'error',
      uiText: text || MSG.hrFailed,
      hr: 'pause',
    };
  }
  if (kind === 'connected') {
    return { uiKind: 'connected', uiText: text, hr: 'resume' };
  }
  if (
    kind === 'disconnected' ||
    kind === 'idle' ||
    kind === 'connecting' ||
    kind === 'scanning'
  ) {
    return { uiKind: kind, uiText: text, hr: 'pause' };
  }
  return { uiKind: kind, uiText: text, hr: null };
}

export class MiBandBle {
  constructor({
    onHeartRate,
    onStatus,
    onError,
    advertisementTimeoutMs,
    maxAutoReconnects,
    reconnectBaseDelayMs,
    gattAttempts,
  } = {}) {
    this.onHeartRate = onHeartRate;
    this.onStatus = onStatus;
    this.onError = onError;
    this.device = null;
    this.server = null;
    this.characteristic = null;
    this.handler = null;
    this.reconnectTimer = null;
    this.shouldReconnect = false;
    this.acceptingHr = false;
    this.notificationsStarted = false;
    this.connectInFlight = null;
    this.sessionOp = null;
    this.sessionMutex = Promise.resolve();
    this.connectGeneration = 0;
    this.advertAbort = null;
    this.autoReconnectCount = 0;
    this.advertisementTimeoutMs =
      advertisementTimeoutMs ?? DEFAULT_ADVERTISEMENT_TIMEOUT_MS;
    this.maxAutoReconnects = maxAutoReconnects ?? DEFAULT_MAX_AUTO_RECONNECTS;
    this.reconnectBaseDelayMs =
      reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
    this.gattAttempts = gattAttempts ?? DEFAULT_GATT_ATTEMPTS;
    this._onGattDisconnected = () => {
      // Ignore while a session op (advert wait / connect) or GATT attempt is driving recovery.
      if (!this.shouldReconnect || this.connectInFlight || this.sessionOp) return;
      if (this.reconnectTimer !== null) return;
      this.acceptingHr = false;
      this.notificationsStarted = false;
      this.onStatus?.('disconnected', MSG.btDropped);
      this.scheduleReconnect();
    };
  }

  get isConnected() {
    return isHrStreamReady({
      shouldReconnect: this.shouldReconnect,
      gattConnected: Boolean(this.server?.connected),
      notificationsStarted: this.notificationsStarted,
    });
  }

  async runSessionOp(op) {
    const prev = this.sessionMutex;
    let release = () => {};
    this.sessionMutex = new Promise((resolve) => {
      release = resolve;
    });
    await prev;
    const run = Promise.resolve().then(op);
    this.sessionOp = run;
    try {
      return await run;
    } finally {
      if (this.sessionOp === run) this.sessionOp = null;
      release();
    }
  }

  async connect() {
    return this.runSessionOp(async () => {
      if (!isWebBluetoothSupported()) {
        throw new Error(MSG.noWebBt);
      }

      this.shouldReconnect = true;
      this.autoReconnectCount = 0;
      this.onStatus?.('scanning', MSG.pickBand);

      let device;
      try {
        device = await navigator.bluetooth.requestDevice({
          filters: [{ services: [HRS_UUID] }],
          optionalServices: [HRS_UUID],
        });
      } catch (err) {
        if (this.isGenerationCancelled() || isCancelledError(err)) {
          throw new Error(MSG.cancelled);
        }
        throw err;
      }

      if (this.isGenerationCancelled()) throw new Error(MSG.cancelled);

      await this.attachDevice(device);
      await this.connectGatt();
      this.assertConnectedOrThrow();
      this.rememberDevice();
    });
  }

  /**
   * F5 / remount restore: getDevices → watchAdvertisements → gatt.connect.
   * Returns false when there is nothing to restore.
   */
  async tryRestore() {
    return this.runSessionOp(async () => {
      if (!hasPersistedBleSession() || !canRestoreBleDevice()) return false;
      if (!isWebBluetoothSupported()) return false;

      const savedId = readPersistedDeviceId();
      if (!savedId) return false;

      this.shouldReconnect = true;
      this.autoReconnectCount = 0;
      this.onStatus?.('scanning', MSG.restoring);

      let devices;
      try {
        devices = await navigator.bluetooth.getDevices();
      } catch (err) {
        clearPersistedBleSession();
        throw err;
      }

      if (this.isGenerationCancelled()) throw new Error(MSG.cancelled);

      const device = devices.find((d) => d.id === savedId);
      if (!device) {
        clearPersistedBleSession();
        this.shouldReconnect = false;
        this.onStatus?.('idle', MSG.idle);
        return false;
      }

      await this.attachDevice(device);
      await this.waitForAdvertisement(device, this.advertisementTimeoutMs);
      await this.connectGatt();
      this.assertConnectedOrThrow();
      this.rememberDevice();
      return true;
    });
  }

  assertConnectedOrThrow() {
    if (!this.shouldReconnect || !this.device?.gatt?.connected) {
      throw new Error(MSG.cancelled);
    }
  }

  rememberDevice() {
    if (this.device?.id) persistBleSession(this.device.id);
  }

  async attachDevice(device) {
    if (this.device && this.device !== device) {
      this.device.removeEventListener(
        'gattserverdisconnected',
        this._onGattDisconnected,
      );
    }
    this.device = device;
    this.device.removeEventListener(
      'gattserverdisconnected',
      this._onGattDisconnected,
    );
    this.device.addEventListener(
      'gattserverdisconnected',
      this._onGattDisconnected,
    );
  }

  stopAdvertWatch() {
    if (this.advertAbort) {
      try {
        this.advertAbort.abort();
      } catch {
        /* ignore */
      }
      this.advertAbort = null;
    }
  }

  async waitForAdvertisement(device, timeoutMs) {
    if (this.isGenerationCancelled()) {
      throw new Error(MSG.cancelled);
    }

    if (typeof device.watchAdvertisements !== 'function') {
      return;
    }

    this.stopAdvertWatch();
    const abort = new AbortController();
    this.advertAbort = abort;
    this.onStatus?.(
      'scanning',
      `等待手環廣播：${device.name || 'MiBand'}…`,
    );

    let settled = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      fn();
    };

    try {
      await new Promise((resolve, reject) => {
        const timer = globalThis.setTimeout(() => {
          settle(() => reject(new Error(MSG.advertTimeout)));
        }, timeoutMs);

        const onAdvert = () => {
          globalThis.clearTimeout(timer);
          settle(() => resolve());
        };

        device.addEventListener('advertisementreceived', onAdvert, { once: true });

        abort.signal.addEventListener(
          'abort',
          () => {
            globalThis.clearTimeout(timer);
            device.removeEventListener('advertisementreceived', onAdvert);
            settle(() => reject(new Error(MSG.cancelled)));
          },
          { once: true },
        );

        void device.watchAdvertisements({ signal: abort.signal }).catch((err) => {
          globalThis.clearTimeout(timer);
          device.removeEventListener('advertisementreceived', onAdvert);
          if (abort.signal.aborted || isCancelledError(err)) {
            settle(() => reject(new Error(MSG.cancelled)));
            return;
          }
          const msg = err instanceof Error ? err.message : String(err);
          if (/not supported|unsupported|is not a function|InvalidStateError/i.test(msg)) {
            settle(() => resolve());
            return;
          }
          settle(() => reject(err instanceof Error ? err : new Error(msg)));
        });
      });
    } finally {
      if (this.advertAbort === abort) this.advertAbort = null;
      try {
        abort.abort();
      } catch {
        /* ignore */
      }
    }

    if (this.isGenerationCancelled()) {
      throw new Error(MSG.cancelled);
    }
  }

  isGenerationCancelled(generation) {
    if (!this.shouldReconnect) return true;
    if (generation != null && generation !== this.connectGeneration) return true;
    return false;
  }

  async ensureGattConnected(generation) {
    const gatt = this.device?.gatt;
    if (!gatt) {
      throw new Error(MSG.noGatt);
    }

    if (gatt.connected) {
      try {
        gatt.disconnect();
      } catch {
        /* ignore */
      }
      await sleep(150);
    }

    if (this.isGenerationCancelled(generation)) {
      throw new Error(MSG.cancelled);
    }

    const freshGatt = this.device?.gatt;
    if (!freshGatt) {
      throw new Error(MSG.noGatt);
    }

    const server = await freshGatt.connect();
    if (this.isGenerationCancelled(generation)) {
      try {
        server.disconnect();
      } catch {
        /* ignore */
      }
      throw new Error(MSG.cancelled);
    }
    if (!server.connected || !this.device?.gatt?.connected) {
      throw new Error(MSG.gattDropNow);
    }
    this.server = server;
    return server;
  }

  async connectGatt() {
    if (this.connectInFlight) {
      await this.connectInFlight;
      if (this.isGenerationCancelled() || !this.shouldReconnect) {
        throw new Error(MSG.cancelled);
      }
      if (!this.device?.gatt?.connected) {
        throw new Error(MSG.cancelled);
      }
      return;
    }

    const generation = ++this.connectGeneration;
    const run = this.connectGattOnce(generation);
    this.connectInFlight = run;
    try {
      await run;
    } finally {
      if (this.connectInFlight === run) {
        this.connectInFlight = null;
      }
    }
  }

  async connectGattOnce(generation) {
    if (!this.device?.gatt) {
      throw new Error(MSG.noGatt);
    }

    this.acceptingHr = false;
    this.notificationsStarted = false;
    this.onStatus?.(
      'connecting',
      `連線中：${this.device.name || 'MiBand'}…`,
    );

    if (this.characteristic && this.handler) {
      this.characteristic.removeEventListener(
        'characteristicvaluechanged',
        this.handler,
      );
    }

    let lastError;

    for (let attempt = 1; attempt <= this.gattAttempts; attempt++) {
      if (this.isGenerationCancelled(generation)) {
        throw new Error(MSG.cancelled);
      }

      try {
        const server = await this.ensureGattConnected(generation);
        const gatt = this.device?.gatt;
        if (!gatt?.connected) {
          throw new Error('GATT Server is disconnected. Cannot retrieve services.');
        }

        const service = await gatt.getPrimaryService(HRS_UUID);
        if (this.isGenerationCancelled(generation)) {
          try {
            server.disconnect();
          } catch {
            /* ignore */
          }
          throw new Error(MSG.cancelled);
        }

        const characteristic = await service.getCharacteristic(HRM_UUID);

        if (this.characteristic && this.handler) {
          this.characteristic.removeEventListener(
            'characteristicvaluechanged',
            this.handler,
          );
        }

        this.characteristic = characteristic;
        this.handler = (event) => {
          if (
            !shouldAcceptHrNotification({
              shouldReconnect: this.shouldReconnect,
              gattConnected: Boolean(this.server?.connected),
              acceptingHr: this.acceptingHr,
            })
          ) {
            return;
          }
          try {
            const value = event.target?.value;
            if (!value) return;
            const parsed = parseHeartRate(value);
            this.onHeartRate?.(parsed);
          } catch (err) {
            this.onError?.(err.message || String(err));
          }
        };

        this.characteristic.addEventListener(
          'characteristicvaluechanged',
          this.handler,
        );
        this.acceptingHr = true;
        this.onStatus?.('hr-ready', MSG.hrReady);
        try {
          await this.characteristic.startNotifications();
        } catch (err) {
          this.acceptingHr = false;
          this.notificationsStarted = false;
          this.characteristic.removeEventListener(
            'characteristicvaluechanged',
            this.handler,
          );
          this.handler = null;
          if (this.isGenerationCancelled(generation) || isCancelledError(err)) {
            throw new Error(MSG.cancelled);
          }
          this.onStatus?.('hr-failed', MSG.hrFailed);
          throw err;
        }

        if (this.isGenerationCancelled(generation)) {
          try {
            await this.characteristic.stopNotifications();
          } catch {
            /* ignore */
          }
          try {
            server.disconnect();
          } catch {
            /* ignore */
          }
          this.acceptingHr = false;
          this.notificationsStarted = false;
          throw new Error(MSG.cancelled);
        }

        this.notificationsStarted = true;
        this.autoReconnectCount = 0;
        this.onStatus?.(
          'connected',
          `已連線：${this.device?.name || 'MiBand'}`,
        );
        return;
      } catch (err) {
        lastError = err;
        this.acceptingHr = false;
        this.notificationsStarted = false;
        if (this.isGenerationCancelled(generation) || isCancelledError(err)) {
          throw new Error(MSG.cancelled);
        }
        if (!isGattDisconnectedError(err) || attempt === this.gattAttempts) {
          break;
        }
        this.onStatus?.(
          'connecting',
          `連線不穩，重試 ${attempt}/${this.gattAttempts - 1}：${this.device?.name || 'MiBand'}…`,
        );
        await sleep(250 * attempt);
      }
    }

    if (isCancelledError(lastError)) {
      throw new Error(MSG.cancelled);
    }

    if (isGattDisconnectedError(lastError)) {
      throw new Error(MSG.gattDrop);
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(lastError != null ? String(lastError) : MSG.gattFail);
  }

  scheduleReconnect() {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    if (this.autoReconnectCount >= this.maxAutoReconnects) {
      this.onError?.(MSG.reconnectCap);
      // Stop immediately; defer disconnect so we never await the sessionOp we may be inside.
      this.shouldReconnect = false;
      void Promise.resolve().then(() => {
        void this.disconnect({ forget: false });
      });
      return;
    }

    const attempt = this.autoReconnectCount;
    const delay = Math.min(
      this.reconnectBaseDelayMs * 2 ** attempt,
      RECONNECT_DELAY_CAP_MS,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.shouldReconnect || !this.device) return;
      this.autoReconnectCount += 1;
      void this.runSessionOp(async () => {
        try {
          if (!this.shouldReconnect || !this.device) return;
          this.onStatus?.(
            'scanning',
            `自動重連中（${this.autoReconnectCount}/${this.maxAutoReconnects}）…`,
          );
          await this.waitForAdvertisement(
            this.device,
            this.advertisementTimeoutMs,
          );
          await this.connectGatt();
          this.assertConnectedOrThrow();
          this.rememberDevice();
        } catch (err) {
          if (!this.shouldReconnect || isCancelledError(err)) return;
          this.onError?.(err instanceof Error ? err.message : String(err));
          this.scheduleReconnect();
        }
      });
    }, delay);
  }

  async disconnect({ forget = true } = {}) {
    this.shouldReconnect = false;
    this.connectGeneration += 1;
    this.stopAdvertWatch();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const pending = this.sessionOp ?? this.connectInFlight;
    if (pending) {
      try {
        await pending;
      } catch {
        /* ignore cancelled / failed connect */
      }
    }

    try {
      if (this.characteristic && this.handler) {
        this.characteristic.removeEventListener(
          'characteristicvaluechanged',
          this.handler,
        );
        try {
          await this.characteristic.stopNotifications();
        } catch {
          /* ignore */
        }
      }
      if (this.server?.connected) {
        this.server.disconnect();
      } else if (this.device?.gatt?.connected) {
        this.device.gatt.disconnect();
      }
    } finally {
      if (this.device) {
        this.device.removeEventListener(
          'gattserverdisconnected',
          this._onGattDisconnected,
        );
      }
      this.acceptingHr = false;
      this.notificationsStarted = false;
      this.characteristic = null;
      this.server = null;
      this.device = null;
      this.handler = null;
      this.connectInFlight = null;
      this.autoReconnectCount = 0;
      if (forget) clearPersistedBleSession();
      this.onStatus?.('idle', MSG.idle);
    }
  }
}
