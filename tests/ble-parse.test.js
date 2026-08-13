import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
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
    assert.equal(parsed.bpm, 72);
    assert.equal(parsed.contact, null);
  });

  it('reads 16-bit little-endian bpm', () => {
    const parsed = parseHeartRate(view([0x01, 0x2c, 0x01]));
    assert.equal(parsed.bpm, 300);
  });

  it('reads contact supported + worn', () => {
    const parsed = parseHeartRate(view([0x06, 80]));
    assert.equal(parsed.bpm, 80);
    assert.equal(parsed.contact, true);
  });

  it('reads contact supported + not worn', () => {
    const parsed = parseHeartRate(view([0x04, 60]));
    assert.equal(parsed.contact, false);
  });

  it('rejects empty payloads', () => {
    assert.throws(() => parseHeartRate(view([])), /空的心率/);
  });
});

describe('shouldAcceptHrNotification', () => {
  it('accepts once GATT is up and HR is armed, even before notifications succeed', () => {
    assert.equal(
      shouldAcceptHrNotification({
        shouldReconnect: true,
        gattConnected: true,
        acceptingHr: true,
      }),
      true,
    );
  });

  it('rejects before HR is armed', () => {
    assert.equal(
      shouldAcceptHrNotification({
        shouldReconnect: true,
        gattConnected: true,
        acceptingHr: false,
      }),
      false,
    );
  });

  it('rejects after disconnect', () => {
    assert.equal(
      shouldAcceptHrNotification({
        shouldReconnect: false,
        gattConnected: true,
        acceptingHr: true,
      }),
      false,
    );
  });

  it('rejects when GATT is down', () => {
    assert.equal(
      shouldAcceptHrNotification({
        shouldReconnect: true,
        gattConnected: false,
        acceptingHr: true,
      }),
      false,
    );
  });
});

describe('mapBleUiStatus', () => {
  it('maps hr-ready to connecting pill without resuming HR', () => {
    assert.deepEqual(mapBleUiStatus('hr-ready'), {
      uiKind: 'connecting',
      uiText: '正在啟動心率通知…',
      hr: null,
    });
  });

  it('maps hr-failed to error pill and pause', () => {
    assert.deepEqual(mapBleUiStatus('hr-failed', '心率通知啟動失敗'), {
      uiKind: 'error',
      uiText: '心率通知啟動失敗',
      hr: 'pause',
    });
  });

  it('resumes only after connected', () => {
    assert.equal(mapBleUiStatus('connected', '已連線').hr, 'resume');
    assert.equal(mapBleUiStatus('connecting', '連線中').hr, 'pause');
    assert.equal(mapBleUiStatus('scanning', '選擇小米手環…').hr, 'pause');
    assert.equal(mapBleUiStatus('disconnected', '藍牙已斷線').hr, 'pause');
    assert.equal(mapBleUiStatus('idle', '未連線').hr, 'pause');
  });
});
