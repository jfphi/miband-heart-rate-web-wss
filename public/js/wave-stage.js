import { drawWaveform, WAVE_WINDOW_MS, waveformLayout } from './audio/waveform.js';
import { domainY } from './hr-chart.js';
import { drawRemoteWave } from './lovense-wave.js';

const LANE_H = 64;
const HEART_PAD = 6;
/** Shrink time constant. Expand is immediate. */
export const HEART_DOMAIN_TAU_MS = 280;
/** A longer gap (hidden tab) snaps the scale instead of easing across it. */
export const HEART_DOMAIN_GAP_MS = 1000;

/** Shared time axis: the same timestamp lands on the same x in every lane. */
export function seriesX(t, now, width, windowMs = WAVE_WINDOW_MS) {
  const w = Math.max(1, Number(width) || 1);
  const span = Math.max(1, Number(windowMs) || 1);
  return ((Number(t) - (Number(now) - span)) / span) * w;
}

/**
 * Samples drawn in the window: in-range points, the sample just before the
 * left edge (so the line enters from the side), and a hold of the last bpm to now.
 * @param {{ t: number, bpm: number }[]} samples
 * @returns {{ t: number, bpm: number }[]}
 */
export function heartSeries(samples, now, windowMs = WAVE_WINDOW_MS) {
  const t0 = now - windowMs;
  const sorted = (samples || [])
    .filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.bpm) && p.t <= now)
    .slice()
    .sort((a, b) => a.t - b.t);
  if (!sorted.length || sorted[sorted.length - 1].t < t0) return [];
  const series = sorted.filter((p) => p.t >= t0);
  const before = sorted.filter((p) => p.t < t0).pop();
  if (before) series.unshift({ t: t0, bpm: before.bpm });
  const last = series[series.length - 1];
  if (last && last.t < now) series.push({ t: now, bpm: last.bpm });
  return series;
}

/**
 * Fit Y domain for the visible heart samples. Empty data keeps 40–180.
 * @param {{ bpm: number }[]} series
 * @returns {[number, number]}
 */
export function heartDomain(series) {
  return domainY((series || []).map((p) => p.bpm), 40, 180, 'fit');
}

/**
 * Expand a held domain immediately. Shrink toward the target with a time constant.
 * No held domain, or a gap of HEART_DOMAIN_GAP_MS, snaps to the target.
 * @param {[number, number] | null} current
 * @param {[number, number] | null} target
 * @param {number} dtMs
 * @returns {[number, number] | null}
 */
export function stepHeartDomain(current, target, dtMs, tauMs = HEART_DOMAIN_TAU_MS) {
  if (!target) return null;
  if (!current) return [target[0], target[1]];
  const dt = Number(dtMs);
  if (!Number.isFinite(dt) || dt <= 0) return [current[0], current[1]];
  if (dt >= HEART_DOMAIN_GAP_MS) return [target[0], target[1]];
  const shrink = 1 - Math.exp(-dt / tauMs);
  return [0, 1].map((i) => {
    const from = current[i];
    const to = target[i];
    const expanding = i === 0 ? to < from : to > from;
    if (expanding) return to;
    return from + (to - from) * shrink;
  });
}

/**
 * Domain for this frame. No visible samples clears it. Otherwise ease.
 * @param {[number, number] | null} current
 * @param {{ bpm: number }[]} series
 * @param {number} dtMs
 * @returns {[number, number] | null}
 */
export function advanceHeartDomain(current, series, dtMs) {
  if (!series || !series.length) return null;
  return stepHeartDomain(current, heartDomain(series), dtMs);
}

/**
 * True when `next` still contains the last sample of `prev` (same history, new points).
 * A different person, a cleared lane, or the first sample does not continue.
 * @param {{ t: number, bpm: number }[]} prev
 * @param {{ t: number, bpm: number }[]} next
 */
export function continuesHeartSeries(prev, next) {
  if (!prev?.length || !next?.length) return false;
  const last = prev[prev.length - 1];
  return next.some((p) => p && p.t === last.t && p.bpm === last.bpm);
}

/**
 * Heart polyline inside the 12 second window. The last sample is held to now.
 * Y uses `domain` when given, otherwise the fit domain of this window.
 * @param {{ t: number, bpm: number }[]} samples
 * @param {number} [windowMs]
 * @param {[number, number] | null} [domain]
 */
export function heartPoints(samples, now, width, height, windowMs = WAVE_WINDOW_MS, domain) {
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  const series = heartSeries(samples, now, windowMs);
  if (!series.length) return [];
  const [min, max] = domain || heartDomain(series);
  const span = max - min || 1;
  const inner = Math.max(1, h - HEART_PAD * 2);
  return series.map((p) => {
    const y = HEART_PAD + (1 - (p.bpm - min) / span) * inner;
    return {
      x: seriesX(p.t, now, w, windowMs),
      y: Math.min(h - HEART_PAD, Math.max(HEART_PAD, y)),
    };
  });
}

function drawHeart(ctx, samples, now, width, height, domain) {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#12151c';
  ctx.fillRect(0, 0, width, height);
  const pts = heartPoints(samples, now, width, height, WAVE_WINDOW_MS, domain);
  if (pts.length < 2) return;
  ctx.strokeStyle = '#e63946';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
  ctx.strokeStyle = '#48cae4';
  ctx.beginPath();
  ctx.moveTo(width - 1, 0);
  ctx.lineTo(width - 1, height);
  ctx.stroke();
}

function drawPlayhead(ctx, width, height) {
  ctx.strokeStyle = '#48cae4';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(width - 1, 0);
  ctx.lineTo(width - 1, height);
  ctx.stroke();
}

/**
 * @param {HTMLElement | null} root
 */
export function mountWaveStage(root) {
  if (!root) {
    return {
      setHeart() {},
      setSound() {},
      setToys() {},
      destroy() {},
    };
  }
  root.innerHTML = `
    <div class="wave-stage" aria-label="近 12 秒波形">
      <div class="wave-lane">
        <span class="wave-lane-label">心跳</span>
        <canvas class="wave-lane-canvas" data-lane="hr" width="640" height="${LANE_H}"></canvas>
      </div>
      <div class="wave-lane">
        <span class="wave-lane-label">聲音</span>
        <canvas class="wave-lane-canvas" data-lane="sound" width="640" height="${LANE_H}"></canvas>
      </div>
      <div class="wave-lane">
        <span class="wave-lane-label">震動</span>
        <canvas class="wave-lane-canvas" data-lane="toy" width="640" height="${LANE_H}"></canvas>
      </div>
    </div>
  `;
  const heartCanvas = root.querySelector('[data-lane="hr"]');
  const soundCanvas = root.querySelector('[data-lane="sound"]');
  const toyCanvas = root.querySelector('[data-lane="toy"]');
  let heart = [];
  /** @type {[number, number] | null} */
  let heldDomain = null;
  let lastHeartPaint = 0;
  let sound = [];
  /** @type {{ color?: string, samples?: { t: number, level: number }[] }[]} */
  let toys = [];
  let running = true;
  let frame = 0;

  function size(canvas) {
    const cssW = canvas.clientWidth || 320;
    const dpr = window.devicePixelRatio || 1;
    const pxW = Math.max(1, Math.floor(cssW * dpr));
    const pxH = Math.max(1, Math.floor(LANE_H * dpr));
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW;
      canvas.height = pxH;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, cssW };
  }

  function paint(now) {
    const heartBox = size(heartCanvas);
    if (heartBox) {
      const dt = lastHeartPaint ? now - lastHeartPaint : 0;
      const series = heartSeries(heart, now);
      heldDomain = advanceHeartDomain(heldDomain, series, dt);
      lastHeartPaint = now;
      drawHeart(heartBox.ctx, heart, now, heartBox.cssW, LANE_H, heldDomain);
    }

    const soundBox = size(soundCanvas);
    if (soundBox) {
      const count = Math.max(1, Math.floor(soundBox.cssW / 3));
      const wave = waveformLayout(sound, now, soundBox.cssW, count, WAVE_WINDOW_MS);
      drawWaveform(soundBox.ctx, {
        width: soundBox.cssW,
        height: LANE_H,
        waveH: LANE_H,
        bars: wave.bars,
        slot: wave.slot,
        playheadX: wave.playheadX == null ? null : soundBox.cssW,
        ticks: [],
        now,
        windowMs: WAVE_WINDOW_MS,
      });
    }

    const toyBox = size(toyCanvas);
    if (toyBox) {
      drawRemoteWave(toyBox.ctx, {
        series: toys,
        now,
        width: toyBox.cssW,
        height: LANE_H,
        windowMs: WAVE_WINDOW_MS,
      });
      if (toys.some((line) => (line.samples || []).length)) {
        drawPlayhead(toyBox.ctx, toyBox.cssW, LANE_H);
      }
    }
  }

  function loop() {
    if (!running) return;
    paint(Date.now());
    frame = requestAnimationFrame(loop);
  }
  frame = requestAnimationFrame(loop);

  return {
    setHeart(points) {
      const next = points || [];
      if (!continuesHeartSeries(heart, next)) heldDomain = null;
      heart = next;
    },
    setSound(points) {
      sound = points || [];
    },
    setToys(series) {
      toys = series || [];
    },
    destroy() {
      running = false;
      cancelAnimationFrame(frame);
    },
  };
}
