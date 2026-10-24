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

/**
 * While a command is in flight, only the latest plan is kept.
 * Sends are spaced by minIntervalMs so a fast SDK cannot be flooded.
 * @param {(plan: { action: string, level: number, toyId?: string | null }) => unknown} send
 * @param {{ minIntervalMs?: number, now?: () => number, delay?: (ms: number) => Promise<void> }} [options]
 */
export function createCommandQueue(send, options = {}) {
  const minIntervalMs = options.minIntervalMs ?? COMMAND_MIN_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());
  const delay = options.delay ?? ((ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  }));

  /** @type {number | null} */
  let lastSent = null;
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let inflight = false;
  /** @type {{ action: string, level?: number, toyId?: string | null } | null} */
  let pending = null;
  let generation = 0;

  function remember(plan) {
    if (plan.action === 'pattern') lastSent = null;
    else lastSent = plan.level ?? null;
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

    if (gen === generation && pending) {
      const next = pending;
      pending = null;
      if (!(next.action === 'vibrate' && next.level === lastSent)) {
        await run(next, gen);
      }
    }
    if (error) throw error;
  }

  return {
    async push(level) {
      const baseline = inflight && pending && pending.action !== 'pattern'
        ? pending.level
        : lastSent;
      return this.pushPlan(planToyCommand(baseline ?? null, level));
    },
    async pushPlan(plan) {
      if (!plan || plan.action === 'skip') return plan;
      if (inflight) {
        pending = plan;
        return plan;
      }
      await run(plan, generation);
      return plan;
    },
    reset() {
      generation += 1;
      lastSent = null;
      lastSentAt = Number.NEGATIVE_INFINITY;
      pending = null;
      inflight = false;
    },
    get lastSent() {
      return lastSent;
    },
  };
}
