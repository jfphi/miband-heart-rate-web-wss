import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHrThrottle,
  isStale,
  normalizeContact,
  pongTimedOut,
  reconnectDelayMs,
  runWsPingTick,
} from '../public/js/util.js';

describe('pongTimedOut', () => {
  it('is false when no pong has been recorded', () => {
    expect(pongTimedOut(null, 50_000)).toBe(false);
  });

  it('is false within the timeout window', () => {
    expect(pongTimedOut(1000, 1000 + 44_000)).toBe(false);
  });

  it('is true after timeoutMs', () => {
    expect(pongTimedOut(1000, 1000 + 45_001)).toBe(true);
  });
});

describe('runWsPingTick', () => {
  it('skips when the socket is not open', () => {
    const closed = [];
    const pings = [];
    expect(
      runWsPingTick({
        readyState: 0,
        lastPongAt: 0,
        now: 50_000,
        sendPing: () => pings.push(1),
        close: () => closed.push(1),
      }),
    ).toBe('skip');
    expect(closed.length).toBe(0);
    expect(pings.length).toBe(0);
  });

  it('sends ping when the socket is open and pong is fresh', () => {
    const closed = [];
    const pings = [];
    expect(
      runWsPingTick({
        readyState: 1,
        lastPongAt: 1000,
        now: 16_000,
        sendPing: () => pings.push(1),
        close: () => closed.push(1),
      }),
    ).toBe('ping');
    expect(pings.length).toBe(1);
    expect(closed.length).toBe(0);
  });

  it('closes the socket when pong has timed out', () => {
    const closed = [];
    const pings = [];
    expect(
      runWsPingTick({
        readyState: 1,
        lastPongAt: 1000,
        now: 1000 + 45_001,
        sendPing: () => pings.push(1),
        close: () => closed.push(1),
      }),
    ).toBe('timeout');
    expect(closed.length).toBe(1);
    expect(pings.length).toBe(0);
  });
});

describe('reconnectDelayMs', () => {
  it('grows exponentially and caps at maxMs', () => {
    expect(reconnectDelayMs(0)).toBe(1000);
    expect(reconnectDelayMs(1)).toBe(2000);
    expect(reconnectDelayMs(2)).toBe(4000);
    expect(reconnectDelayMs(10)).toBe(15000);
  });
});

describe('isStale', () => {
  it('treats missing timestamps as stale', () => {
    expect(isStale(null)).toBe(true);
    expect(isStale(undefined)).toBe(true);
  });

  it('respects staleMs window', () => {
    const now = Date.now();
    expect(isStale(now - 1000, 8000)).toBe(false);
    expect(isStale(now - 9000, 8000)).toBe(true);
  });
});

describe('normalizeContact', () => {
  it('keeps null/undefined as null and does not Boolean(null)', () => {
    expect(normalizeContact(null)).toBe(null);
    expect(normalizeContact(undefined)).toBe(null);
    expect(normalizeContact(true)).toBe(true);
    expect(normalizeContact(false)).toBe(false);
  });
});

describe('createHrThrottle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends on bpm change after minInterval', async () => {
    const sent = [];
    const publish = createHrThrottle(async (p) => sent.push(p), {
      minIntervalMs: 1000,
      maxSilenceMs: 4000,
    });

    expect(await publish({ bpm: 70, contact: true, ts: 1000 })).toBe(true);
    expect(await publish({ bpm: 71, contact: true, ts: 1500 })).toBe(false);
    expect(await publish({ bpm: 71, contact: true, ts: 2100 })).toBe(true);
    expect(sent.map((p) => p.bpm)).toEqual([70, 71]);
  });

  it('heartbeats same bpm after maxSilenceMs', async () => {
    const sent = [];
    const publish = createHrThrottle(async (p) => sent.push(p), {
      minIntervalMs: 1000,
      maxSilenceMs: 4000,
    });

    expect(await publish({ bpm: 72, contact: true, ts: 0 })).toBe(true);
    expect(await publish({ bpm: 72, contact: true, ts: 3000 })).toBe(false);
    expect(await publish({ bpm: 72, contact: true, ts: 4000 })).toBe(true);
    expect(sent.length).toBe(2);
    expect(sent[1].bpm).toBe(72);
  });

  it('stores contact null without coercing to false', async () => {
    const sent = [];
    const publish = createHrThrottle(async (p) => sent.push(p), {
      minIntervalMs: 1000,
      maxSilenceMs: 4000,
    });
    expect(await publish({ bpm: 70, contact: null, ts: 0 })).toBe(true);
    expect(sent[0].contact).toBe(null);
  });

  it('keeps latest and retries after transient send failure', async () => {
    let shouldFail = true;
    const sent = [];
    const publish = createHrThrottle(
      async (p) => {
        if (shouldFail) throw new Error('WebSocket 尚未連線');
        sent.push(p);
      },
      { minIntervalMs: 1000, maxSilenceMs: 4000 },
    );

    expect(await publish({ bpm: 80, contact: false, ts: 0 })).toBe(false);
    expect(sent.length).toBe(0);

    shouldFail = false;
    expect(await publish.flush()).toBe(true);
    expect(sent.length).toBe(1);
    expect(sent[0].bpm).toBe(80);
  });

  it('rethrows non-transient send errors', async () => {
    const publish = createHrThrottle(
      async () => {
        throw new Error('PERMISSION_DENIED');
      },
      { minIntervalMs: 1000, maxSilenceMs: 4000 },
    );
    await expect(publish({ bpm: 70, contact: true, ts: 0 })).rejects.toThrow(
      /PERMISSION_DENIED/,
    );
  });

  it('flush forces send ignoring intervals', async () => {
    const sent = [];
    const publish = createHrThrottle(async (p) => sent.push(p), {
      minIntervalMs: 1000,
      maxSilenceMs: 4000,
    });

    await publish({ bpm: 60, contact: true, ts: 0 });
    expect(await publish({ bpm: 61, contact: true, ts: 100 })).toBe(false);
    expect(await publish.flush()).toBe(true);
    expect(sent.map((p) => p.bpm)).toEqual([60, 61]);
  });

  it('keepalive ticks respect canSend and silence window', async () => {
    vi.useFakeTimers();
    const sent = [];
    let open = true;
    const publish = createHrThrottle(async (p) => sent.push(p), {
      minIntervalMs: 1000,
      maxSilenceMs: 4000,
    });

    publish.startKeepalive(() => open);
    expect(await publish({ bpm: 90, contact: true, ts: 0 })).toBe(true);

    open = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent.length).toBe(1);

    open = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent.at(-1).bpm).toBe(90);

    publish.stopKeepalive();
  });

  it('canSend false skips send but flush retries when open', async () => {
    let open = false;
    const sent = [];
    const publish = createHrThrottle(async (p) => sent.push(p), {
      minIntervalMs: 1000,
      maxSilenceMs: 4000,
    });
    publish.startKeepalive(() => open);

    expect(await publish({ bpm: 55, contact: true, ts: 0 })).toBe(false);
    open = true;
    expect(await publish.flush()).toBe(true);
    expect(sent[0].bpm).toBe(55);
    publish.stopKeepalive();
  });

  it('keepalive surfaces non-transient errors and stops', async () => {
    // Fake only setInterval so Date.now() stays real (silence window already elapsed).
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const errors = [];
    let fail = false;
    const publish = createHrThrottle(
      async () => {
        if (fail) throw new Error('PERMISSION_DENIED');
      },
      { minIntervalMs: 1000, maxSilenceMs: 4000 },
    );

    expect(await publish({ bpm: 66, contact: true, ts: 0 })).toBe(true);
    fail = true;
    publish.startKeepalive(
      () => true,
      (err) => errors.push(String(err?.message || err)),
    );
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/PERMISSION_DENIED/);
    // Further ticks must not spam after stopKeepalive.
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.resolve();
    expect(errors.length).toBe(1);
  });

  it('pause stops sending until resume flushes the buffered sample', async () => {
    vi.useFakeTimers();
    const sent = [];
    const publish = createHrThrottle(async (p) => sent.push(p), {
      minIntervalMs: 1000,
      maxSilenceMs: 4000,
    });
    publish.startKeepalive(() => true);

    expect(await publish({ bpm: 88, contact: true, ts: 0 })).toBe(true);
    publish.pause();
    await vi.advanceTimersByTimeAsync(8000);
    expect(sent.length).toBe(1);
    expect(await publish.flush()).toBe(false);
    expect(await publish({ bpm: 99, contact: true, ts: Date.now() })).toBe(false);
    expect(sent.length).toBe(1);

    expect(await publish.resume()).toBe(true);
    expect(sent.length).toBe(2);
    expect(sent[1].bpm).toBe(99);
    publish.stopKeepalive();
  });

  it('resume keeps the buffer when canSend is false', async () => {
    vi.useFakeTimers();
    const sent = [];
    const publish = createHrThrottle(async (p) => sent.push(p), {
      minIntervalMs: 1000,
      maxSilenceMs: 4000,
    });
    publish.startKeepalive(() => false);
    publish.pause();
    expect(await publish({ bpm: 80, contact: true, ts: 0 })).toBe(false);
    expect(await publish.resume()).toBe(false);
    await vi.advanceTimersByTimeAsync(8000);
    expect(sent.length).toBe(0);

    publish.startKeepalive(() => true);
    expect(await publish.flush()).toBe(true);
    expect(sent.length).toBe(1);
    expect(sent[0].bpm).toBe(80);
    publish.stopKeepalive();
  });

  it('resume with no buffered sample does not send', async () => {
    const sent = [];
    const publish = createHrThrottle(async (p) => sent.push(p));
    publish.pause();
    expect(await publish.resume()).toBe(false);
    expect(sent.length).toBe(0);
  });

  it('pause after a buffered sample discards it (hr-failed path)', async () => {
    const sent = [];
    const publish = createHrThrottle(async (p) => sent.push(p));
    publish.pause();
    expect(await publish({ bpm: 99, contact: true, ts: 0 })).toBe(false);
    publish.pause();
    expect(await publish.resume()).toBe(false);
    expect(sent.length).toBe(0);
  });
});
