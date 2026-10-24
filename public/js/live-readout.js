import { pushHrSample, sparklinePoints } from './hr-chart.js';
import {
  advancePeakHold,
  dbToWaveAmp,
  drawWaveform,
  meterZone,
  playheadRatio,
  pushLevelSample,
  WAVE_WINDOW_MS,
  waveTickLabels,
  waveformColumns,
} from './audio/waveform.js';

const CHART_W = 640;
const CHART_H = 64;
const WAVE_H = 96;

function contactText(contact) {
  if (contact === true) return '佩戴狀態：已佩戴';
  if (contact === false) return '佩戴狀態：未接觸';
  return '佩戴狀態：未知';
}

function restartPulse(node) {
  node.classList.remove('pulse');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      node.classList.add('pulse');
    });
  });
}

/**
 * The publish-page sensor block. Watch mounts the same block for one person.
 * @param {HTMLElement} root
 * @param {{ showSignal?: boolean }} [options]
 */
export function mountLiveReadout(root, options = {}) {
  const showSignal = Boolean(options.showSignal);
  root.innerHTML = `
    <div class="live-readout">
      <div class="row readout-status-row">
        <span class="status idle readout-name" hidden></span>
        <span class="status idle readout-signal" hidden></span>
      </div>
      <div class="bpm">--</div>
      <div class="meta readout-contact">佩戴狀態：—</div>
      <div class="hr-chart-wrap">
        <div class="hr-chart-label">近 60 秒 BPM</div>
        <svg class="hr-chart" viewBox="0 0 ${CHART_W} ${CHART_H}" preserveAspectRatio="none" role="img" aria-label="近 60 秒心率">
          <line class="hr-chart-baseline" x1="0" y1="${CHART_H / 2}" x2="${CHART_W}" y2="${CHART_H / 2}"></line>
          <polyline class="hr-chart-line" fill="none" points=""></polyline>
        </svg>
      </div>
      <div class="mic-panel">
        <div class="row">
          <span class="status idle readout-mic">麥克風未開啟</span>
        </div>
        <div class="mic-db">--</div>
        <div class="mic-meter" aria-hidden="true">
          <div class="mic-meter-fill"></div>
          <div class="mic-meter-peak"></div>
        </div>
        <canvas class="wave-canvas" width="640" height="${WAVE_H}" aria-label="近 12 秒音量"></canvas>
      </div>
    </div>
  `;

  const shell = root.querySelector('.live-readout');
  const nameEl = root.querySelector('.readout-name');
  const signalEl = root.querySelector('.readout-signal');
  const bpmEl = root.querySelector('.bpm');
  const contactEl = root.querySelector('.readout-contact');
  const lineEl = root.querySelector('.hr-chart-line');
  const micEl = root.querySelector('.readout-mic');
  const dbEl = root.querySelector('.mic-db');
  const fillEl = root.querySelector('.mic-meter-fill');
  const peakEl = root.querySelector('.mic-meter-peak');
  const canvas = root.querySelector('.wave-canvas');

  /** @type {{ t: number, bpm: number }[]} */
  let hrPoints = [];
  /** @type {{ t: number, db: number }[]} */
  let levelPoints = [];
  /** @type {number | null} */
  let lastBpm = null;
  /** @type {number | null} */
  let liveDb = null;
  /** @type {{ db: number, releaseAt: number } | null} */
  let peakState = null;
  let running = true;
  let frameId = 0;

  function paintChart(now) {
    const series = hrPoints.map((p) => ({ t: p.t, value: p.bpm }));
    const coords = sparklinePoints(series, {
      width: CHART_W,
      height: CHART_H,
      now,
      preferredMin: 40,
      preferredMax: 180,
    });
    lineEl.setAttribute('points', coords);
    lineEl.style.display = coords ? '' : 'none';
  }

  function paintWave(now) {
    const cssW = canvas.clientWidth || 320;
    const dpr = window.devicePixelRatio || 1;
    const pxW = Math.max(1, Math.floor(cssW * dpr));
    const pxH = Math.max(1, Math.floor(WAVE_H * dpr));
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW;
      canvas.height = pxH;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.max(1, Math.floor(cssW / 3));
    const labelEvery = 2;
    const ticks = waveTickLabels(now).map((tick, index) => ({
      ...tick,
      showLabel: index % labelEvery === 0,
    }));
    drawWaveform(ctx, {
      width: cssW,
      height: WAVE_H,
      waveH: WAVE_H - 16,
      amps: waveformColumns(levelPoints, now, count),
      playhead: playheadRatio(levelPoints, now),
      ticks,
      now,
      windowMs: WAVE_WINDOW_MS,
    });
  }

  function paintPeak(now) {
    if (liveDb == null) {
      peakEl.style.opacity = '0';
      return;
    }
    const next = advancePeakHold(peakState, liveDb, now);
    peakState = next.state;
    peakEl.style.opacity = '1';
    peakEl.style.left = `${dbToWaveAmp(next.shown) * 100}%`;
  }

  function frame() {
    if (!running) return;
    const now = Date.now();
    paintChart(now);
    paintWave(now);
    paintPeak(now);
    frameId = requestAnimationFrame(frame);
  }

  function applyDb(db) {
    if (db == null || !Number.isFinite(Number(db))) {
      liveDb = null;
      peakState = null;
      dbEl.textContent = '--';
      fillEl.style.width = '0%';
      fillEl.className = 'mic-meter-fill';
      return;
    }
    const value = Number(db);
    liveDb = value;
    dbEl.textContent = String(value);
    fillEl.style.width = `${Math.round(dbToWaveAmp(value) * 100)}%`;
    fillEl.className = `mic-meter-fill zone-${meterZone(value)}`;
  }

  frameId = requestAnimationFrame(frame);

  return {
    setName(name) {
      const text = String(name || '').trim();
      nameEl.hidden = !text;
      nameEl.textContent = text;
      nameEl.className = 'status connected readout-name';
    },

    setContact(contact) {
      if (contact === undefined) {
        contactEl.textContent = '佩戴狀態：—';
        return;
      }
      contactEl.textContent = contactText(contact);
    },

    setMicStatus(kind, text) {
      micEl.className = `status ${kind || 'idle'} readout-mic`;
      micEl.textContent = text;
    },

    setSignal(kind, text) {
      if (!showSignal) {
        signalEl.hidden = true;
        return;
      }
      signalEl.hidden = false;
      signalEl.className = `status ${kind || 'idle'} readout-signal`;
      signalEl.textContent = text;
    },

    setStale(on) {
      shell.classList.toggle('is-stale', Boolean(on));
    },

    pushHr(bpm, t = Date.now()) {
      if (bpm == null || !Number.isFinite(Number(bpm))) {
        this.clearHr();
        return;
      }
      const value = Number(bpm);
      hrPoints = pushHrSample(hrPoints, value, t);
      bpmEl.textContent = String(value);
      if (lastBpm !== value) {
        lastBpm = value;
        restartPulse(bpmEl);
      }
    },

    setHrSeries(points, bpm) {
      hrPoints = points || [];
      if (bpm == null || !Number.isFinite(Number(bpm))) {
        lastBpm = null;
        bpmEl.textContent = '--';
        bpmEl.classList.remove('pulse');
        return;
      }
      const value = Number(bpm);
      const changed = lastBpm !== value;
      lastBpm = value;
      bpmEl.textContent = String(value);
      if (changed) restartPulse(bpmEl);
    },

    pushLevel(db, t = Date.now()) {
      levelPoints = pushLevelSample(levelPoints, db, t);
      applyDb(db);
    },

    setLevelSeries(points, db) {
      levelPoints = points || [];
      applyDb(db);
    },

    clearHr() {
      hrPoints = [];
      lastBpm = null;
      bpmEl.textContent = '--';
      bpmEl.classList.remove('pulse');
      contactEl.textContent = '佩戴狀態：—';
    },

    clearLevel() {
      levelPoints = [];
      applyDb(null);
      this.setMicStatus('idle', '麥克風未開啟');
    },

    destroy() {
      running = false;
      cancelAnimationFrame(frameId);
    },
  };
}

/**
 * Keep the current person when they are still in the list.
 * Otherwise take the next remaining person, then the first.
 * @param {{ clientId: string }[]} publishers
 * @param {string | null} focusedId
 * @param {string[]} previousIds
 */
export function chooseFocus(publishers, focusedId, previousIds = []) {
  if (!publishers.length) return null;
  if (focusedId && publishers.some((p) => p.clientId === focusedId)) return focusedId;
  const oldIndex = previousIds.indexOf(focusedId);
  if (oldIndex >= 0) {
    const next = publishers.find((p) => previousIds.indexOf(p.clientId) > oldIndex);
    if (next) return next.clientId;
  }
  return publishers[0].clientId;
}
