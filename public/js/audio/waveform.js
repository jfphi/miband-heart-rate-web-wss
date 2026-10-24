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
 * One amplitude per column. Gaps before the latest sample hold the previous peak.
 * Columns after the latest sample stay empty so the playhead can sit in front of them.
 * @returns {number[]}
 */
export function waveformColumns(samples, now, columnCount, windowMs = WAVE_WINDOW_MS) {
  const count = Math.max(1, columnCount | 0);
  const amps = new Array(count).fill(0);
  const sorted = sortedLevels(samples);
  const latest = latestAtOrBefore(sorted, now);
  if (latest == null) return amps;

  const t0 = now - windowMs;
  const slice = windowMs / count;
  let held = null;
  for (const sample of sorted) {
    if (sample.t < t0) held = sample.db;
    else break;
  }

  let index = 0;
  for (let i = 0; i < count; i += 1) {
    const start = t0 + i * slice;
    const end = i === count - 1 ? now + 1 : start + slice;
    if (start > latest) break;
    let peak = null;
    while (index < sorted.length && sorted[index].t < start) index += 1;
    let j = index;
    while (j < sorted.length && sorted[j].t < end && sorted[j].t <= now) {
      peak = peak == null ? sorted[j].db : Math.max(peak, sorted[j].db);
      j += 1;
    }
    if (peak == null) peak = held;
    if (peak != null) {
      held = peak;
      amps[i] = dbToWaveAmp(peak);
    }
  }
  return amps;
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
 *   amps: number[],
 *   playhead: number | null,
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

  const amps = layout.amps || [];
  const slot = width / Math.max(1, amps.length);
  const barW = Math.max(1, slot - 1);
  ctx.fillStyle = 'rgba(241, 250, 238, 0.82)';
  for (let i = 0; i < amps.length; i += 1) {
    const amp = amps[i];
    if (amp <= 0) continue;
    const barH = Math.max(1, amp * (waveH / 2 - 2));
    const x = i * slot;
    const mid = waveH / 2;
    ctx.fillRect(x, mid - barH, barW, barH * 2);
  }

  if (layout.playhead != null) {
    const x = layout.playhead * width;
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
