import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import {
  createHrThrottle,
  isStale,
  pongTimedOut,
  reconnectDelayMs,
  runWsPingTick,
} from '../public/js/util.js';

describe('pongTimedOut', () => {
  it('is false when no pong has been recorded', () => {
    assert.equal(pongTimedOut(null, 50_000), false);
  });

  it('is false within the timeout window', () => {
    assert.equal(pongTimedOut(1000, 1000 + 44_000), false);
  });

  it('is true after timeoutMs', () => {
    assert.equal(pongTimedOut(1000, 1000 + 45_001), true);
  });
});

describe('runWsPingTick', () => {
  it('skips when the socket is not open', () => {
    const closed = [];
    const pings = [];
    assert.equal(
      runWsPingTick({
        readyState: 0,
        lastPongAt: 0,
        now: 50_000,
        sendPing: () => pings.push(1),
        close: () => closed.push(1),
      }),
      'skip',
    );
    assert.equal(closed.length, 0);
    assert.equal(pings.length, 0);
  });

  it('sends ping when the socket is open and pong is fresh', () => {
    const closed = [];
    const pings = [];
    assert.equal(
      runWsPingTick({
        readyState: 1,
        lastPongAt: 1000,
        now: 16_000,
        sendPing: () => pings.push(1),
        close: () => closed.push(1),
      }),
      'ping',
    );
    assert.equal(pings.length, 1);
    assert.equal(closed.length, 0);
  });

  it('closes the socket when pong has timed out', () => {
    const closed = [];
    const pings = [];
    assert.equal(
      runWsPingTick({
        readyState: 1,
        lastPongAt: 1000,
        now: 1000 + 45_001,
        sendPing: () => pings.push(1),
        close: () => closed.push(1),
      }),
      'timeout',
    );
    assert.equal(closed.length, 1);
    assert.equal(pings.length, 0);
  });
});

describe('reconnectDelayMs', () => {
  it('grows exponentially and caps at maxMs', () => {
    assert.equal(reconnectDelayMs(0), 1000);
    assert.equal(reconnectDelayMs(1), 2000);
    assert.equal(reconnectDelayMs(2), 4000);
    assert.equal(reconnectDelayMs(10), 15000);
  });
});

describe('isStale', () => {
  it('treats missing timestamps as stale', () => {
    assert.equal(isStale(null), true);
    assert.equal(isStale(undefined), true);
  });

  it('respects staleMs window', () => {
    const now = Date.now();
    assert.equal(isStale(now - 1000, 8000), false);
    assert.equal(isStale(now - 9000, 8000), true);
  });
});

describe('createHrThrottle', () => {
  it('sends on bpm change after minInterval', async () => {
    const sent = [];
    const publish = createHrThrottle(async (p) => sent.push(p), {
      minIntervalMs: 1000,
      maxSilenceMs: 4000,
    });

    assert.equal(await publish({ bpm: 70, contact: true, ts: 1000 }), true);
    assert.equal(await publish({ bpm: 71, contact: true, ts: 1500 }), false);
    assert.equal(await publish({ bpm: 71, contact: true, ts: 2100 }), true);
    assert.deepEqual(
      sent.map((p) => p.bpm),
      [70, 71],
    );
  });

  it('heartbeats same bpm after maxSilenceMs', async () => {
    const sent = [];
    const publish = createHrThrottle(async (p) => sent.push(p), {
      minIntervalMs: 1000,
      maxSilenceMs: 4000,
    });

    assert.equal(await publish({ bpm: 72, contact: true, ts: 0 }), true);
    assert.equal(await publish({ bpm: 72, contact: true, ts: 3000 }), false);
    assert.equal(await publish({ bpm: 72, contact: true, ts: 4000 }), true);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].bpm, 72);
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

    assert.equal(await publish({ bpm: 80, contact: false, ts: 0 }), false);
    assert.equal(sent.length, 0);

    shouldFail = false;
    assert.equal(await publish.flush(), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].bpm, 80);
  });

  it('rethrows non-transient send errors', async () => {
    const publish = createHrThrottle(
      async () => {
        throw new Error('PERMISSION_DENIED');
      },
      { minIntervalMs: 1000, maxSilenceMs: 4000 },
    );
    await assert.rejects(
      () => publish({ bpm: 70, contact: true, ts: 0 }),
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
    assert.equal(await publish({ bpm: 61, contact: true, ts: 100 }), false);
    assert.equal(await publish.flush(), true);
    assert.deepEqual(
      sent.map((p) => p.bpm),
      [60, 61],
    );
  });

  it('keepalive ticks respect canSend and silence window', async () => {
    mock.timers.enable({ apis: ['setInterval', 'Date'] });
    try {
      const sent = [];
      let open = true;
      const publish = createHrThrottle(async (p) => sent.push(p), {
        minIntervalMs: 1000,
        maxSilenceMs: 4000,
      });

      publish.startKeepalive(() => open);
      assert.equal(await publish({ bpm: 90, contact: true, ts: 0 }), true);

      open = false;
      mock.timers.tick(5000);
      assert.equal(sent.length, 1, 'closed socket must not keepalive');

      open = true;
      mock.timers.tick(1000);
      assert.ok(sent.length >= 2, 'keepalive should resume when open');
      assert.equal(sent.at(-1).bpm, 90);

      publish.stopKeepalive();
    } finally {
      mock.timers.reset();
    }
  });

  it('canSend false skips send but flush retries when open', async () => {
    let open = false;
    const sent = [];
    const publish = createHrThrottle(async (p) => sent.push(p), {
      minIntervalMs: 1000,
      maxSilenceMs: 4000,
    });
    publish.startKeepalive(() => open);

    assert.equal(await publish({ bpm: 55, contact: true, ts: 0 }), false);
    open = true;
    assert.equal(await publish.flush(), true);
    assert.equal(sent[0].bpm, 55);
    publish.stopKeepalive();
  });

  it('keepalive surfaces non-transient errors and stops', async () => {
    // Mock only setInterval so Date.now() stays real (silence window already elapsed).
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      const errors = [];
      let fail = false;
      const publish = createHrThrottle(
        async () => {
          if (fail) throw new Error('PERMISSION_DENIED');
        },
        { minIntervalMs: 1000, maxSilenceMs: 4000 },
      );

      assert.equal(await publish({ bpm: 66, contact: true, ts: 0 }), true);
      fail = true;
      publish.startKeepalive(
        () => true,
        (err) => errors.push(String(err?.message || err)),
      );
      mock.timers.tick(1000);
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(errors.length, 1);
      assert.match(errors[0], /PERMISSION_DENIED/);
      // Further ticks must not spam after stopKeepalive.
      mock.timers.tick(5000);
      await Promise.resolve();
      assert.equal(errors.length, 1);
    } finally {
      mock.timers.reset();
    }
  });

  it('pause ignores samples until resume', async () => {
    mock.timers.enable({ apis: ['setInterval', 'Date'] });
    try {
      const sent = [];
      const publish = createHrThrottle(async (p) => sent.push(p), {
        minIntervalMs: 1000,
        maxSilenceMs: 4000,
      });
      publish.startKeepalive(() => true);

      assert.equal(await publish({ bpm: 88, contact: true, ts: 0 }), true);
      publish.pause();
      mock.timers.tick(8000);
      assert.equal(sent.length, 1);
      assert.equal(await publish.flush(), false);
      assert.equal(await publish({ bpm: 99, contact: true, ts: Date.now() }), false);
      assert.equal(sent.length, 1);

      publish.resume();
      assert.equal(await publish({ bpm: 88, contact: true, ts: Date.now() }), true);
      assert.equal(sent.length, 2);
      publish.stopKeepalive();
    } finally {
      mock.timers.reset();
    }
  });
});
