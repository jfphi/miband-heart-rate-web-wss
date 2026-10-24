import { describe, expect, it } from 'vitest';
import {
  advancePeakHold,
  dbToWaveAmp,
  meterZone,
  playheadRatio,
  pushLevelSample,
  WAVE_WINDOW_MS,
  waveTickLabels,
  waveformColumns,
  waveformLayout,
} from '../public/js/audio/waveform.js';
import { beatPeriodMs, chooseFocus } from '../public/js/live-readout.js';

describe('dbToWaveAmp', () => {
  it('treats -60 and below as silence and -6 and above as full', () => {
    expect(dbToWaveAmp(-100)).toBe(0);
    expect(dbToWaveAmp(-60)).toBe(0);
    expect(dbToWaveAmp(-6)).toBe(1);
    expect(dbToWaveAmp(0)).toBe(1);
    const mid = dbToWaveAmp(-33);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });
});

describe('meterZone', () => {
  it('splits green, yellow, and red around -12 and -6', () => {
    expect(meterZone(-40)).toBe('ok');
    expect(meterZone(-12)).toBe('ok');
    expect(meterZone(-11)).toBe('warn');
    expect(meterZone(-6)).toBe('warn');
    expect(meterZone(-5)).toBe('hot');
  });
});

describe('waveformColumns', () => {
  it('holds the latest level through the rest of the window', () => {
    const now = 12_000;
    const amps = waveformColumns(
      [
        { t: 0, db: -60 },
        { t: 3_000, db: -6 },
      ],
      now,
      4,
      WAVE_WINDOW_MS,
    );
    expect(amps).toHaveLength(4);
    expect(amps[0]).toBe(0);
    expect(amps[1]).toBe(1);
    expect(amps[2]).toBe(1);
    expect(amps[3]).toBe(1);
  });

  it('uses the loudest sample inside a column', () => {
    const now = 12_000;
    const amps = waveformColumns(
      [
        { t: 100, db: -40 },
        { t: 500, db: -6 },
      ],
      now,
      4,
      WAVE_WINDOW_MS,
    );
    expect(amps[0]).toBe(1);
  });
});

describe('waveformLayout', () => {
  it('holds the latest level up to now and parks the playhead on the right edge', () => {
    const now = 12_000;
    const layout = waveformLayout([{ t: 3_000, db: -6 }], now, 300, 4, WAVE_WINDOW_MS);
    const after = layout.bars.filter((bar) => bar.t >= 3_000);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((bar) => bar.amp === 1)).toBe(true);
    expect(layout.playheadX).toBe(300);
  });

  it('slides a bar left by the elapsed fraction of the window', () => {
    const samples = [
      { t: 0, db: -6 },
      { t: 3_000, db: -20 },
    ];
    const width = 300;
    const first = waveformLayout(samples, 12_000, width, 4, WAVE_WINDOW_MS);
    const next = waveformLayout(samples, 12_016, width, 4, WAVE_WINDOW_MS);
    const barA = first.bars.find((bar) => bar.t === 3_000);
    const barB = next.bars.find((bar) => bar.t === 3_000);
    expect(barA).toBeTruthy();
    expect(barB).toBeTruthy();
    expect(barB.x).toBeCloseTo(barA.x - (16 / WAVE_WINDOW_MS) * width);
  });

  it('omits the playhead when nothing is in the window', () => {
    expect(waveformLayout([], 12_000, 300, 4).playheadX).toBeNull();
  });
});

describe('playheadRatio', () => {
  it('sits on the latest sample', () => {
    const now = 12_000;
    expect(playheadRatio([{ t: now - 6_000, db: -20 }], now)).toBeCloseTo(0.5);
  });

  it('is absent when there is no sample', () => {
    expect(playheadRatio([], 12_000)).toBeNull();
  });
});

describe('waveTickLabels', () => {
  it('places a tick on each second of the window', () => {
    const ticks = waveTickLabels(12_000, WAVE_WINDOW_MS, 1000);
    expect(ticks.length).toBeGreaterThanOrEqual(12);
    expect(ticks.at(-1)?.label).toBe('0');
  });
});

describe('advancePeakHold', () => {
  it('holds a loud peak and then falls back toward the current level', () => {
    const first = advancePeakHold(null, -10, 0);
    expect(first.shown).toBe(-10);
    const held = advancePeakHold(first.state, -40, 100);
    expect(held.shown).toBe(-10);
    const fallen = advancePeakHold(held.state, -40, 2_000);
    expect(fallen.shown).toBeLessThan(-10);
    expect(fallen.shown).toBeGreaterThanOrEqual(-40);
  });
});

describe('pushLevelSample', () => {
  it('keeps a repeated level when the timestamp moves', () => {
    let points = pushLevelSample([], -20, 1_000);
    points = pushLevelSample(points, -20, 1_050);
    expect(points).toEqual([
      { t: 1_000, db: -20 },
      { t: 1_050, db: -20 },
    ]);
  });
});

describe('beatPeriodMs', () => {
  it('follows the heart rate and ignores values outside 30–250', () => {
    expect(beatPeriodMs(60)).toBe(1000);
    expect(beatPeriodMs(120)).toBe(500);
    expect(beatPeriodMs(29)).toBeNull();
    expect(beatPeriodMs(251)).toBeNull();
    expect(beatPeriodMs(null)).toBeNull();
  });
});

describe('chooseFocus', () => {
  const people = [{ clientId: 'a' }, { clientId: 'b' }, { clientId: 'c' }];

  it('keeps the current person', () => {
    expect(chooseFocus(people, 'b', ['a', 'b', 'c'])).toBe('b');
  });

  it('moves to the next person when the current one leaves', () => {
    expect(chooseFocus([{ clientId: 'a' }, { clientId: 'c' }], 'b', ['a', 'b', 'c'])).toBe('c');
  });

  it('starts on the first publisher', () => {
    expect(chooseFocus(people, null, [])).toBe('a');
  });
});
