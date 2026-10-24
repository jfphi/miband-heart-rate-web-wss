export function clampLevel(level) {
  const n = Math.round(Number(level));
  if (!Number.isFinite(n)) return 0;
  return Math.min(20, Math.max(0, n));
}

/**
 * @param {number | null} lastSent
 * @param {unknown} level
 * @returns {{ action: 'skip' | 'stop' | 'vibrate', level: number }}
 */
export function planToyCommand(lastSent, level) {
  const next = clampLevel(level);
  if (lastSent === next) return { action: 'skip', level: next };
  if (next === 0) return { action: 'stop', level: 0 };
  return { action: 'vibrate', level: next };
}

/**
 * While a command is in flight, only the latest requested level is kept.
 * @param {(plan: { action: string, level: number }) => unknown} send
 */
export function createCommandQueue(send) {
  /** @type {number | null} */
  let lastSent = null;
  let inflight = false;
  /** @type {{ action: string, level: number } | null} */
  let pending = null;
  let generation = 0;

  async function run(plan, gen) {
    inflight = true;
    try {
      await send(plan);
      if (gen === generation) lastSent = plan.level;
    } finally {
      inflight = false;
      if (gen !== generation || !pending) return;
      const next = pending;
      pending = null;
      if (next.level !== lastSent) await run(next, gen);
    }
  }

  return {
    async push(level) {
      const baseline = inflight && pending ? pending.level : lastSent;
      const plan = planToyCommand(baseline, level);
      if (plan.action === 'skip') return plan;
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
      pending = null;
    },
    get lastSent() {
      return lastSent;
    },
  };
}
