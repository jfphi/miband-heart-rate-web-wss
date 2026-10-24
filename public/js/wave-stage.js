import { drawWaveform, WAVE_WINDOW_MS, waveformLayout } from './audio/waveform.js';
import { drawRemoteWave } from './lovense-wave.js';

const LANE_H = 64;

/** Shared time axis: the same timestamp lands on the same x in every lane. */
export function seriesX(t, now, width, windowMs = WAVE_WINDOW_MS) {
  const w = Math.max(1, Number(width) || 1);
  const span = Math.max(1, Number(windowMs) || 1);
  return ((Number(t) - (Number(now) - span)) / span) * w;
}

/**
 * Heart polyline inside the 12 second window. The last sample is held to now.
 * @param {{ t: number, bpm: number }[]} samples
 */
export function heartPoints(samples, now, width, height, windowMs = WAVE_WINDOW_MS) {
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
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
  const pad = 6;
  const inner = Math.max(1, h - pad * 2);
  return series.map((p) => {
    const bpm = Math.min(180, Math.max(40, p.bpm));
    return {
      x: seriesX(p.t, now, w, windowMs),
      y: pad + (1 - (bpm - 40) / 140) * inner,
    };
  });
}

function drawHeart(ctx, samples, now, width, height) {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#12151c';
  ctx.fillRect(0, 0, width, height);
  const pts = heartPoints(samples, now, width, height);
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
    if (heartBox) drawHeart(heartBox.ctx, heart, now, heartBox.cssW, LANE_H);

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
      heart = points || [];
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
