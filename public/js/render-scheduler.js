/**
 * Coalesce watch-page paints so data can arrive often
 * while the DOM is rebuilt at most once per minIntervalMs.
 */

export function publisherStructureKey(members) {
  return (members || [])
    .filter((m) => m && m.role === 'publisher' && m.clientId)
    .map((m) => String(m.clientId))
    .sort()
    .join('|');
}

export function createRenderScheduler(options = {}) {
  const paint = options.paint;
  if (typeof paint !== 'function') {
    throw new TypeError('createRenderScheduler requires paint()');
  }

  const minIntervalMs = options.minIntervalMs ?? 1000;
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule ?? ((fn) => requestAnimationFrame(fn));
  const cancelSchedule =
    options.cancelSchedule ?? ((id) => cancelAnimationFrame(id));
  const scheduleTimeout =
    options.scheduleTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn = options.clearTimeout ?? ((id) => clearTimeout(id));
  const scheduleInterval =
    options.scheduleInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = options.clearInterval ?? ((id) => clearInterval(id));

  let dirty = false;
  /** @type {number | null} */
  let lastPaintAt = null;
  let frameId = null;
  let trailingId = null;
  let clockId = null;

  function clearFrame() {
    if (frameId != null) {
      cancelSchedule(frameId);
      frameId = null;
    }
  }

  function clearTrailing() {
    if (trailingId != null) {
      clearTimeoutFn(trailingId);
      trailingId = null;
    }
  }

  function runPaint() {
    frameId = null;
    if (!dirty) return;
    dirty = false;
    lastPaintAt = now();
    clearTrailing();
    paint();
  }

  function armFrame() {
    if (frameId != null) return;
    frameId = schedule(runPaint);
  }

  function armTrailing(waitMs) {
    if (trailingId != null) return;
    trailingId = scheduleTimeout(() => {
      trailingId = null;
      if (!dirty) return;
      armFrame();
    }, Math.max(0, waitMs));
  }

  function request(opts = {}) {
    dirty = true;
    const t = now();
    const elapsed = lastPaintAt == null ? Number.POSITIVE_INFINITY : t - lastPaintAt;
    if (opts.immediate || elapsed >= minIntervalMs) {
      clearTrailing();
      armFrame();
      return;
    }
    armTrailing(minIntervalMs - elapsed);
  }

  function startClock(intervalMs = 1000) {
    if (clockId != null) return;
    clockId = scheduleInterval(() => {
      request();
    }, intervalMs);
  }

  function stop() {
    clearFrame();
    clearTrailing();
    if (clockId != null) {
      clearIntervalFn(clockId);
      clockId = null;
    }
    dirty = false;
  }

  return { request, startClock, stop };
}
