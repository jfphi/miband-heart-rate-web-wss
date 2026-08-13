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
    this._onDisconnected = () => {
      this.onStatus?.('disconnected', '藍牙已斷線');
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    };
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
      try {
        const parsed = parseHeartRate(event.target.value);
        this.onHeartRate?.(parsed);
      } catch (err) {
        this.onError?.(err.message || String(err));
      }
    };

    this.characteristic.addEventListener('characteristicvaluechanged', this.handler);
    await this.characteristic.startNotifications();
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
      this.characteristic = null;
      this.server = null;
      this.onStatus?.('idle', '未連線');
    }
  }
}
