/** Local mic level meter — measures only; never records or plays audio. */

const MSG = {
  unsupported: '此瀏覽器不支援麥克風音量偵測',
  noDetect: '找不到可用的麥克風',
  requesting: '正在請求麥克風權限…',
  noCtx: '無法建立音訊內容',
  listening: '正在量測音量',
  denied: '已拒絕麥克風權限',
  failed: '無法開啟麥克風',
  idle: '麥克風未開啟',
};

export function isMicSupported() {
  const g = globalThis;
  return (
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof (g.AudioContext || g.webkitAudioContext) !== 'undefined'
  );
}

/** RMS → dBFS; silence clamped to -100. */
export function rmsToDbfs(rms) {
  if (!Number.isFinite(rms) || rms <= 1e-8) return -100;
  const db = 20 * Math.log10(rms);
  if (!Number.isFinite(db)) return -100;
  return Math.max(-100, Math.min(0, Math.round(db)));
}

export function createMicLevel(options) {
  let status = 'idle';
  let stream = null;
  let ctx = null;
  let analyser = null;
  let timeBuf = null;
  let raf = 0;
  let stopped = true;
  /** Monotonic; each start() captures a token so older async starts cannot steal state. */
  let startEpoch = 0;
  let startInFlight = false;

  const setStatus = (next, text) => {
    status = next;
    options.onStatus?.(next, text);
  };

  const teardown = () => {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    analyser?.disconnect();
    analyser = null;
    timeBuf = null;
    if (ctx) {
      void ctx.close().catch(() => undefined);
      ctx = null;
    }
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
  };

  const tick = () => {
    if (stopped || !analyser || !timeBuf) return;
    analyser.getFloatTimeDomainData(timeBuf);
    let sum = 0;
    for (let i = 0; i < timeBuf.length; i += 1) {
      const v = timeBuf[i];
      sum += v * v;
    }
    const rms = Math.sqrt(sum / timeBuf.length);
    if (stopped) return;
    options.onLevel(rmsToDbfs(rms));
    if (stopped) return;
    raf = requestAnimationFrame(tick);
  };

  return {
    get status() {
      return status;
    },
    async start() {
      if (!isMicSupported()) {
        setStatus('error', MSG.unsupported);
        options.onError?.(MSG.noDetect);
        return;
      }
      // Prevent overlapping getUserMedia — second call would leak the first track.
      if (startInFlight || status === 'listening' || status === 'requesting') return;
      startInFlight = true;
      const epoch = (startEpoch += 1);
      stopped = false;
      setStatus('requesting', MSG.requesting);
      try {
        // Measure-only: AnalyserNode, never MediaRecorder / destination / <audio>.
        const nextStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: false,
          },
          video: false,
        });
        if (stopped || epoch !== startEpoch) {
          for (const track of nextStream.getTracks()) track.stop();
          return;
        }
        teardown();
        stream = nextStream;
        const g = globalThis;
        const AudioCtx = g.AudioContext || g.webkitAudioContext;
        if (!AudioCtx) throw new Error(MSG.noCtx);
        ctx = new AudioCtx();
        if (ctx.state === 'suspended') await ctx.resume();
        if (stopped || epoch !== startEpoch) {
          teardown();
          return;
        }
        const source = ctx.createMediaStreamSource(stream);
        analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.8;
        timeBuf = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
        // Do NOT connect analyser to ctx.destination — no playback.
        source.connect(analyser);
        setStatus('listening', MSG.listening);
        tick();
      } catch (err) {
        teardown();
        if (epoch === startEpoch) {
          const msg =
            err instanceof DOMException && err.name === 'NotAllowedError'
              ? MSG.denied
              : err instanceof Error
                ? err.message
                : String(err);
          setStatus('error', MSG.failed);
          options.onError?.(msg);
        }
      } finally {
        if (epoch === startEpoch) startInFlight = false;
      }
    },
    stop() {
      startEpoch += 1;
      startInFlight = false;
      stopped = true;
      teardown();
      setStatus('idle', MSG.idle);
    },
  };
}
