/** Live level waveform. Bars are loudness, not a PCM recording. */

export const WAVE_WINDOW_MS = 12_000;
export const WAVE_SILENCE_DB = -60;
export const WAVE_FULL_DB = -6;
const WAVE_LABEL_MS = 1000;

/**
 * Map dBFS onto a recorder-style bar height.
 * -60 and below is silence, -6 and above is full.
 * The curve stays near linear inside that window so speech stays visible.
 * @param {number | null | undefined} db
 */
export function dbToWaveAmp(db) {
  if (db == null || !Number.isFinite(db)) return 0;
  if (db <= WAVE_SILENCE_DB) return 0;
  if (db >= WAVE_FULL_DB) return 1;
  const norm = (db - WAVE_SILENCE_DB) / (WAVE_FULL_DB - WAVE_SILENCE_DB);
  return norm ** 0.85;
}

/** Green at or below -12 dB, yellow through -6, red above that. */
export function meterZone(db) {
  if (db == null || !Number.isFinite(db) || db <= -12) return 'ok';
  if (db <= -6) return 'warn';
  return 'hot';
}

/**
 * Peak mark holds, then falls toward the current level.
 * @param {{ db: number, releaseAt: number } | null} state
 */
export function advancePeakHold(state, db, now, { holdMs = 800, fallDbPerSec = 18 } = {}) {
  const current = Number.isFinite(db) ? db : WAVE_SILENCE_DB;
  let held = state;
  if (!held || current >= held.db) {
    held = { db: current, releaseAt: now + holdMs };
  }
  let shown = held.db;
  if (now > held.releaseAt) {
    shown = held.db - ((now - held.releaseAt) / 1000) * fallDbPerSec;
  }
  if (shown <= current) {
    held = { db: current, releaseAt: now + holdMs };
    shown = current;
  }
  return { state: held, shown };
}

/**
 * Keep level samples inside the visible window.
 * Same levels are kept so a steady tone still has a timestamp.
 * @param {{ t: number, db: number }[]} points
 */
export function pushLevelSample(points, db, t = Date.now(), windowMs = WAVE_WINDOW_MS) {
  if (db == null || !Number.isFinite(db)) return points;
  const cutoff = t - windowMs;
  const next = (points || []).filter((p) => p.t >= cutoff && p.t <= t);
  const last = next[next.length - 1];
  if (last && last.t === t && last.db === db) return next;
  next.push({ t, db: Number(db) });
  return next;
}

function sortedLevels(samples) {
  return (samples || [])
    .filter((s) => s && Number.isFinite(s.t) && Number.isFinite(s.db))
    .slice()
    .sort((a, b) => a.t - b.t);
}

function latestAtOrBefore(sorted, now) {
  let latest = null;
  for (const sample of sorted) {
    if (sample.t <= now) latest = sample.t;
  }
  return latest;
}

/**
 * Peak dB inside [start, end), otherwise the level held from earlier.
 * After the latest sample, keep that level so the wave runs up to now.
 * @param {{ t: number, db: number }[]} sorted
 */
function peakColumn(sorted, start, end, now, latest, held) {
  if (latest == null || start > now) return { peak: null, held };
  if (start > latest) return { peak: held, held };
  let peak = null;
  for (const sample of sorted) {
    if (sample.t < start) continue;
    if (sample.t >= end || sample.t > now) break;
    peak = peak == null ? sample.db : Math.max(peak, sample.db);
  }
  if (peak == null) peak = held;
  return { peak, held: peak == null ? held : peak };
}

/**
 * One amplitude per column, aligned to the window start.
 * Gaps hold the previous peak through the column that contains now.
 * @returns {number[]}
 */
export function waveformColumns(samples, now, columnCount, windowMs = WAVE_WINDOW_MS) {
  const count = Math.max(1, columnCount | 0);
  const amps = new Array(count).fill(0);
  const sorted = sortedLevels(samples);
  const latest = latestAtOrBefore(sorted, now);
  if (latest == null || latest < now - windowMs) return amps;

  const t0 = now - windowMs;
  const slice = windowMs / count;
  let held = null;
  for (const sample of sorted) {
    if (sample.t < t0) held = sample.db;
    else break;
  }

  for (let i = 0; i < count; i += 1) {
    const start = t0 + i * slice;
    const end = i === count - 1 ? now + 1 : start + slice;
    const next = peakColumn(sorted, start, end, now, latest, held);
    held = next.held;
    if (next.peak != null) amps[i] = dbToWaveAmp(next.peak);
  }
  return amps;
}

/**
 * Bars on a fixed time grid, shifted by the fractional column so they glide.
 * The latest level is held through the column that contains now.
 * Playhead sits on the right edge while any sample is inside the window.
 * @returns {{ bars: { x: number, amp: number, t: number }[], playheadX: number | null, slot: number }}
 */
export function waveformLayout(samples, now, width, columnCount, windowMs = WAVE_WINDOW_MS) {
  const count = Math.max(1, columnCount | 0);
  const w = Math.max(1, Number(width) || 1);
  const slice = windowMs / count;
  const slot = w / count;
  const t0 = now - windowMs;
  const origin = Math.floor(t0 / slice) * slice;
  const sorted = sortedLevels(samples);
  const latest = latestAtOrBefore(sorted, now);
  /** @type {{ x: number, amp: number, t: number }[]} */
  const bars = [];
  if (latest == null || latest < t0) {
    return { bars, playheadX: null, slot };
  }

  let held = null;
  for (const sample of sorted) {
    if (sample.t < origin) held = sample.db;
    else break;
  }

  const lastIndex = Math.floor((now - origin) / slice);
  for (let i = 0; i <= lastIndex; i += 1) {
    const start = origin + i * slice;
    if (start > now) break;
    const next = peakColumn(sorted, start, start + slice, now, latest, held);
    held = next.held;
    if (next.peak == null) continue;
    bars.push({
      t: start,
      x: ((start - t0) / windowMs) * w,
      amp: dbToWaveAmp(next.peak),
    });
  }

  return { bars, playheadX: w, slot };
}

/** 0–1 across the window, or null when nothing has been drawn yet. */
export function playheadRatio(samples, now, windowMs = WAVE_WINDOW_MS) {
  const latest = latestAtOrBefore(sortedLevels(samples), now);
  if (latest == null || latest < now - windowMs) return null;
  return (latest - (now - windowMs)) / windowMs;
}

/** One tick per second. `label` is seconds relative to now. */
export function waveTickLabels(now, windowMs = WAVE_WINDOW_MS, stepMs = WAVE_LABEL_MS) {
  const t0 = now - windowMs;
  const first = Math.ceil(t0 / stepMs) * stepMs;
  /** @type {{ t: number, label: string }[]} */
  const ticks = [];
  for (let t = first; t <= now; t += stepMs) {
    const sec = Math.round((t - now) / 1000);
    ticks.push({ t, label: String(sec) });
  }
  return ticks;
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {{
 *   width: number,
 *   height: number,
 *   waveH: number,
 *   bars?: { x: number, amp: number }[],
 *   slot?: number,
 *   playheadX?: number | null,
 *   ticks: { t: number, label: string, showLabel?: boolean }[],
 *   now: number,
 *   windowMs?: number,
 * }} layout
 */
export function drawWaveform(ctx, layout) {
  const width = layout.width;
  const height = layout.height;
  const waveH = layout.waveH;
  const windowMs = layout.windowMs ?? WAVE_WINDOW_MS;
  const t0 = layout.now - windowMs;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#12151c';
  ctx.fillRect(0, 0, width, waveH);

  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, waveH / 2);
  ctx.lineTo(width, waveH / 2);
  ctx.stroke();

  const bars = layout.bars || [];
  const slot = layout.slot || width / Math.max(1, bars.length);
  const barW = Math.max(1, slot - 1);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, waveH);
  ctx.clip();
  ctx.fillStyle = 'rgba(241, 250, 238, 0.82)';
  const mid = waveH / 2;
  for (const bar of bars) {
    if (bar.amp <= 0) continue;
    const barH = Math.max(1, bar.amp * (waveH / 2 - 2));
    ctx.fillRect(bar.x, mid - barH, barW, barH * 2);
  }
  ctx.restore();

  if (layout.playheadX != null) {
    const x = Math.min(layout.playheadX, width - 1);
    ctx.strokeStyle = '#48cae4';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, waveH);
    ctx.stroke();
  }

  ctx.fillStyle = 'rgba(168, 178, 193, 0.95)';
  ctx.font = '10px sans-serif';
  ctx.textBaseline = 'bottom';
  for (const tick of layout.ticks || []) {
    const x = ((tick.t - t0) / windowMs) * width;
    ctx.fillRect(x, waveH + 1, 1, 4);
    if (tick.showLabel !== false) ctx.fillText(tick.label, Math.min(width - 16, x + 2), height - 1);
  }
}
