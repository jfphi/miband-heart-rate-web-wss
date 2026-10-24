import { describe, expect, it } from 'vitest';
import { waveformLayout } from '../public/js/audio/waveform.js';
import { wavePoints } from '../public/js/lovense-wave.js';
import { heartPoints, seriesX } from '../public/js/wave-stage.js';
import { canSendToy, clampGrantSeconds, controlRole } from '../public/js/toy-control.js';

describe('seriesX', () => {
  it('puts the same timestamp on the same x for heart, sound and toy', () => {
    const now = 12_000;
    const width = 240;
    const windowMs = 12_000;
    const t = 6_000;
    const x = seriesX(t, now, width, windowMs);
    const heart = heartPoints([{ t, bpm: 80 }], now, width, 64, windowMs);
    const sound = waveformLayout([{ t, db: -20 }], now, width, 40, windowMs);
    const toy = wavePoints([{ t, level: 10 }], now, width, 64, windowMs);
    expect(heart[0].x).toBeCloseTo(x);
    expect(toy[0].x).toBeCloseTo(x);
    expect(sound.bars[0].x).toBeCloseTo(seriesX(sound.bars[0].t, now, width, windowMs));
  });
});

describe('controlRole', () => {
  const leases = [
    { ownerId: 'own', controllerId: 'ctl', controllerName: 'Ctl', expiresAt: 5_000, toys: [{ id: 'lush', name: 'Lush' }] },
  ];

  it('lets the grantee send and locks the owner', () => {
    const owner = controlRole({ clientId: 'own', leases, now: 1_000, toyControl: true, localOwner: true });
    const controller = controlRole({ clientId: 'ctl', leases, now: 1_000, toyControl: true });
    const stranger = controlRole({ clientId: 'see', leases, now: 1_000, toyControl: true });
    expect(owner.mode).toBe('owner-locked');
    expect(canSendToy(owner)).toBe(false);
    expect(controller.mode).toBe('controller');
    expect(canSendToy(controller)).toBe(true);
    expect(stranger.mode).toBe('spectator');
    expect(canSendToy(stranger)).toBe(false);
  });

  it('returns the toy to the owner after expiry', () => {
    const owner = controlRole({ clientId: 'own', leases, now: 9_000, toyControl: true, localOwner: true });
    expect(owner.mode).toBe('owner');
    expect(canSendToy(owner)).toBe(true);
  });

  it('rejects durations outside 1 to 1800 seconds', () => {
    expect(clampGrantSeconds(30)).toBe(30);
    expect(clampGrantSeconds(0)).toBeNull();
    expect(clampGrantSeconds(1801)).toBeNull();
  });

  it('hides sharing on firebase', () => {
    const role = controlRole({ clientId: 'own', leases, now: 1_000, toyControl: false, localOwner: true });
    expect(role.mode).toBe('unavailable');
    expect(canSendToy(role)).toBe(false);
  });
});
