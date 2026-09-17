import { describe, it, expect } from 'vitest';
import {
  WINDOW_MS,
  domainY,
  pruneHrHistory,
  pushHrSample,
  renderHrSparkline,
  renderSparkline,
} from '../public/js/hr-chart.js';

describe('pushHrSample', () => {
  it('skips same bpm', () => {
    let pts = pushHrSample([], 72, 1000);
    pts = pushHrSample(pts, 72, 2000);
    expect(pts).toHaveLength(1);
    expect(pts[0]).toEqual({ t: 1000, bpm: 72 });
  });

  it('appends the first sample and later bpm changes', () => {
    let pts = pushHrSample([], 72, 1000);
    pts = pushHrSample(pts, 75, 2000);
    expect(pts).toEqual([
      { t: 1000, bpm: 72 },
      { t: 2000, bpm: 75 },
    ]);
  });
});

describe('pruneHrHistory', () => {
  it('drops points older than the 60s window', () => {
    const now = 120_000;
    const pts = [
      { t: now - WINDOW_MS - 1, bpm: 60 },
      { t: now - WINDOW_MS, bpm: 64 },
      { t: now - 1_000, bpm: 70 },
    ];
    expect(pruneHrHistory(pts, now)).toEqual([
      { t: now - WINDOW_MS, bpm: 64 },
      { t: now - 1_000, bpm: 70 },
    ]);
  });
});

describe('domainY', () => {
  it('preferred domain does not collapse to ~72-75', () => {
    const [min, max] = domainY([72, 73, 74, 75], 40, 180, 'preferred');
    expect(min).toBe(40);
    expect(max).toBe(180);
  });

  it('preferred expands below 40 when data requires', () => {
    const [min, max] = domainY([32, 70], 40, 180, 'preferred');
    expect(min).toBe(32);
    expect(max).toBe(180);
  });

  it('preferred expands above 180 when data requires', () => {
    const [min, max] = domainY([90, 195], 40, 180, 'preferred');
    expect(min).toBe(40);
    expect(max).toBe(195);
  });

  it('fit still auto-pads a tight bpm range', () => {
    const [min, max] = domainY([72, 75], 40, 180, 'fit');
    expect(min).toBe(69);
    expect(max).toBe(78);
  });
});

function polylinePoints(svg) {
  const match = svg.match(/points="([^"]+)"/);
  if (!match) return [];
  return match[1].split(/\s+/).map((pair) => {
    const [x, y] = pair.split(',').map(Number);
    return { x, y };
  });
}

describe('renderHrSparkline', () => {
  it('empty svg has baseline class', () => {
    const svg = renderHrSparkline([], { now: 0 });
    expect(svg).toContain('hr-chart-baseline');
    expect(svg).not.toContain('hr-chart-line');
  });

  it('preferred scale keeps 72–75 jitter from exploding the Y axis', () => {
    const now = 60_000;
    const svg = renderHrSparkline(
      [
        { t: now - 10_000, bpm: 72 },
        { t: now - 5_000, bpm: 75 },
      ],
      { width: 100, height: 50, now },
    );
    const ys = polylinePoints(svg).map((p) => p.y);
    expect(ys.length).toBeGreaterThan(1);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(5);
  });

  it('maps time against the last 60s window, not first-to-last stretch', () => {
    const now = 60_000;
    const svg = renderHrSparkline([{ t: now - 10_000, bpm: 80 }], {
      width: 100,
      height: 50,
      now,
    });
    const xs = polylinePoints(svg).map((p) => p.x);
    expect(xs[0]).toBeCloseTo((50_000 / WINDOW_MS) * 100, 1);
    expect(xs.at(-1)).toBeCloseTo(100, 1);
  });
});

describe('renderSparkline', () => {
  it('accepts a sound-level preferred domain of -80..0', () => {
    const [min, max] = domainY([-42, -40], -80, 0, 'preferred');
    expect(min).toBe(-80);
    expect(max).toBe(0);

    const now = 60_000;
    const svg = renderSparkline(
      [
        { t: now - 2_000, value: -42 },
        { t: now - 1_000, value: -40 },
      ],
      { width: 100, height: 50, now, preferredMin: -80, preferredMax: 0 },
    );
    expect(svg).toContain('hr-chart-line');
    const ys = polylinePoints(svg).map((p) => p.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(5);
  });
});
