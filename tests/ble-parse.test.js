import { describe, it, expect } from 'vitest';
import {
  isHrStreamReady,
  mapBleUiStatus,
  parseHeartRate,
  shouldAcceptHrNotification,
} from '../public/js/ble.js';

function view(bytes) {
  return new DataView(Uint8Array.from(bytes).buffer);
}

describe('parseHeartRate', () => {
  it('reads 8-bit bpm without contact bits', () => {
    const parsed = parseHeartRate(view([0x00, 72]));
    expect(parsed.bpm).toBe(72);
    expect(parsed.contact).toBeNull();
    expect(parsed.flags).toBe(0);
  });

  it('reads 16-bit little-endian bpm', () => {
    const parsed = parseHeartRate(view([0x01, 0x2c, 0x01]));
    expect(parsed.bpm).toBe(300);
    expect(parsed.contact).toBeNull();
    expect(parsed.flags).toBe(0x01);
  });

  it('reads contact supported + worn', () => {
    const parsed = parseHeartRate(view([0x06, 80]));
    expect(parsed.bpm).toBe(80);
    expect(parsed.contact).toBe(true);
  });

  it('reads contact supported + not worn', () => {
    const parsed = parseHeartRate(view([0x04, 60]));
    expect(parsed.contact).toBe(false);
  });

  it('reads 16-bit bpm with contact detected', () => {
    expect(parseHeartRate(view([0x07, 0x58, 0x02]))).toEqual({
      bpm: 600,
      contact: true,
      flags: 0x07,
    });
  });

  it('rejects empty payloads', () => {
    expect(() => parseHeartRate(view([]))).toThrow(/空的心率/);
    expect(() => parseHeartRate(null)).toThrow(/空的心率/);
  });

  it('rejects truncated 8-bit and 16-bit frames', () => {
    expect(() => parseHeartRate(view([0x00]))).toThrow(/8-bit/);
    expect(() => parseHeartRate(view([0x01, 0x2c]))).toThrow(/16-bit/);
  });
});

describe('shouldAcceptHrNotification', () => {
  it('accepts once GATT is up and HR is armed, even before notifications succeed', () => {
    expect(
      shouldAcceptHrNotification({
        shouldReconnect: true,
        gattConnected: true,
        acceptingHr: true,
      }),
    ).toBe(true);
  });

  it('rejects before HR is armed', () => {
    expect(
      shouldAcceptHrNotification({
        shouldReconnect: true,
        gattConnected: true,
        acceptingHr: false,
      }),
    ).toBe(false);
  });

  it('rejects after disconnect', () => {
    expect(
      shouldAcceptHrNotification({
        shouldReconnect: false,
        gattConnected: true,
        acceptingHr: true,
      }),
    ).toBe(false);
  });

  it('rejects when GATT is down', () => {
    expect(
      shouldAcceptHrNotification({
        shouldReconnect: true,
        gattConnected: false,
        acceptingHr: true,
      }),
    ).toBe(false);
  });
});

describe('isHrStreamReady', () => {
  it('is true only after notifications have started', () => {
    expect(
      isHrStreamReady({
        shouldReconnect: true,
        gattConnected: true,
        notificationsStarted: true,
      }),
    ).toBe(true);
  });

  it('is false during the hr-ready window (accepting HR but notifications not started)', () => {
    expect(
      isHrStreamReady({
        shouldReconnect: true,
        gattConnected: true,
        notificationsStarted: false,
      }),
    ).toBe(false);
    expect(
      shouldAcceptHrNotification({
        shouldReconnect: true,
        gattConnected: true,
        acceptingHr: true,
      }),
    ).toBe(true);
  });

  it('is false when GATT is down or reconnect is off', () => {
    expect(
      isHrStreamReady({
        shouldReconnect: true,
        gattConnected: false,
        notificationsStarted: true,
      }),
    ).toBe(false);
    expect(
      isHrStreamReady({
        shouldReconnect: false,
        gattConnected: true,
        notificationsStarted: true,
      }),
    ).toBe(false);
  });
});

describe('mapBleUiStatus', () => {
  it('maps hr-ready to connecting pill without resuming HR', () => {
    expect(mapBleUiStatus('hr-ready')).toEqual({
      uiKind: 'connecting',
      uiText: '正在啟動心率通知…',
      hr: null,
    });
  });

  it('maps hr-failed to error pill and pause', () => {
    expect(mapBleUiStatus('hr-failed', '心率通知啟動失敗')).toEqual({
      uiKind: 'error',
      uiText: '心率通知啟動失敗',
      hr: 'pause',
    });
  });

  it('resumes only after connected', () => {
    expect(mapBleUiStatus('connected', '已連線').hr).toBe('resume');
    expect(mapBleUiStatus('connecting', '連線中').hr).toBe('pause');
    expect(mapBleUiStatus('scanning', '選擇小米手環…').hr).toBe('pause');
    expect(mapBleUiStatus('disconnected', '藍牙已斷線').hr).toBe('pause');
    expect(mapBleUiStatus('idle', '未連線').hr).toBe('pause');
  });
});
