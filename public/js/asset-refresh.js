export const ASSET_VERSION_KEY = 'miband_asset_version';
export const ASSET_RELOAD_KEY = 'miband_asset_reload_for';

export function shouldForceReload(loadedVersion, remoteVersion, alreadyReloadingFor) {
  if (!loadedVersion || !remoteVersion) return false;
  if (loadedVersion === remoteVersion) return false;
  if (alreadyReloadingFor === remoteVersion) return false;
  return true;
}

export function stripAssetVersionParam(href) {
  const raw =
    href ?? (typeof location !== 'undefined' ? location.href : 'http://localhost/');
  const url =
    typeof location !== 'undefined' ? new URL(raw, location.href) : new URL(raw);
  if (!url.searchParams.has('_av')) return href ?? raw;
  url.searchParams.delete('_av');
  return url.pathname + url.search + url.hash;
}

export async function fetchRemoteAssetVersion() {
  try {
    const res = await fetch('/api/config', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (data?.assetVersion) return String(data.assetVersion);
    }
  } catch {
    /* fall through */
  }
  try {
    const url = new URL('./config.generated.js', import.meta.url);
    url.searchParams.set('_av', String(Date.now()));
    const mod = await import(url.href);
    const version = mod.appConfig?.assetVersion;
    return version ? String(version) : '';
  } catch {
    return '';
  }
}

export async function hardReload(version, { replace = location.replace.bind(location) } = {}) {
  try {
    sessionStorage.setItem(ASSET_RELOAD_KEY, version);
    sessionStorage.setItem(ASSET_VERSION_KEY, version);
  } catch {
    /* private mode */
  }
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
    await fetch(location.href, { cache: 'reload', credentials: 'same-origin' });
  } catch {
    /* ignore */
  }
  const url = new URL(location.href);
  url.searchParams.set('_av', version);
  replace(url.toString());
}

let refreshStarted = false;

export function resetAssetRefreshForTests() {
  refreshStarted = false;
}

export function startAssetRefresh(
  loadedVersion,
  { intervalMs = 15000, fetchVersion = fetchRemoteAssetVersion, reload = hardReload } = {},
) {
  if (refreshStarted || !loadedVersion) return () => {};
  refreshStarted = true;

  const check = async () => {
    const remote = await fetchVersion();
    let already = null;
    try {
      already = sessionStorage.getItem(ASSET_RELOAD_KEY);
    } catch {
      already = null;
    }
    if (shouldForceReload(loadedVersion, remote, already)) {
      await reload(remote);
    }
  };

  const timer = setInterval(() => {
    void check();
  }, intervalMs);
  const onVisible = () => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') {
      void check();
    }
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisible);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pageshow', onVisible);
  }
  void check();

  return () => {
    refreshStarted = false;
    clearInterval(timer);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisible);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('pageshow', onVisible);
    }
  };
}

export async function bootPage(entryUrl) {
  const version = await fetchRemoteAssetVersion();
  let prev = null;
  let already = null;
  try {
    prev = sessionStorage.getItem(ASSET_VERSION_KEY);
    already = sessionStorage.getItem(ASSET_RELOAD_KEY);
  } catch {
    /* ignore */
  }
  if (shouldForceReload(prev, version, already)) {
    await hardReload(version);
    return;
  }
  try {
    if (version) sessionStorage.setItem(ASSET_VERSION_KEY, version);
    sessionStorage.removeItem(ASSET_RELOAD_KEY);
  } catch {
    /* ignore */
  }
  const clean = stripAssetVersionParam();
  if (clean !== location.pathname + location.search + location.hash) {
    history.replaceState(null, '', clean);
  }
  const url = new URL(entryUrl, location.href);
  if (version) url.searchParams.set('v', version);
  await import(url.href);
  startAssetRefresh(version);
}
