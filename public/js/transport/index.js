import { loadConfig } from '../config.js';

export async function createTransport() {
  const cfg = await loadConfig();
  if (cfg.backend === 'firebase') {
    const { createFirebaseTransport } = await import('./firebase.js');
    return createFirebaseTransport(cfg);
  }
  const { createWssTransport } = await import('./wss.js');
  return createWssTransport(cfg);
}

export async function getConfiguredBackend() {
  const cfg = await loadConfig();
  return cfg.backend;
}
