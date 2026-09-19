import { describe, expect, it } from 'vitest';
import {
  createRenderScheduler,
  publisherStructureKey,
} from '../public/js/render-scheduler.js';

function createHarness() {
  let time = 0;
  let nextId = 1;
  const frames = [];
  const timeouts = new Map();
  const intervals = new Map();
  const paints = [];

  const scheduler = createRenderScheduler({
    minIntervalMs: 1000,
    now: () => time,
    paint: () => {
      paints.push(time);
    },
    schedule: (fn) => {
      const id = nextId++;
      frames.push({ id, fn });
      return id;
    },
    cancelSchedule: (id) => {
      const i = frames.findIndex((item) => item.id === id);
      if (i >= 0) frames.splice(i, 1);
    },
    scheduleTimeout: (fn, ms) => {
      const id = nextId++;
      timeouts.set(id, { fn, at: time + ms });
      return id;
    },
    clearTimeout: (id) => {
      timeouts.delete(id);
    },
    scheduleInterval: (fn, ms) => {
      const id = nextId++;
      intervals.set(id, { fn, every: ms, at: time + ms });
      return id;
    },
    clearInterval: (id) => {
      intervals.delete(id);
    },
  });

  function flushFrames() {
    const batch = frames.splice(0, frames.length);
    for (const item of batch) item.fn();
  }

  function fireDueTimers() {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const [id, timer] of [...timeouts]) {
        if (timer.at <= time) {
          timeouts.delete(id);
          timer.fn();
          progressed = true;
        }
      }
      for (const timer of intervals.values()) {
        while (timer.at <= time) {
          timer.at += timer.every;
          timer.fn();
          progressed = true;
        }
      }
    }
  }

  function advance(ms) {
    time += ms;
    fireDueTimers();
    flushFrames();
  }

  return {
    scheduler,
    paints,
    get time() {
      return time;
    },
    flushFrames,
    advance,
  };
}

describe('publisherStructureKey', () => {
  it('joins sorted publisher ids and ignores viewers', () => {
    expect(
      publisherStructureKey([
        { role: 'viewer', clientId: 'v1' },
        { role: 'publisher', clientId: 'b' },
        { role: 'publisher', clientId: 'a' },
      ]),
    ).toBe('a|b');
  });

  it('changes when a publisher appears or leaves', () => {
    const empty = publisherStructureKey([]);
    const one = publisherStructureKey([{ role: 'publisher', clientId: 'p1' }]);
    const two = publisherStructureKey([
      { role: 'publisher', clientId: 'p1' },
      { role: 'publisher', clientId: 'p2' },
    ]);
    expect(empty).not.toBe(one);
    expect(one).not.toBe(two);
  });
});

describe('createRenderScheduler', () => {
  it('paints on the next scheduled frame, not synchronously', () => {
    const h = createHarness();
    h.scheduler.request();
    expect(h.paints).toEqual([]);
    h.flushFrames();
    expect(h.paints).toEqual([0]);
  });

  it('coalesces multiple request() calls within 1s into one paint', () => {
    const h = createHarness();
    h.scheduler.request();
    h.flushFrames();
    h.scheduler.request();
    h.scheduler.request();
    h.scheduler.request();
    h.flushFrames();
    expect(h.paints).toEqual([0]);
  });

  it('trailing-flushes a coalesced update after minInterval', () => {
    const h = createHarness();
    h.scheduler.request();
    h.flushFrames();
    h.scheduler.request();
    h.scheduler.request();
    h.flushFrames();
    expect(h.paints).toEqual([0]);
    h.advance(1000);
    expect(h.paints).toEqual([0, 1000]);
  });

  it('lets immediate jump the queue before minInterval', () => {
    const h = createHarness();
    h.scheduler.request();
    h.flushFrames();
    h.scheduler.request();
    h.scheduler.request({ immediate: true });
    h.flushFrames();
    expect(h.paints).toEqual([0, 0]);
  });

  it('clock paints with no data updates so age/charts keep moving', () => {
    const h = createHarness();
    h.scheduler.startClock(1000);
    h.flushFrames();
    expect(h.paints).toEqual([]);
    h.advance(1000);
    expect(h.paints).toEqual([1000]);
    h.advance(1000);
    expect(h.paints).toEqual([1000, 2000]);
  });

  it('merges clock with hr/mic requests in the same second', () => {
    const h = createHarness();
    h.scheduler.startClock(1000);
    h.scheduler.request();
    h.flushFrames();
    h.scheduler.request();
    h.advance(1000);
    expect(h.paints).toEqual([0, 1000]);
  });

  it('stop cancels pending frames, trailing timeouts, and clock', () => {
    const h = createHarness();
    h.scheduler.startClock(1000);
    h.scheduler.request();
    h.scheduler.stop();
    h.flushFrames();
    h.advance(2000);
    expect(h.paints).toEqual([]);
  });
});
