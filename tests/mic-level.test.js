import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMicLevel, rmsToDbfs } from '../public/js/audio/micLevel.js';

function mockTrack() {
  return { stop: vi.fn() };
}

function installMediaMocks() {
  const track = mockTrack();
  const stream = { getTracks: () => [track] };
  const getUserMedia = vi.fn(async () => stream);
  const connect = vi.fn();
  const disconnect = vi.fn();
  const analyser = {
    fftSize: 2048,
    smoothingTimeConstant: 0,
    disconnect,
    getFloatTimeDomainData: (buf) => {
      buf.fill(0);
    },
  };
  const source = { connect };
  const close = vi.fn(async () => undefined);
  const resume = vi.fn(async () => undefined);
  const createMediaStreamSource = vi.fn(() => source);
  const createAnalyser = vi.fn(() => analyser);

  class MockAudioContext {
    state = 'running';
    resume = resume;
    close = close;
    createMediaStreamSource = createMediaStreamSource;
    createAnalyser = createAnalyser;
    destination = { kind: 'destination' };
  }

  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia },
  });
  vi.stubGlobal('AudioContext', MockAudioContext);
  vi.stubGlobal('requestAnimationFrame', (cb) => {
    return globalThis.setTimeout(() => cb(performance.now()), 0);
  });
  vi.stubGlobal('cancelAnimationFrame', (id) => {
    globalThis.clearTimeout(id);
  });

  return {
    track,
    stream,
    getUserMedia,
    connect,
    analyser,
    createAnalyser,
    close,
  };
}

describe('createMicLevel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not connect analyser to destination (no playback)', async () => {
    const { connect, createAnalyser } = installMediaMocks();
    const mic = createMicLevel({ onLevel: () => undefined });
    await mic.start();
    expect(mic.status).toBe('listening');
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls[0]?.[0]).toBe(createAnalyser.mock.results[0]?.value);
    expect(connect.mock.calls[0]?.[0]?.kind).not.toBe('destination');
    mic.stop();
    expect(mic.status).toBe('idle');
  });

  it('stop releases tracks and closes AudioContext', async () => {
    const { track, close } = installMediaMocks();
    const mic = createMicLevel({ onLevel: () => undefined });
    await mic.start();
    expect(mic.status).toBe('listening');
    mic.stop();
    expect(track.stop).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(mic.status).toBe('idle');
  });

  it('ignores overlapping start while requesting/listening', async () => {
    const { getUserMedia, stream } = installMediaMocks();
    let resolveMedia;
    getUserMedia.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMedia = resolve;
        }),
    );
    const mic = createMicLevel({ onLevel: () => undefined });
    const first = mic.start();
    expect(mic.status).toBe('requesting');
    await mic.start();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    resolveMedia(stream);
    await first;
    expect(mic.status).toBe('listening');
    mic.stop();
  });

  it('stop during getUserMedia does not keep the stream', async () => {
    const lateTrack = mockTrack();
    const { getUserMedia } = installMediaMocks();
    let resolveMedia;
    getUserMedia.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMedia = resolve;
        }),
    );
    const mic = createMicLevel({ onLevel: () => undefined });
    const pending = mic.start();
    mic.stop();
    resolveMedia({ getTracks: () => [lateTrack] });
    await pending;
    expect(lateTrack.stop).toHaveBeenCalled();
    expect(mic.status).toBe('idle');
  });
});

describe('rmsToDbfs', () => {
  it('clamps silence and full-scale', () => {
    expect(rmsToDbfs(0)).toBe(-100);
    expect(rmsToDbfs(1)).toBe(0);
  });
});
