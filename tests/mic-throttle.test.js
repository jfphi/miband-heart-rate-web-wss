import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMicThrottle,
  dbToMeterPercent,
  isMicStale,
} from '../public/js/audio/micThrottle.js';

describe('createMicThrottle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('heartbeats same db after maxSilenceMs', async () => {
    const sent = [];
    const publish = createMicThrottle(async (p) => sent.push(p), {
      minIntervalMs: 1000,
      maxSilenceMs: 4000,
    });

    expect(await publish({ db: -40, ts: 1000 })).toBe(true);
    expect(await publish({ db: -40, ts: 1500 })).toBe(false);
    expect(sent.map((p) => p.db)).toEqual([-40]);
    expect(await publish({ db: -40, ts: 5000 })).toBe(true);
    expect(sent.map((p) => p.db)).toEqual([-40, -40]);
  });

  it('flush forces send ignoring intervals', async () => {
    const sent = [];
    const publish = createMicThrottle(async (p) => sent.push(p), {
      minIntervalMs: 1000,
      maxSilenceMs: 4000,
    });

    await publish({ db: -30, ts: 0 });
    expect(await publish({ db: -29, ts: 100 })).toBe(false);
    expect(await publish.flush()).toBe(true);
    expect(sent.map((p) => p.db)).toEqual([-30, -29]);
  });

  it('reset drops pending so clear is not overwritten', async () => {
    vi.useFakeTimers();
    const sent = [];
    const publish = createMicThrottle(async (p) => sent.push(p), {
      minIntervalMs: 1000,
      maxSilenceMs: 4000,
    });
    publish.startKeepalive(() => true);

    expect(await publish({ db: -50, ts: 0 })).toBe(true);
    expect(await publish({ db: -40, ts: 200 })).toBe(false);
    publish.reset();
    expect(await publish.flush()).toBe(false);
    await vi.advanceTimersByTimeAsync(8000);
    expect(sent.map((p) => p.db)).toEqual([-50]);

    expect(await publish({ db: -10, ts: Date.now() })).toBe(true);
    expect(sent.map((p) => p.db)).toEqual([-50, -10]);
    publish.stopKeepalive();
  });

  it('reset invalidates an in-flight send', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const sent = [];
    const publish = createMicThrottle(async (p) => {
      await gate;
      sent.push(p.db);
    });

    const first = publish({ db: -20, ts: 0 });
    publish.reset();
    release();
    expect(await first).toBe(false);
    expect(await publish({ db: -8, ts: 50 })).toBe(true);
    expect(sent).toEqual([-20, -8]);
  });
});

describe('isMicStale', () => {
  it('treats missing timestamp as stale', () => {
    expect(isMicStale(null)).toBe(true);
  });

  it('uses stale window', () => {
    const now = Date.now();
    expect(isMicStale(now - 1000, 8000)).toBe(false);
    expect(isMicStale(now - 9000, 8000)).toBe(true);
  });
});

describe('dbToMeterPercent', () => {
  it('maps -100..0 to 0..100', () => {
    expect(dbToMeterPercent(-100)).toBe(0);
    expect(dbToMeterPercent(0)).toBe(100);
    expect(dbToMeterPercent(-50)).toBe(50);
    expect(dbToMeterPercent(null)).toBe(0);
  });
});
