import { describe, expect, it } from 'vitest';
import { wavePoints, pushWaveSample } from '../public/js/lovense-wave.js';

describe('pushWaveSample', () => {
  it('drops samples that leave the 10 second window', () => {
    let points = pushWaveSample([], 4, 0, 10_000);
    points = pushWaveSample(points, 8, 12_000, 10_000);
    expect(points).toEqual([{ t: 12_000, level: 8 }]);
  });
});

describe('wavePoints', () => {
  it('holds the last level through now', () => {
    const pts = wavePoints([{ t: 1000, level: 10 }], 3000, 100, 50, 10_000);
    expect(pts).toHaveLength(2);
    expect(pts[0].x).toBeCloseTo(80);
    expect(pts[1].x).toBeCloseTo(100);
    expect(pts[1].y).toBeCloseTo(pts[0].y);
  });

  it('maps 20 to the top and 0 to the bottom', () => {
    const high = wavePoints([{ t: 0, level: 20 }], 0, 100, 50, 10_000);
    const low = wavePoints([{ t: 0, level: 0 }], 0, 100, 50, 10_000);
    expect(high[0].y).toBeLessThan(low[0].y);
    expect(high[0].y).toBeCloseTo(8);
    expect(low[0].y).toBeCloseTo(42);
  });

  it('returns nothing before the first sample', () => {
    expect(wavePoints([], 1000, 80, 40)).toEqual([]);
  });
});
