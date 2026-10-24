import { buildPatternPlan, clampLevel } from './lovense-command.js';
import { REMOTE_COLORS, REMOTE_WINDOW_MS, pushWaveSample } from './lovense-wave.js';

const SHORT_STROKE_MS = 200;
const NOMINAL_INTERVAL_MS = 150;

export const TRACK_PAD = 48;

/**
 * Top of the track is 20, bottom is 0.
 * @param {number} y
 * @param {number} height
 */
export function levelFromTrackY(y, height) {
  const h = Number(height);
  if (!Number.isFinite(h) || h <= 0) return 0;
  const ratio = 1 - Math.min(h, Math.max(0, Number(y) || 0)) / h;
  return ratio * 20;
}

/** Level from a pointer inside a lane that keeps the knob on screen. */
export function levelFromLane(clientY, rect) {
  const top = Number(rect?.top) || 0;
  const height = Number(rect?.height) || 0;
  const y = (Number(clientY) || 0) - top - TRACK_PAD;
  return levelFromTrackY(y, Math.max(1, height - TRACK_PAD * 2));
}

/** Knob center Y inside the lane. */
export function knobTop(level, laneHeight) {
  const height = Math.max(1, Number(laneHeight) || 1);
  const usable = Math.max(1, height - TRACK_PAD * 2);
  const clamped = Math.min(20, Math.max(0, Number(level) || 0));
  return TRACK_PAD + (1 - clamped / 20) * usable;
}

/** @param {number} elapsedMs */
export function formatSessionClock(elapsedMs) {
  const total = Math.max(0, Math.floor(Number(elapsedMs) / 1000) || 0);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function sampleAt(points, t) {
  if (t <= points[0].t) return points[0].level;
  for (let i = 1; i < points.length; i += 1) {
    if (t <= points[i].t) {
      const a = points[i - 1];
      const b = points[i];
      const span = b.t - a.t || 1;
      return a.level + ((b.level - a.level) * (t - a.t)) / span;
    }
  }
  return points[points.length - 1].level;
}

/**
 * Turn a finger stroke into at most 50 integer steps.
 * Strokes shorter than 200ms become one held level.
 * @param {{ t: number, level: number }[]} samples
 */
export function resampleStroke(samples) {
  const points = (samples || [])
    .filter((s) => s && Number.isFinite(s.t) && Number.isFinite(s.level))
    .slice()
    .sort((a, b) => a.t - b.t);
  if (!points.length) return null;

  const endLevel = clampLevel(points[points.length - 1].level);
  const duration = points[points.length - 1].t - points[0].t;
  if (points.length === 1 || duration < SHORT_STROKE_MS) {
    return { points: [endLevel], interval: 1000 };
  }

  const steps = Math.min(50, Math.max(2, Math.round(duration / NOMINAL_INTERVAL_MS)));
  const interval = Math.max(101, Math.round(duration / steps));
  /** @type {number[]} */
  const out = [];
  for (let i = 0; i < steps; i += 1) {
    const t = points[0].t + (i / (steps - 1)) * duration;
    out.push(clampLevel(sampleAt(points, t)));
  }
  return { points: out, interval };
}

/** Smooth value inside a looping integer pattern. */
export function loopLevelAt(points, intervalMs, elapsedMs) {
  if (!points?.length) return 0;
  const interval = Math.max(1, Number(intervalMs) || 1);
  const span = points.length * interval;
  const t = ((Number(elapsedMs) % span) + span) % span;
  const index = Math.floor(t / interval) % points.length;
  const next = points[(index + 1) % points.length];
  const mix = (t - index * interval) / interval;
  return points[index] + (next - points[index]) * mix;
}

/**
 * Float holds on release. Loop records a stroke and plays it back.
 * Neither selected returns to 0 on release.
 */
export function createRemoteModel() {
  /** @type {'float' | 'loop' | 'off'} */
  let mode = 'float';
  let traditional = false;
  let localSync = true;
  /** @type {ReturnType<toyState>[]} */
  let toys = [];
  /** @type {number | null} */
  let sessionStart = null;
  /** @type {string | null} */
  let dragId = null;
  /** @type {Map<string, number>} */
  const lastSent = new Map();
  /** @type {Map<string, string>} */
  const colors = new Map();

  function colorFor(id) {
    if (!colors.has(id)) {
      colors.set(id, REMOTE_COLORS[colors.size % REMOTE_COLORS.length]);
    }
    return colors.get(id);
  }

  function toyState(id, name) {
    return {
      id,
      name,
      color: colorFor(id),
      level: 0,
      /** @type {{ t: number, level: number }[]} */
      samples: [],
      /** @type {{ t: number, level: number }[] | null} */
      stroke: null,
      /** @type {{ points: number[], interval: number, startedAt: number, nextAt: number } | null} */
      loop: null,
    };
  }

  function targets(id) {
    if (localSync) return toys;
    return toys.filter((toy) => toy.id === id);
  }

  function sendKey(toyId) {
    return toyId || '*';
  }

  function livePlan(level, toyId) {
    const rounded = clampLevel(level);
    const key = sendKey(toyId);
    if (lastSent.get(key) === rounded) return [];
    lastSent.set(key, rounded);
    const id = toyId || null;
    if (rounded === 0) return [{ action: 'stop', level: 0, toyId: id }];
    return [{ action: 'vibrate', level: rounded, toyId: id }];
  }

  function holdPlans(level, toyId) {
    const rounded = clampLevel(level);
    const id = toyId || null;
    lastSent.set(sendKey(toyId), rounded);
    if (rounded === 0) return [{ action: 'stop', level: 0, toyId: id }];
    return [
      { action: 'stop', level: 0, toyId: id },
      { action: 'vibrate', level: rounded, toyId: id },
    ];
  }

  function shownLevel(toy, now) {
    if (!toy) return 0;
    if (toy.loop) return loopLevelAt(toy.loop.points, toy.loop.interval, now - toy.loop.startedAt);
    return toy.level;
  }

  function remember(toy, level, now, record) {
    toy.level = level;
    const last = toy.samples[toy.samples.length - 1];
    if (!last || Math.abs(last.level - level) > 0.02 || now - last.t >= 40) {
      toy.samples = pushWaveSample(toy.samples, level, now);
    }
    if (record) {
      if (!toy.stroke) toy.stroke = [];
      toy.stroke.push({ t: now, level });
    }
  }

  function applyLevel(id, level, now) {
    const group = targets(id);
    const record = mode === 'loop';
    for (const toy of group) remember(toy, level, now, record);
    return livePlan(level, localSync ? null : id);
  }

  function clearLoops(group) {
    let was = false;
    for (const toy of group) {
      if (toy.loop) was = true;
      toy.loop = null;
      toy.stroke = null;
    }
    return was;
  }

  function settle(now) {
    if (!toys.length) return [{ action: 'stop', level: 0, toyId: null }];
    if (localSync) {
      const level = shownLevel(toys[0], now);
      for (const toy of toys) {
        toy.loop = null;
        toy.stroke = null;
        toy.level = level;
        toy.samples = pushWaveSample(toy.samples, level, now);
      }
      return holdPlans(level, null);
    }
    /** @type {object[]} */
    const plans = [];
    for (const toy of toys) {
      const level = shownLevel(toy, now);
      toy.loop = null;
      toy.stroke = null;
      toy.level = level;
      toy.samples = pushWaveSample(toy.samples, level, now);
      plans.push(...holdPlans(level, toy.id));
    }
    return plans;
  }

  function zeroAll(now) {
    for (const toy of toys) {
      toy.loop = null;
      toy.stroke = null;
      toy.level = 0;
      toy.samples = pushWaveSample(toy.samples, 0, now);
    }
    lastSent.clear();
    if (!toys.length) return [];
    if (localSync) return [{ action: 'stop', level: 0, toyId: null }];
    return toys.map((toy) => ({ action: 'stop', level: 0, toyId: toy.id }));
  }

  function waveSamples(toy, now) {
    const history = (toy.samples || []).filter((s) => s.t >= now - REMOTE_WINDOW_MS && s.t <= now);
    if (!toy.loop) return history;
    const start = Math.max(toy.loop.startedAt, now - REMOTE_WINDOW_MS);
    /** @type {{ t: number, level: number }[]} */
    const synth = [];
    for (let t = start; t <= now; t += 40) {
      synth.push({
        t,
        level: loopLevelAt(toy.loop.points, toy.loop.interval, t - toy.loop.startedAt),
      });
    }
    const atNow = loopLevelAt(toy.loop.points, toy.loop.interval, now - toy.loop.startedAt);
    synth.push({ t: now, level: atNow });
    return history.filter((s) => s.t < toy.loop.startedAt).concat(synth);
  }

  return {
    setToys(list, now) {
      const online = (list || []).filter((toy) => toy && toy.id && toy.connected !== false);
      if (!online.length) {
        toys = [];
        sessionStart = null;
        dragId = null;
        lastSent.clear();
        return;
      }
      if (sessionStart == null) sessionStart = now;
      const prev = new Map(toys.map((toy) => [toy.id, toy]));
      toys = online.map((toy) => {
        const existing = prev.get(toy.id);
        if (existing) {
          existing.name = String(toy.name || existing.name || 'Toy');
          return existing;
        }
        const created = toyState(String(toy.id), String(toy.name || 'Toy'));
        created.samples = [
          { t: now - REMOTE_WINDOW_MS, level: 0 },
          { t: now, level: 0 },
        ];
        return created;
      });
      if (dragId && !toys.some((toy) => toy.id === dragId)) dragId = null;
    },

    begin(id, level, now) {
      if (!toys.some((toy) => toy.id === id)) return [];
      const group = targets(id);
      const wasLooping = clearLoops(group);
      dragId = id;
      if (mode === 'loop') {
        for (const toy of group) toy.stroke = [];
      }
      if (wasLooping) lastSent.delete(sendKey(localSync ? null : id));
      const plans = applyLevel(id, level, now);
      if (wasLooping && plans[0]?.action === 'vibrate') {
        return [{ action: 'stop', level: 0, toyId: localSync ? null : id }, ...plans];
      }
      return plans;
    },

    move(id, level, now) {
      if (dragId !== id) return [];
      return applyLevel(id, level, now);
    },

    end(id, now) {
      if (dragId !== id) return [];
      dragId = null;
      const group = targets(id);
      if (mode === 'off') {
        for (const toy of group) {
          toy.stroke = null;
          toy.level = 0;
          toy.samples = pushWaveSample(toy.samples, 0, now);
        }
        const toyId = localSync ? null : id;
        lastSent.set(sendKey(toyId), 0);
        return [{ action: 'stop', level: 0, toyId }];
      }
      if (mode !== 'loop') {
        for (const toy of group) toy.stroke = null;
        return [];
      }

      const source = group.find((toy) => toy.stroke?.length) || group[0];
      const stroke = source?.stroke || [];
      for (const toy of group) toy.stroke = null;
      const resampled = resampleStroke(stroke);
      const toyId = localSync ? null : id;
      if (!resampled) return [{ action: 'stop', level: 0, toyId }];

      const cycle = resampled.points.length * resampled.interval;
      for (const toy of group) {
        toy.loop = {
          points: resampled.points,
          interval: resampled.interval,
          startedAt: now,
          nextAt: now + cycle,
        };
        toy.level = resampled.points[resampled.points.length - 1];
      }
      lastSent.delete(sendKey(toyId));
      return [buildPatternPlan(resampled.points, resampled.interval, toyId)];
    },

    toggleFloat(now) {
      if (mode === 'float') {
        mode = 'off';
        if (dragId) return [];
        return zeroAll(now);
      }
      const leaving = mode === 'loop' || toys.some((toy) => toy.loop);
      mode = 'float';
      return leaving ? settle(now) : [];
    },

    toggleLoop(now) {
      if (mode === 'loop') {
        mode = 'float';
        return settle(now);
      }
      mode = 'loop';
      return [];
    },

    toggleTraditional() {
      traditional = !traditional;
      return [];
    },

    toggleLocalSync(now) {
      if (toys.length < 2) return [];
      localSync = !localSync;
      lastSent.clear();
      for (const toy of toys) {
        toy.loop = null;
        toy.stroke = null;
      }
      if (localSync) {
        const level = toys[0].level;
        for (const toy of toys) {
          toy.level = level;
          if (now != null) toy.samples = pushWaveSample(toy.samples, level, now);
        }
        return livePlan(level, null);
      }
      return toys.flatMap((toy) => livePlan(toy.level, toy.id));
    },

    tick(now) {
      /** @type {object[]} */
      const plans = [];
      const rows = localSync ? toys.slice(0, 1) : toys;
      for (const toy of rows) {
        if (!toy.loop || now < toy.loop.nextAt) continue;
        const cycle = Math.max(1, toy.loop.points.length * toy.loop.interval);
        while (now >= toy.loop.nextAt) toy.loop.nextAt += cycle;
        const toyId = localSync ? null : toy.id;
        plans.push(buildPatternPlan(toy.loop.points, toy.loop.interval, toyId));
      }
      if (localSync && toys[0]?.loop) {
        for (const toy of toys) {
          if (toy.loop) toy.loop.nextAt = toys[0].loop.nextAt;
        }
      }
      return plans;
    },

    stopSession() {
      toys = [];
      sessionStart = null;
      dragId = null;
      mode = 'float';
      traditional = false;
      localSync = true;
      lastSent.clear();
    },

    draggingId() {
      return dragId;
    },

    view(now) {
      return {
        mode,
        traditional,
        localSync,
        canSync: toys.length > 1,
        looping: toys.some((toy) => toy.loop),
        dragging: dragId,
        clock: formatSessionClock(sessionStart == null ? 0 : now - sessionStart),
        countLabel: `${toys.length} Toys Connected`,
        pill: toys[0]?.name || '',
        controls: toys.map((toy) => ({
          id: toy.id,
          name: toy.name,
          color: toy.color,
          level: shownLevel(toy, now),
        })),
        series: toys.map((toy) => ({
          color: toy.color,
          samples: waveSamples(toy, now),
        })),
      };
    },
  };
}
