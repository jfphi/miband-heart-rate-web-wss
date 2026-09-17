const WINDOW_MS = 60_000;

/** @typedef {{ t: number, bpm: number }} HrPoint */
/** @typedef {{ t: number, value: number }} SparkPoint */
/** @typedef {'preferred'|'fit'} YScale */

/**
 * Y-axis domain.
 * - preferred: keep [preferredMin, preferredMax] unless data is outside
 * - fit: auto-fit data with padding (legacy / tests)
 *
 * @param {number[]} values
 * @param {number} preferredMin
 * @param {number} preferredMax
 * @param {YScale} [yScale]
 * @returns {[number, number]}
 */
export function domainY(values, preferredMin, preferredMax, yScale = 'preferred') {
  const nums = (values || []).filter((v) => Number.isFinite(v));

  if (yScale === 'fit') {
    if (!nums.length) return [preferredMin, preferredMax];
    let min = Math.min(...nums);
    let max = Math.max(...nums);
    if (min === max) {
      min -= 5;
      max += 5;
    }
    const pad = Math.max(3, (max - min) * 0.12);
    return [min - pad, max + pad];
  }

  if (!nums.length) return [preferredMin, preferredMax];
  return [
    Math.min(preferredMin, Math.min(...nums)),
    Math.max(preferredMax, Math.max(...nums)),
  ];
}

/**
 * @param {{ t: number }[]} points
 * @param {number} [now]
 * @returns {typeof points}
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
 * Last-60s sparkline. Points are `{ t, value }`.
 * Reuse later for mic level with preferredMin: -80, preferredMax: 0.
 *
 * @param {SparkPoint[]} points
 * @param {{
 *   width?: number,
 *   height?: number,
 *   now?: number,
 *   preferredMin?: number,
 *   preferredMax?: number,
 *   yScale?: YScale,
 *   className?: string,
 *   lineClass?: string,
 *   baselineClass?: string,
 *   ariaLabel?: string,
 * }} [opts]
 * @returns {string}
 */
export function renderSparkline(points, opts = {}) {
  const width = opts.width ?? 220;
  const height = opts.height ?? 56;
  const now = opts.now ?? Date.now();
  const preferredMin = opts.preferredMin ?? 40;
  const preferredMax = opts.preferredMax ?? 180;
  const yScale = opts.yScale ?? 'preferred';
  const className = opts.className ?? 'hr-chart';
  const lineClass = opts.lineClass ?? 'hr-chart-line';
  const baselineClass = opts.baselineClass ?? 'hr-chart-baseline';
  const t0 = now - WINDOW_MS;
  const recent = pruneHrHistory(points || [], now);

  if (!recent.length) {
    return `
      <svg class="${className}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
        <line class="${baselineClass}" x1="0" y1="${height / 2}" x2="${width}" y2="${height / 2}" />
      </svg>
    `;
  }

  /** @type {SparkPoint[]} */
  const series = [...recent];
  const last = series[series.length - 1];
  if (last.t < now) series.push({ t: now, value: last.value });

  const [min, max] = domainY(
    series.map((p) => p.value),
    preferredMin,
    preferredMax,
    yScale,
  );
  const span = max - min || 1;

  const coords = series.map((p) => {
    const x = ((Math.max(t0, p.t) - t0) / WINDOW_MS) * width;
    const y = height - ((p.value - min) / span) * (height - 6) - 3;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const labelled = Boolean(opts.ariaLabel);
  const a11y = labelled
    ? ` role="img" aria-label="${opts.ariaLabel}"`
    : ' aria-hidden="true"';

  return `
    <svg class="${className}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"${a11y}>
      <polyline class="${lineClass}" fill="none" points="${coords.join(' ')}" />
    </svg>
  `;
}

/**
 * HR sparkline for the last 60 seconds.
 * Default Y domain is 40–180 (preferred); set yScale: 'fit' for auto-fit.
 *
 * @param {HrPoint[]} points
 * @param {{
 *   width?: number,
 *   height?: number,
 *   now?: number,
 *   preferredMin?: number,
 *   preferredMax?: number,
 *   yScale?: YScale,
 * }} [opts]
 * @returns {string}
 */
export function renderHrSparkline(points, opts = {}) {
  const series = (points || []).map((p) => ({ t: p.t, value: p.bpm }));
  return renderSparkline(series, {
    preferredMin: 40,
    preferredMax: 180,
    yScale: 'preferred',
    className: 'hr-chart',
    lineClass: 'hr-chart-line',
    baselineClass: 'hr-chart-baseline',
    ariaLabel: '近 60 秒心率',
    ...opts,
  });
}

export { WINDOW_MS };
