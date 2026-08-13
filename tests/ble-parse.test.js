import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseHeartRate } from '../public/js/ble.js';

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
