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

/** Knob center Y inside the lane. Level is in the axis's own units. */
export function knobTop(level, laneHeight, max = 20) {
  const height = Math.max(1, Number(laneHeight) || 1);
  const usable = Math.max(1, height - TRACK_PAD * 2);
  const limit = Math.max(1, Number(max) || 20);
  const clamped = Math.min(limit, Math.max(0, Number(level) || 0));
  return TRACK_PAD + (1 - clamped / limit) * usable;
}

/** Map a 0–20 track position onto an axis max. Zero stays zero. */
export function scaleTrackLevel(trackLevel, max = 20) {
  const limit = Math.max(1, Math.round(Number(max) || 20));
  const ratio = Math.min(20, Math.max(0, Number(trackLevel) || 0)) / 20;
  if (ratio <= 0) return 0;
  return Math.min(limit, Math.round(ratio * limit));
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

const DUAL_VIBRATE = [
  { feature: 'vibrate1', label: '1', max: 20 },
  { feature: 'vibrate2', label: '2', max: 20 },
];

const AXIS_MAP = {
  gemini: DUAL_VIBRATE,
  edge: DUAL_VIBRATE,
  edge2: DUAL_VIBRATE,
  nora: [
    { feature: 'vibrate', label: '震動', max: 20 },
    { feature: 'rotate', label: '旋轉', max: 20 },
  ],
  max: [
    { feature: 'vibrate', label: '震動', max: 20 },
    { feature: 'pump', label: '充氣', max: 3 },
  ],
  max2: [
    { feature: 'vibrate', label: '震動', max: 20 },
    { feature: 'pump', label: '充氣', max: 3 },
  ],
  flexer: [
    { feature: 'vibrate', label: '震動', max: 20 },
    { feature: 'fingering', label: '指動', max: 20 },
  ],
  gravity: [{ feature: 'thrusting', label: '伸縮', max: 20 }],
  sexmachine: [{ feature: 'thrusting', label: '伸縮', max: 20 }],
  tenera: [{ feature: 'suction', label: '吸吮', max: 20 }],
  tenera2: [{ feature: 'suction', label: '吸吮', max: 20 }],
  solace: [
    { feature: 'thrusting', label: '伸縮', max: 20 },
    { feature: 'depth', label: '深度', max: 3 },
  ],
  solacepro: [
    { feature: 'thrusting', label: '伸縮', max: 20 },
    { feature: 'depth', label: '深度', max: 3 },
  ],
  lapis: [
    { feature: 'vibrate1', label: '1', max: 20 },
    { feature: 'vibrate2', label: '2', max: 20 },
    { feature: 'vibrate3', label: '3', max: 20 },
  ],
};

function typeKey(toy) {
  return String(toy?.toyType || toy?.name || '').toLowerCase().replace(/\s+/g, '');
}

/** One entry per motor or motion. Unknown toys stay a single vibrate axis. */
export function axesForToy(toy) {
  return AXIS_MAP[typeKey(toy)] || [{ feature: 'vibrate', label: '', max: 20 }];
}

function clampTo(level, max) {
  const limit = Math.max(1, Math.round(Number(max) || 20));
  const n = Math.round(Number(level));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(limit, n);
}

/**
 * Float holds on release. Loop records a stroke and plays it back.
 * Neither selected returns to 0 on release.
 * Local Sync starts off, so each lane moves on its own.
 */
export function createRemoteModel() {
  /** @type {'float' | 'loop' | 'off'} */
  let mode = 'float';
  let traditional = false;
  let localSync = false;
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

  function toyState(spec) {
    return {
      id: spec.id,
      deviceId: spec.deviceId,
      feature: spec.feature,
      max: spec.max,
      name: spec.name,
      color: colorFor(spec.id),
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

  function deviceAxes(deviceId) {
    return toys.filter((toy) => toy.deviceId === deviceId);
  }

  function isMulti(deviceId) {
    return deviceAxes(deviceId).length > 1;
  }

  function outputOf(toy, now) {
    const raw = now == null ? toy.level : shownLevel(toy, now);
    return clampTo(raw, toy.max);
  }

  function featureSignature(features) {
    return Object.keys(features).sort().map((key) => `${key}:${features[key]}`).join(',');
  }

  function devicePlan(deviceId, now) {
    const axes = deviceAxes(deviceId);
    if (!axes.length) return [];
    /** @type {Record<string, number>} */
    const features = {};
    for (const axis of axes) features[axis.feature] = outputOf(axis, now);
    const signature = featureSignature(features);
    if (lastSent.get(deviceId) === signature) return [];
    lastSent.set(deviceId, signature);
    const allZero = Object.values(features).every((value) => value === 0);
    if (allZero) return [{ action: 'stop', level: 0, toyId: deviceId, features, signature }];
    const onlyVibrate = axes.length === 1 && axes[0].feature === 'vibrate';
    if (onlyVibrate) {
      return [{
        action: 'vibrate',
        level: features.vibrate,
        toyId: deviceId,
        features,
        signature,
      }];
    }
    return [{
      action: 'function',
      level: features[axes[0].feature],
      toyId: deviceId,
      features,
      signature,
    }];
  }

  function broadcastPlan(level) {
    const rounded = clampLevel(level);
    const signature = rounded === 0 ? 'stop' : `vibrate:${rounded}`;
    if (lastSent.get('*') === signature) return [];
    lastSent.set('*', signature);
    if (rounded === 0) return [{ action: 'stop', level: 0, toyId: null }];
    return [{ action: 'vibrate', level: rounded, toyId: null }];
  }

  function holdPlans(deviceId, now) {
    lastSent.delete(deviceId);
    const plans = devicePlan(deviceId, now);
    if (!plans.length || plans[0].action === 'stop') return plans;
    return [{ action: 'stop', level: 0, toyId: deviceId }, ...plans];
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
    for (const toy of group) remember(toy, clampTo(level, toy.max), now, record);
    if (localSync) return broadcastPlan(level);
    const toy = toys.find((row) => row.id === id);
    return toy ? devicePlan(toy.deviceId, now) : [];
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
        toy.level = clampTo(level, toy.max);
        toy.samples = pushWaveSample(toy.samples, toy.level, now);
      }
      const rounded = clampLevel(level);
      lastSent.set('*', rounded === 0 ? 'stop' : `vibrate:${rounded}`);
      if (rounded === 0) return [{ action: 'stop', level: 0, toyId: null }];
      return [
        { action: 'stop', level: 0, toyId: null },
        { action: 'vibrate', level: rounded, toyId: null },
      ];
    }
    for (const toy of toys) {
      const level = shownLevel(toy, now);
      toy.loop = null;
      toy.stroke = null;
      toy.level = clampTo(level, toy.max);
      toy.samples = pushWaveSample(toy.samples, toy.level, now);
    }
    /** @type {object[]} */
    const plans = [];
    const seen = new Set();
    for (const toy of toys) {
      if (seen.has(toy.deviceId)) continue;
      seen.add(toy.deviceId);
      if (isMulti(toy.deviceId)) {
        lastSent.delete(toy.deviceId);
        plans.push(...devicePlan(toy.deviceId, now));
      } else {
        plans.push(...holdPlans(toy.deviceId, now));
      }
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
    return [...new Set(toys.map((toy) => toy.deviceId))].map((deviceId) => ({
      action: 'stop',
      level: 0,
      toyId: deviceId,
    }));
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
      /** @type {{ id: string, deviceId: string, feature: string, max: number, name: string }[]} */
      const online = [];
      for (const toy of list || []) {
        if (!toy?.id || toy.connected === false) continue;
        const axes = axesForToy(toy);
        const deviceId = String(toy.id);
        const baseName = String(toy.name || 'Toy');
        for (const axis of axes) {
          const id = axes.length > 1 ? `${deviceId}:${axis.feature}` : deviceId;
          online.push({
            id,
            deviceId,
            feature: axis.feature,
            max: axis.max,
            name: axes.length > 1 ? `${baseName} ${axis.label}` : baseName,
          });
        }
      }
      if (!online.length) {
        toys = [];
        sessionStart = null;
        dragId = null;
        lastSent.clear();
        return;
      }
      if (sessionStart == null) sessionStart = now;
      const prev = new Map(toys.map((toy) => [toy.id, toy]));
      toys = online.map((spec) => {
        const existing = prev.get(spec.id);
        if (existing) {
          existing.name = spec.name;
          existing.max = spec.max;
          existing.feature = spec.feature;
          existing.deviceId = spec.deviceId;
          return existing;
        }
        const created = toyState(spec);
        created.samples = [
          { t: now - REMOTE_WINDOW_MS, level: 0 },
          { t: now, level: 0 },
        ];
        return created;
      });
      if (dragId && !toys.some((toy) => toy.id === dragId)) dragId = null;
    },

    begin(id, level, now) {
      const toy = toys.find((row) => row.id === id);
      if (!toy) return [];
      const group = targets(id);
      const wasLooping = clearLoops(group);
      dragId = id;
      if (mode === 'loop') {
        for (const row of group) row.stroke = [];
      }
      const multi = !localSync && isMulti(toy.deviceId);
      if (wasLooping) lastSent.delete(localSync ? '*' : toy.deviceId);
      const plans = applyLevel(id, level, now);
      if (wasLooping && !multi && plans[0] && plans[0].action !== 'stop') {
        return [{ action: 'stop', level: 0, toyId: localSync ? null : toy.deviceId }, ...plans];
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
      const deviceId = group[0]?.deviceId;
      if (mode === 'off') {
        for (const toy of group) {
          toy.stroke = null;
          toy.level = 0;
          toy.samples = pushWaveSample(toy.samples, 0, now);
        }
        if (localSync) {
          lastSent.set('*', 'stop');
          return [{ action: 'stop', level: 0, toyId: null }];
        }
        lastSent.delete(deviceId);
        return devicePlan(deviceId, now);
      }
      if (mode !== 'loop') {
        for (const toy of group) toy.stroke = null;
        return [];
      }

      const source = group.find((toy) => toy.stroke?.length) || group[0];
      const stroke = source?.stroke || [];
      for (const toy of group) toy.stroke = null;
      const resampled = resampleStroke(stroke);
      const multi = !localSync && isMulti(deviceId);
      if (!resampled) {
        if (localSync) return [{ action: 'stop', level: 0, toyId: null }];
        lastSent.delete(deviceId);
        return devicePlan(deviceId, now);
      }

      const cycle = resampled.points.length * resampled.interval;
      for (const toy of group) {
        toy.loop = {
          points: resampled.points,
          interval: resampled.interval,
          startedAt: now,
          nextAt: now + cycle,
        };
        toy.level = clampTo(resampled.points[resampled.points.length - 1], toy.max);
      }
      if (multi) {
        lastSent.delete(deviceId);
        return devicePlan(deviceId, now);
      }
      const toyId = localSync ? null : deviceId;
      lastSent.delete(localSync ? '*' : deviceId);
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
          toy.level = clampTo(level, toy.max);
          if (now != null) toy.samples = pushWaveSample(toy.samples, toy.level, now);
        }
        return broadcastPlan(level);
      }
      /** @type {object[]} */
      const plans = [];
      const seen = new Set();
      for (const toy of toys) {
        if (seen.has(toy.deviceId)) continue;
        seen.add(toy.deviceId);
        plans.push(...devicePlan(toy.deviceId, now));
      }
      return plans;
    },

    tick(now) {
      /** @type {object[]} */
      const plans = [];
      if (localSync) {
        const lead = toys[0];
        if (lead?.loop && now >= lead.loop.nextAt) {
          const cycle = Math.max(1, lead.loop.points.length * lead.loop.interval);
          while (now >= lead.loop.nextAt) lead.loop.nextAt += cycle;
          plans.push(buildPatternPlan(lead.loop.points, lead.loop.interval, null));
        }
        if (lead?.loop) {
          for (const toy of toys) {
            if (toy.loop) toy.loop.nextAt = lead.loop.nextAt;
          }
        }
        return plans;
      }
      const seen = new Set();
      for (const toy of toys) {
        if (seen.has(toy.deviceId)) continue;
        seen.add(toy.deviceId);
        const axes = deviceAxes(toy.deviceId);
        if (axes.length > 1) {
          if (axes.some((axis) => axis.loop)) plans.push(...devicePlan(toy.deviceId, now));
          continue;
        }
        if (!toy.loop || now < toy.loop.nextAt) continue;
        const cycle = Math.max(1, toy.loop.points.length * toy.loop.interval);
        while (now >= toy.loop.nextAt) toy.loop.nextAt += cycle;
        plans.push(buildPatternPlan(toy.loop.points, toy.loop.interval, toy.deviceId));
      }
      return plans;
    },

    stopSession() {
      toys = [];
      sessionStart = null;
      dragId = null;
      mode = 'float';
      traditional = false;
      localSync = false;
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
        countLabel: `${new Set(toys.map((toy) => toy.deviceId)).size} Toys Connected`,
        pill: toys[0]?.name || '',
        controls: toys.map((toy) => ({
          id: toy.id,
          deviceId: toy.deviceId,
          name: toy.name,
          color: toy.color,
          max: toy.max,
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
