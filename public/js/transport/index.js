import { normalizeBackend } from '../util.js';
import { appConfig } from '../config.js';

export async function createTransport(backend) {
  const resolved = normalizeBackend(backend, appConfig.defaultBackend || 'wss');
  if (resolved === 'firebase') {
    const { createFirebaseTransport } = await import('./firebase.js');
    return createFirebaseTransport();
  }
  const { createWssTransport } = await import('./wss.js');
  return createWssTransport();
}

export { normalizeBackend };
