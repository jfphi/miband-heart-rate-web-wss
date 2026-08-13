const HRS_UUID = 0x180d;
const HRM_UUID = 0x2a37;

export function parseHeartRate(dataView) {
  if (!dataView || dataView.byteLength === 0) {
    throw new Error('收到空的心率資料');
  }

  const flags = dataView.getUint8(0);
  let bpm;
  if (flags & 0x01) {
    if (dataView.byteLength < 3) throw new Error('16-bit 心率資料不足');
    bpm = dataView.getUint16(1, true);
  } else {
    if (dataView.byteLength < 2) throw new Error('8-bit 心率資料不足');
    bpm = dataView.getUint8(1);
  }

  let contact = null;
  if (flags & 0x04) {
    contact = !!(flags & 0x02);
  }

  return { bpm, contact, flags };
}

export function isWebBluetoothSupported() {
  return Boolean(navigator.bluetooth?.requestDevice);
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
      uiText: text || '正在啟動心率通知…',
      hr: null,
    };
  }
  if (kind === 'hr-failed') {
    return {
      uiKind: 'error',
      uiText: text || '心率通知啟動失敗',
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
  constructor({ onHeartRate, onStatus, onError } = {}) {
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
    this._onDisconnected = () => {
      this.acceptingHr = false;
      this.notificationsStarted = false;
      this.onStatus?.('disconnected', '藍牙已斷線');
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    };
  }

  get isConnected() {
    return isHrStreamReady({
      shouldReconnect: this.shouldReconnect,
      gattConnected: Boolean(this.server?.connected),
      notificationsStarted: this.notificationsStarted,
    });
  }

  async connect() {
    if (!isWebBluetoothSupported()) {
      throw new Error('此瀏覽器不支援 Web Bluetooth，請使用 Chrome 或 Edge');
    }

    this.shouldReconnect = true;
    this.onStatus?.('scanning', '選擇小米手環…');

    if (this.device) {
      this.device.removeEventListener('gattserverdisconnected', this._onDisconnected);
    }

    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [HRS_UUID] }],
    });

    this.device.addEventListener('gattserverdisconnected', this._onDisconnected);

    await this.connectGatt();
  }

  async connectGatt() {
    this.acceptingHr = false;
    this.notificationsStarted = false;
    this.onStatus?.('connecting', `連線中：${this.device?.name || 'MiBand'}…`);
    this.server = await this.device.gatt.connect();
    const service = await this.server.getPrimaryService(HRS_UUID);
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
        const parsed = parseHeartRate(event.target.value);
        this.onHeartRate?.(parsed);
      } catch (err) {
        this.onError?.(err.message || String(err));
      }
    };

    this.characteristic.addEventListener('characteristicvaluechanged', this.handler);
    this.acceptingHr = true;
    this.onStatus?.('hr-ready', '正在啟動心率通知…');
    try {
      await this.characteristic.startNotifications();
    } catch (err) {
      this.acceptingHr = false;
      this.notificationsStarted = false;
      this.onStatus?.('hr-failed', '心率通知啟動失敗');
      this.characteristic.removeEventListener(
        'characteristicvaluechanged',
        this.handler,
      );
      this.handler = null;
      throw err;
    }
    this.notificationsStarted = true;
    this.onStatus?.('connected', `已連線：${this.device.name || 'MiBand'}`);
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(async () => {
      if (!this.shouldReconnect || !this.device) return;
      try {
        this.onStatus?.('scanning', '自動重連中…');
        await this.connectGatt();
      } catch (err) {
        this.onError?.(err.message || String(err));
        this.scheduleReconnect();
      }
    }, 2000);
  }

  async disconnect() {
    this.shouldReconnect = false;
    clearTimeout(this.reconnectTimer);
    try {
      if (this.characteristic && this.handler) {
        this.characteristic.removeEventListener('characteristicvaluechanged', this.handler);
        try {
          await this.characteristic.stopNotifications();
        } catch {
          /* ignore */
        }
      }
      if (this.server?.connected) {
        this.server.disconnect();
      }
    } finally {
      this.acceptingHr = false;
      this.notificationsStarted = false;
      this.characteristic = null;
      this.server = null;
      this.onStatus?.('idle', '未連線');
    }
  }
}
