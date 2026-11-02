import { describe, expect, it } from 'vitest';
import { waveformLayout } from '../public/js/audio/waveform.js';
import { wavePoints } from '../public/js/lovense-wave.js';
import {
  HEART_DOMAIN_GAP_MS,
  HEART_DOMAIN_TAU_MS,
  advanceHeartDomain,
  continuesHeartSeries,
  heartDomain,
  heartPoints,
  heartSeries,
  seriesX,
  stepHeartDomain,
} from '../public/js/wave-stage.js';
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

describe('heart lane scale', () => {
  const height = 64;
  const pad = 6;
  const inner = height - pad * 2;
  const fixedY = (bpm) => pad + (1 - (bpm - 40) / 140) * inner;

  it('opens a 72–75 change well past the fixed 40–180 scale', () => {
    const now = 12_000;
    const pts = heartPoints(
      [
        { t: now - 10_000, bpm: 72 },
        { t: now - 5_000, bpm: 75 },
      ],
      now,
      240,
      height,
      12_000,
    );
    const span = Math.abs(pts[0].y - pts[1].y);
    expect(span).toBeGreaterThan(Math.abs(fixedY(72) - fixedY(75)) + 10);
    expect(span).toBeCloseTo((3 / 9) * inner, 5);
  });

  it('keeps a constant bpm on one horizontal line', () => {
    const now = 12_000;
    const pts = heartPoints([{ t: now - 1_000, bpm: 72 }], now, 240, height);
    expect(pts.length).toBeGreaterThan(1);
    expect(pts[0].y).toBeCloseTo(pts[1].y);
  });

  it('keeps bpm outside 40–180 inside the lane padding', () => {
    const now = 12_000;
    const pts = heartPoints(
      [
        { t: now - 8_000, bpm: 30 },
        { t: now - 2_000, bpm: 200 },
      ],
      now,
      240,
      height,
    );
    expect(pts[0].y).toBeGreaterThan(pts[1].y);
    for (const p of pts) {
      expect(p.y).toBeGreaterThanOrEqual(pad);
      expect(p.y).toBeLessThanOrEqual(height - pad);
    }
  });

  it('expands in one step and only partly shrinks', () => {
    expect(stepHeartDomain([70, 80], [60, 90], 16)).toEqual([60, 90]);
    const shrink = 1 - Math.exp(-16 / HEART_DOMAIN_TAU_MS);
    const eased = stepHeartDomain([60, 100], [70, 90], 16);
    expect(eased[0]).toBeCloseTo(60 + 10 * shrink);
    expect(eased[1]).toBeCloseTo(100 - 10 * shrink);
    expect(eased).not.toEqual([70, 90]);
  });

  it('snaps after a hidden-tab gap and clears when the window is empty', () => {
    expect(stepHeartDomain([60, 100], [70, 90], HEART_DOMAIN_GAP_MS)).toEqual([70, 90]);
    const now = 20_000;
    const stale = heartSeries([{ t: now - 30_000, bpm: 72 }], now);
    expect(stale).toEqual([]);
    expect(advanceHeartDomain([64, 80], stale, 16)).toBeNull();
  });

  it('drops the held domain when the next series does not continue', () => {
    const prev = [{ t: 1_000, bpm: 72 }];
    expect(continuesHeartSeries(prev, [...prev, { t: 2_000, bpm: 75 }])).toBe(true);
    expect(continuesHeartSeries(prev, [{ t: 5_000, bpm: 80 }])).toBe(false);
    expect(continuesHeartSeries(prev, [])).toBe(false);
    expect(heartDomain([{ bpm: 72 }, { bpm: 75 }])).toEqual([69, 78]);
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
