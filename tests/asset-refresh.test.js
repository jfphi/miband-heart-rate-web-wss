import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ASSET_RELOAD_KEY,
  ASSET_VERSION_KEY,
  resetAssetRefreshForTests,
  shouldForceReload,
  startAssetRefresh,
  stripAssetVersionParam,
} from '../public/js/asset-refresh.js';

describe('shouldForceReload', () => {
  it('does not reload when versions match or are missing', () => {
    expect(shouldForceReload('', 'abc')).toBe(false);
    expect(shouldForceReload('abc', '')).toBe(false);
    expect(shouldForceReload('abc', 'abc')).toBe(false);
  });

  it('reloads once when remote version changes', () => {
    expect(shouldForceReload('old', 'new')).toBe(true);
    expect(shouldForceReload('old', 'new', 'new')).toBe(false);
  });
});

describe('stripAssetVersionParam', () => {
  it('removes _av and keeps room query', () => {
    expect(stripAssetVersionParam('http://localhost/publish.html?room=ABCD&_av=x')).toBe(
      '/publish.html?room=ABCD',
    );
  });
});

describe('startAssetRefresh', () => {
  afterEach(() => {
    resetAssetRefreshForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('reloads when a later poll sees a new version', async () => {
    vi.useFakeTimers();
    const store = new Map();
    vi.stubGlobal('sessionStorage', {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    });
    let remote = 'v1';
    const reload = vi.fn(async (v) => {
      store.set(ASSET_RELOAD_KEY, v);
      store.set(ASSET_VERSION_KEY, v);
    });
    const stop = startAssetRefresh('v1', {
      intervalMs: 1000,
      fetchVersion: async () => remote,
      reload,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(reload).not.toHaveBeenCalled();
    remote = 'v2';
    await vi.advanceTimersByTimeAsync(1000);
    expect(reload).toHaveBeenCalledWith('v2');
    stop();
  });
});
