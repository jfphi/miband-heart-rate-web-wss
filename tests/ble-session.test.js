import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BLE_AUTO_RECONNECT_KEY,
  BLE_DEVICE_ID_KEY,
  MiBandBle,
  canRestoreBleDevice,
  clearPersistedBleSession,
  hasPersistedBleSession,
  isCancelledError,
  isGattDisconnectedError,
  persistBleSession,
} from '../public/js/ble.js';

function stubLocalStorage() {
  const map = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
    clear: () => map.clear(),
  });
}

function createMockDevice(id = 'dev-1', name = 'Mi Band') {
  const listeners = new Map();
  const on = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
  };
  const off = (type, fn) => {
    listeners.get(type)?.delete(fn);
  };
  const emit = (type, ev) => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn(ev);
  };

  const characteristic = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    startNotifications: vi.fn(async () => characteristic),
    stopNotifications: vi.fn(async () => characteristic),
    value: undefined,
  };

  const service = {
    getCharacteristic: vi.fn(async () => characteristic),
  };

  const gatt = {
    connected: false,
    connect: vi.fn(async () => {
      gatt.connected = true;
      return gatt;
    }),
    disconnect: vi.fn(() => {
      gatt.connected = false;
      emit('gattserverdisconnected');
    }),
    getPrimaryService: vi.fn(async () => service),
  };

  const device = {
    id,
    name,
    gatt,
    watchAdvertisements: vi.fn(async () => undefined),
    addEventListener: (type, fn) => on(type, fn),
    removeEventListener: (type, fn) => off(type, fn),
    emitAdvert: () => emit('advertisementreceived', { device }),
    emitDisconnected: () => {
      gatt.connected = false;
      emit('gattserverdisconnected');
    },
    characteristic,
  };

  return device;
}

function stubBluetooth(device, extras = {}) {
  vi.stubGlobal('navigator', {
    bluetooth: {
      requestDevice: vi.fn(async () => device),
      getDevices: vi.fn(async () => [device]),
      ...extras,
    },
  });
}

describe('isGattDisconnectedError', () => {
  it('matches Chrome GATT disconnect messages including literal (Re)connect', () => {
    expect(
      isGattDisconnectedError(
        new Error(
          'GATT Server is disconnected. Cannot retrieve services. (Re)connect first with `device.gatt.connect`.',
        ),
      ),
    ).toBe(true);
    expect(
      isGattDisconnectedError(new Error('NetworkError: GATT Server is disconnected.')),
    ).toBe(true);
    expect(
      isGattDisconnectedError(
        new Error('GATT 連線後立即斷開，請確認手環已開啟心率並靠近電腦'),
      ),
    ).toBe(true);
  });

  it('does not match missing-service or security errors', () => {
    expect(
      isGattDisconnectedError(
        new Error("Failed to execute 'getPrimaryService': No Services found"),
      ),
    ).toBe(false);
    expect(isGattDisconnectedError(new Error('GATT Service not found.'))).toBe(false);
    expect(isGattDisconnectedError(new Error('Unknown Service'))).toBe(false);
    expect(isGattDisconnectedError(new Error('Unknown Characteristic'))).toBe(false);
    expect(isGattDisconnectedError(new Error('SecurityError: Origin not allowed'))).toBe(
      false,
    );
  });
});

describe('isCancelledError', () => {
  it('detects cancel / abort styles', () => {
    expect(isCancelledError(new Error('已取消連線'))).toBe(true);
    expect(
      isCancelledError(new Error('User cancelled the requestDevice() chooser.')),
    ).toBe(true);
    expect(isCancelledError(new DOMException('Aborted', 'AbortError'))).toBe(true);
    const notFound = new Error('chooser dismissed');
    notFound.name = 'NotFoundError';
    expect(isCancelledError(notFound)).toBe(true);
  });

  it('does not treat GATT drops as cancelled', () => {
    expect(
      isCancelledError(new Error('GATT Server is disconnected. Cannot retrieve services.')),
    ).toBe(false);
  });
});

describe('persisted BLE session', () => {
  beforeEach(() => {
    stubLocalStorage();
  });
  afterEach(() => {
    clearPersistedBleSession();
    vi.unstubAllGlobals();
  });

  it('round-trips auto-reconnect flags', () => {
    expect(hasPersistedBleSession()).toBe(false);
    persistBleSession('device-abc');
    expect(localStorage.getItem(BLE_DEVICE_ID_KEY)).toBe('device-abc');
    expect(localStorage.getItem(BLE_AUTO_RECONNECT_KEY)).toBe('1');
    expect(hasPersistedBleSession()).toBe(true);
    clearPersistedBleSession();
    expect(hasPersistedBleSession()).toBe(false);
  });

  it('requires both auto flag and device id', () => {
    localStorage.setItem(BLE_DEVICE_ID_KEY, 'only-id');
    expect(hasPersistedBleSession()).toBe(false);
    localStorage.setItem(BLE_AUTO_RECONNECT_KEY, '0');
    expect(hasPersistedBleSession()).toBe(false);
    localStorage.setItem(BLE_AUTO_RECONNECT_KEY, '1');
    expect(hasPersistedBleSession()).toBe(true);
  });

  it('returns false when localStorage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
    });
    expect(hasPersistedBleSession()).toBe(false);
  });
});

describe('canRestoreBleDevice', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is true only when getDevices exists', () => {
    vi.stubGlobal('navigator', {
      bluetooth: { requestDevice: vi.fn(), getDevices: vi.fn() },
    });
    expect(canRestoreBleDevice()).toBe(true);
    vi.stubGlobal('navigator', {
      bluetooth: { requestDevice: vi.fn() },
    });
    expect(canRestoreBleDevice()).toBe(false);
  });
});

describe('MiBandBle restore / cancel / reconnect', () => {
  beforeEach(() => {
    stubLocalStorage();
    vi.useFakeTimers();
  });
  afterEach(() => {
    clearPersistedBleSession();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function flush() {
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
  }

  it('connect uses HR filter + optionalServices and persists after notifications', async () => {
    const device = createMockDevice();
    stubBluetooth(device);
    const statuses = [];
    const ble = new MiBandBle({
      onStatus: (k, t) => statuses.push(`${k}:${t}`),
    });

    device.characteristic.startNotifications.mockImplementation(async () => {
      expect(ble.isConnected).toBe(false);
      expect(statuses.some((s) => s.startsWith('hr-ready:'))).toBe(true);
      return device.characteristic;
    });

    await ble.connect();
    expect(navigator.bluetooth.requestDevice).toHaveBeenCalledWith({
      filters: [{ services: [0x180d] }],
      optionalServices: [0x180d],
    });
    expect(ble.isConnected).toBe(true);
    expect(hasPersistedBleSession()).toBe(true);
    expect(localStorage.getItem(BLE_DEVICE_ID_KEY)).toBe(device.id);
    expect(statuses.some((s) => s.startsWith('connected:'))).toBe(true);
    await ble.disconnect({ forget: true });
  });

  it('tryRestore waits for advertisement then connects', async () => {
    const device = createMockDevice();
    persistBleSession(device.id);
    stubBluetooth(device);

    const statuses = [];
    const ble = new MiBandBle({
      advertisementTimeoutMs: 5000,
      onStatus: (k, t) => statuses.push(`${k}:${t}`),
    });

    const restore = ble.tryRestore();
    await flush();
    expect(device.watchAdvertisements).toHaveBeenCalled();
    device.emitAdvert();
    await expect(restore).resolves.toBe(true);
    expect(device.gatt.connect).toHaveBeenCalled();
    expect(hasPersistedBleSession()).toBe(true);
    expect(statuses.some((s) => s.startsWith('hr-ready:'))).toBe(true);
    expect(statuses.some((s) => s.startsWith('connected:'))).toBe(true);
    expect(ble.isConnected).toBe(true);

    await ble.disconnect({ forget: true });
  });

  it('tryRestore returns false and clears persistence when the saved device is missing', async () => {
    persistBleSession('missing-id');
    stubBluetooth(createMockDevice('other'));
    const ble = new MiBandBle();
    await expect(ble.tryRestore()).resolves.toBe(false);
    expect(hasPersistedBleSession()).toBe(false);
  });

  it('tryRestore returns false when nothing is persisted', async () => {
    stubBluetooth(createMockDevice());
    const ble = new MiBandBle();
    await expect(ble.tryRestore()).resolves.toBe(false);
    expect(navigator.bluetooth.getDevices).not.toHaveBeenCalled();
  });

  it('disconnect during advert wait cancels with 已取消連線', async () => {
    const device = createMockDevice();
    persistBleSession(device.id);
    stubBluetooth(device);

    const ble = new MiBandBle({ advertisementTimeoutMs: 30_000 });
    const restore = ble.tryRestore();
    await flush();
    expect(device.watchAdvertisements).toHaveBeenCalled();
    const disconnect = ble.disconnect({ forget: false });
    await expect(restore).rejects.toThrow(/已取消連線/);
    await disconnect;
    expect(hasPersistedBleSession()).toBe(true);
  });

  it('ignores GATT disconnect events while restore is in-flight', async () => {
    const device = createMockDevice();
    persistBleSession(device.id);
    stubBluetooth(device);
    const statuses = [];
    const ble = new MiBandBle({
      advertisementTimeoutMs: 5000,
      onStatus: (k, t) => statuses.push(`${k}:${t}`),
    });

    const restore = ble.tryRestore();
    await flush();
    device.emitDisconnected();
    expect(statuses.some((s) => s.startsWith('disconnected:'))).toBe(false);
    device.emitAdvert();
    await expect(restore).resolves.toBe(true);
    expect(ble.isConnected).toBe(true);
    await ble.disconnect({ forget: true });
  });

  it('retries GATT connect only for transient disconnects', async () => {
    const device = createMockDevice();
    stubBluetooth(device);
    device.gatt.connect
      .mockImplementationOnce(async () => {
        throw new Error(
          'GATT Server is disconnected. Cannot retrieve services. (Re)connect first with `device.gatt.connect`.',
        );
      })
      .mockImplementationOnce(async () => {
        throw new Error('NetworkError: GATT Server is disconnected.');
      })
      .mockImplementation(async () => {
        device.gatt.connected = true;
        return device.gatt;
      });

    const ble = new MiBandBle({ gattAttempts: 4 });
    const connect = ble.connect();
    await flush();
    await vi.advanceTimersByTimeAsync(250);
    await flush();
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    await connect;
    expect(device.gatt.connect).toHaveBeenCalledTimes(3);
    expect(ble.isConnected).toBe(true);
    await ble.disconnect({ forget: true });
  });

  it('does not retry Unknown Service and keeps the original error', async () => {
    const device = createMockDevice();
    stubBluetooth(device);
    device.gatt.getPrimaryService.mockRejectedValue(new Error('Unknown Service'));
    const ble = new MiBandBle({ gattAttempts: 4 });
    await expect(ble.connect()).rejects.toThrow(/Unknown Service/);
    expect(device.gatt.connect).toHaveBeenCalledTimes(1);
  });

  it('maps startNotifications failure to hr-failed and not connected', async () => {
    const device = createMockDevice();
    stubBluetooth(device);
    device.characteristic.startNotifications.mockRejectedValue(
      new Error('notify fail'),
    );
    const statuses = [];
    const ble = new MiBandBle({
      onStatus: (k, t) => statuses.push(`${k}:${t}`),
    });
    await expect(ble.connect()).rejects.toThrow(/notify fail/);
    expect(statuses.some((s) => s.startsWith('hr-failed:'))).toBe(true);
    expect(statuses.some((s) => s.startsWith('connected:'))).toBe(false);
    expect(ble.isConnected).toBe(false);
    await ble.disconnect({ forget: true });
  });

  it('maps picker cancel to 已取消連線', async () => {
    const device = createMockDevice();
    const cancel = new Error('User cancelled the requestDevice() chooser.');
    cancel.name = 'NotFoundError';
    stubBluetooth(device, {
      requestDevice: vi.fn(async () => {
        throw cancel;
      }),
    });
    const ble = new MiBandBle();
    await expect(ble.connect()).rejects.toThrow(/已取消連線/);
  });

  it('max auto-reconnect returns to idle and keeps persistence', async () => {
    const device = createMockDevice();
    persistBleSession(device.id);
    stubBluetooth(device);

    const statuses = [];
    const errors = [];
    const ble = new MiBandBle({
      advertisementTimeoutMs: 20,
      maxAutoReconnects: 2,
      reconnectBaseDelayMs: 5,
      gattAttempts: 1,
      onStatus: (kind, text) => statuses.push({ kind, text }),
      onError: (m) => errors.push(m),
    });

    const restore = ble.tryRestore();
    await flush();
    device.emitAdvert();
    await restore;
    expect(statuses.at(-1)?.kind).toBe('connected');

    device.gatt.connect.mockImplementation(async () => {
      device.gatt.connected = false;
      throw new Error(
        'GATT Server is disconnected. Cannot retrieve services. (Re)connect first with `device.gatt.connect`.',
      );
    });
    device.watchAdvertisements.mockImplementation(async () => {
      queueMicrotask(() => device.emitAdvert());
    });

    device.emitDisconnected();
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(25);
      await Promise.resolve();
    }
    await vi.runAllTimersAsync();
    await flush();

    expect(errors.some((e) => /重連次數已達上限/.test(e))).toBe(true);
    expect(statuses.at(-1)?.kind).toBe('idle');
    expect(hasPersistedBleSession()).toBe(true);

    await ble.disconnect({ forget: true });
  });

  it('forget disconnect clears persistence', async () => {
    const device = createMockDevice();
    persistBleSession(device.id);
    stubBluetooth(device);
    const ble = new MiBandBle({ advertisementTimeoutMs: 5000 });
    const restore = ble.tryRestore();
    await flush();
    device.emitAdvert();
    await restore;
    await ble.disconnect({ forget: true });
    expect(hasPersistedBleSession()).toBe(false);
  });
});
