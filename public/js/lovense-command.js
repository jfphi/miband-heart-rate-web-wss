export const COMMAND_MIN_INTERVAL_MS = 100;

export function clampLevel(level) {
  const n = Math.round(Number(level));
  if (!Number.isFinite(n)) return 0;
  return Math.min(20, Math.max(0, n));
}

/**
 * @param {number | null} lastSent
 * @param {unknown} level
 * @param {string | null} [toyId]
 * @returns {{ action: 'skip' | 'stop' | 'vibrate', level: number, toyId: string | null }}
 */
export function planToyCommand(lastSent, level, toyId = null) {
  const next = clampLevel(level);
  const id = toyId || null;
  if (lastSent === next) return { action: 'skip', level: next, toyId: id };
  if (next === 0) return { action: 'stop', level: 0, toyId: id };
  return { action: 'vibrate', level: next, toyId: id };
}

/**
 * One pattern upload. Interval must be greater than 100ms. At most 50 steps.
 * @param {unknown[]} levels
 * @param {number} interval
 * @param {string | null} [toyId]
 */
export function buildPatternPlan(levels, interval, toyId = null) {
  const points = (levels || []).map((level) => clampLevel(level)).slice(0, 50);
  const id = toyId || null;
  if (!points.length) return { action: 'stop', level: 0, toyId: id };
  const gap = Math.max(101, Math.round(Number(interval) || 150));
  return {
    action: 'pattern',
    level: points[points.length - 1],
    strength: points.join(';'),
    interval: gap,
    time: 0,
    toyId: id,
    points,
  };
}

const SDK_FIELDS = new Set([
  'vibrate', 'rotate', 'pump', 'thrusting', 'fingering', 'suction', 'depth', 'stroke', 'oscillate', 'all',
]);

const ACTION_NAMES = {
  vibrate: 'Vibrate',
  vibrate1: 'Vibrate1',
  vibrate2: 'Vibrate2',
  vibrate3: 'Vibrate3',
  rotate: 'Rotate',
  pump: 'Pump',
  thrusting: 'Thrusting',
  fingering: 'Fingering',
  suction: 'Suction',
  depth: 'Depth',
  stroke: 'Stroke',
  oscillate: 'Oscillate',
  all: 'All',
};

/**
 * Basic SDK sendToyCommand only forwards a fixed field list.
 * Vibrate1/Vibrate2/Vibrate3 go out alone, with stopPrevious 0, so the other motor keeps running.
 * @param {{ action?: string, level?: number, toyId?: string | null, features?: Record<string, number> }} plan
 */
export function sdkCommandBody(plan) {
  const features = plan?.features
    || (plan?.action === 'vibrate' ? { vibrate: plan.level } : null);
  if (!features) return null;
  const keys = Object.keys(features).sort();
  const needsRaw = keys.some((key) => !SDK_FIELDS.has(key));
  if (!needsRaw) {
    return {
      method: 'sendToyCommand',
      body: {
        ...features,
        ...(plan.toyId ? { toyId: plan.toyId } : {}),
      },
    };
  }
  return {
    method: 'sendRawCommand',
    body: {
      command: 'Function',
      apiVer: 1,
      action: keys.map((key) => `${ACTION_NAMES[key] || key}:${features[key]}`).join(','),
      timeSec: 0,
      stopPrevious: 0,
      ...(plan.toyId ? { toy: plan.toyId } : {}),
    },
  };
}

/**
 * While a command is in flight, one plan is kept per axis.
 * Plans without an axis still share a single slot. Stop drops queued axis updates.
 * Sends are spaced by minIntervalMs so a fast SDK cannot be flooded.
 * @param {(plan: { action: string, level: number, toyId?: string | null, axisKey?: string }) => unknown} send
 * @param {{ minIntervalMs?: number, now?: () => number, delay?: (ms: number) => Promise<void> }} [options]
 */
export function createCommandQueue(send, options = {}) {
  const minIntervalMs = options.minIntervalMs ?? COMMAND_MIN_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());
  const delay = options.delay ?? ((ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  }));

  /** @type {number | string | null} */
  let lastSent = null;
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let inflight = false;
  /** @type {Map<string, { action: string, level?: number, toyId?: string | null, axisKey?: string, signature?: string }>} */
  const pending = new Map();
  /** @type {Map<string, number | string | null>} */
  const sentByAxis = new Map();
  let generation = 0;

  function planToken(plan) {
    if (!plan || plan.action === 'pattern') return null;
    return plan.signature != null ? plan.signature : (plan.level ?? null);
  }

  function slotKey(plan) {
    if (!plan?.axisKey || plan.action === 'stop') return '*';
    return plan.axisKey;
  }

  function remember(plan) {
    const key = slotKey(plan);
    if (plan.action === 'pattern') {
      lastSent = null;
      sentByAxis.delete(key);
      return;
    }
    const token = planToken(plan);
    lastSent = token;
    sentByAxis.set(key, token);
  }

  function alreadySent(plan) {
    if (!plan || plan.action === 'pattern') return false;
    return sentByAxis.get(slotKey(plan)) === planToken(plan);
  }

  function takePending() {
    const nextKey = pending.keys().next();
    if (nextKey.done) return null;
    const next = pending.get(nextKey.value);
    pending.delete(nextKey.value);
    return next;
  }

  function queuePending(plan) {
    if (plan.action === 'stop' || !plan.axisKey) {
      pending.clear();
      pending.set('*', plan);
      return;
    }
    pending.set(plan.axisKey, plan);
  }

  async function drain(gen) {
    while (gen === generation && pending.size) {
      const next = takePending();
      if (!next) return;
      if (next.action === 'pattern' || !alreadySent(next)) {
        await run(next, gen);
        return;
      }
    }
  }

  async function run(plan, gen) {
    inflight = true;
    const wait = Math.max(0, minIntervalMs - (now() - lastSentAt));
    if (wait > 0) {
      await delay(wait);
      if (gen !== generation) {
        inflight = false;
        return;
      }
    }

    let error = null;
    try {
      await send(plan);
      if (gen === generation) remember(plan);
    } catch (err) {
      error = err;
    } finally {
      if (gen === generation) lastSentAt = now();
      inflight = false;
    }

    if (gen === generation && pending.size) await drain(gen);
    if (error) throw error;
  }

  return {
    async push(level) {
      const held = pending.get('*');
      const baseline = inflight && held && held.action !== 'pattern'
        ? held.level
        : lastSent;
      return this.pushPlan(planToyCommand(
        typeof baseline === 'number' ? baseline : null,
        level,
      ));
    },
    async pushPlan(plan) {
      if (!plan || plan.action === 'skip') return plan;
      if (inflight) {
        queuePending(plan);
        return plan;
      }
      await run(plan, generation);
      return plan;
    },
    reset() {
      generation += 1;
      lastSent = null;
      lastSentAt = Number.NEGATIVE_INFINITY;
      pending.clear();
      sentByAxis.clear();
      inflight = false;
    },
    get lastSent() {
      return lastSent;
    },
  };
}
