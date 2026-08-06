const WINDOW_MS = 60_000;

/** @typedef {{ t: number, bpm: number }} HrPoint */

/**
 * @param {HrPoint[]} points
 * @param {number} [now]
 * @returns {HrPoint[]}
 */
export function pruneHrHistory(points, now = Date.now()) {
  const cutoff = now - WINDOW_MS;
  return points.filter((p) => p.t >= cutoff);
}

/**
 * Append a sample when bpm changes (or first sample).
 * @param {HrPoint[]} points
 * @param {number} bpm
 * @param {number} [t]
 * @returns {HrPoint[]}
 */
export function pushHrSample(points, bpm, t = Date.now()) {
  if (bpm == null || Number.isNaN(bpm)) return points;
  const next = pruneHrHistory(points, t);
  const last = next[next.length - 1];
  if (last && last.bpm === bpm) return next;
  next.push({ t, bpm: Number(bpm) });
  return next;
}

/**
 * Build an SVG sparkline for the last 60 seconds.
 * @param {HrPoint[]} points
 * @param {{ width?: number, height?: number, now?: number }} [opts]
 * @returns {string}
 */
export function renderHrSparkline(points, opts = {}) {
  const width = opts.width ?? 220;
  const height = opts.height ?? 56;
  const now = opts.now ?? Date.now();
  const t0 = now - WINDOW_MS;
  const recent = pruneHrHistory(points, now);

  if (!recent.length) {
    return `
      <svg class="hr-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
        <line class="hr-chart-baseline" x1="0" y1="${height / 2}" x2="${width}" y2="${height / 2}" />
      </svg>
    `;
  }

  /** @type {HrPoint[]} */
  const series = [...recent];
  const last = series[series.length - 1];
  if (last.t < now) series.push({ t: now, bpm: last.bpm });

  const bpms = series.map((p) => p.bpm);
  let min = Math.min(...bpms);
  let max = Math.max(...bpms);
  if (min === max) {
    min -= 5;
    max += 5;
  }
  const pad = Math.max(3, (max - min) * 0.12);
  min -= pad;
  max += pad;

  const coords = series.map((p) => {
    const x = ((Math.max(t0, p.t) - t0) / WINDOW_MS) * width;
    const y = height - ((p.bpm - min) / (max - min)) * (height - 6) - 3;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  return `
    <svg class="hr-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="近 60 秒心率">
      <polyline class="hr-chart-line" fill="none" points="${coords.join(' ')}" />
    </svg>
  `;
}

export { WINDOW_MS };
