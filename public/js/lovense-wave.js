/** Command history for the remote stage. Levels are 0–20, not audio. */

export const REMOTE_WINDOW_MS = 10_000;
export const REMOTE_LEVEL_MAX = 20;
export const REMOTE_COLORS = ['#ff3d8e', '#3dcbff', '#c084fc', '#f4d35e'];

/**
 * Keep samples inside the visible window.
 * @param {{ t: number, level: number }[]} points
 */
export function pushWaveSample(points, level, t = Date.now(), windowMs = REMOTE_WINDOW_MS) {
  if (!Number.isFinite(level) || !Number.isFinite(t)) return points ? points.slice() : [];
  const cutoff = t - windowMs;
  const next = (points || []).filter((p) => p && p.t >= cutoff && p.t <= t);
  const last = next[next.length - 1];
  if (last && last.t === t && last.level === level) return next;
  next.push({ t, level: Number(level) });
  return next;
}

/**
 * Polyline in CSS pixels. The last sample is held through `now`.
 * Level 0 sits near the bottom and 20 near the top.
 * @returns {{ x: number, y: number }[]}
 */
export function wavePoints(samples, now, width, height, windowMs = REMOTE_WINDOW_MS) {
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  const sorted = (samples || [])
    .filter((s) => s && Number.isFinite(s.t) && Number.isFinite(s.level) && s.t <= now && s.t >= now - windowMs)
    .slice()
    .sort((a, b) => a.t - b.t);
  if (!sorted.length) return [];

  const series = sorted.slice();
  const last = series[series.length - 1];
  if (last.t < now) series.push({ t: now, level: last.level });

  const t0 = now - windowMs;
  const pad = 8;
  const inner = Math.max(1, h - pad * 2);
  return series.map((p) => {
    const clamped = Math.min(REMOTE_LEVEL_MAX, Math.max(0, p.level));
    return {
      x: ((p.t - t0) / windowMs) * w,
      y: pad + (1 - clamped / REMOTE_LEVEL_MAX) * inner,
    };
  });
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ series?: { color?: string, samples?: { t: number, level: number }[] }[], now: number, width: number, height: number, windowMs?: number }} layout
 */
export function drawRemoteWave(ctx, layout) {
  if (!ctx || !layout) return;
  const width = Math.max(1, Number(layout.width) || 1);
  const height = Math.max(1, Number(layout.height) || 1);
  const now = layout.now;
  const windowMs = layout.windowMs ?? REMOTE_WINDOW_MS;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#050505';
  ctx.fillRect(0, 0, width, height);

  (layout.series || []).forEach((line, index) => {
    const pts = wavePoints(line.samples, now, width, height, windowMs);
    if (pts.length < 2) return;
    const shift = index * 3;
    ctx.save();
    ctx.strokeStyle = line.color || REMOTE_COLORS[0];
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowColor = line.color || REMOTE_COLORS[0];
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y + shift);
    for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y + shift);
    ctx.stroke();
    ctx.restore();
  });
}
