let cached = null;

function toFrontendConfig(payload) {
  const backend =
    payload.backend === 'firebase' || payload.backend === 'wss'
      ? payload.backend
      : payload.backend === 'fastapi_wss'
        ? 'wss'
        : 'wss';

  return {
    backend,
    wsUrl: payload.wsUrl || '',
    firebase: payload.firebase || {},
  };
}

/** 優先讀取伺服器 /api/config（來自 .env），否則讀 config.generated.js */
export async function loadConfig() {
  if (cached) return cached;

  try {
    const res = await fetch('/api/config', { cache: 'no-store' });
    if (res.ok) {
      cached = toFrontendConfig(await res.json());
      return cached;
    }
  } catch {
    /* fall through */
  }

  try {
    const mod = await import('./config.generated.js');
    cached = toFrontendConfig(mod.appConfig);
    return cached;
  } catch {
    cached = {
      backend: 'wss',
      wsUrl: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
      firebase: {},
    };
    return cached;
  }
}
