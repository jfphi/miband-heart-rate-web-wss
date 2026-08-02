const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRoomCode(length = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += ROOM_ALPHABET[bytes[i] % ROOM_ALPHABET.length];
  }
  return code;
}

export function getOrCreateClientId() {
  const key = 'miband_hr_client_id';
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
  }
  return id;
}

export function parseQuery() {
  return new URLSearchParams(window.location.search);
}

export function buildPageUrl(page, params) {
  const url = new URL(page, window.location.href);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, value);
    }
  });
  return url.pathname.split('/').pop() + url.search;
}

export function createHrThrottle(sendFn, { minIntervalMs = 1000 } = {}) {
  let lastBpm = null;
  let lastSentAt = 0;

  return async ({ bpm, contact, ts }) => {
    const now = ts ?? Date.now();
    if (bpm === lastBpm) return false;
    if (now - lastSentAt < minIntervalMs) return false;
    lastBpm = bpm;
    lastSentAt = now;
    await sendFn({ bpm, contact: Boolean(contact), ts: now });
    return true;
  };
}

export function formatAge(updatedAt) {
  if (!updatedAt) return '—';
  const seconds = Math.max(0, Math.floor((Date.now() - updatedAt) / 1000));
  if (seconds < 5) return '剛剛';
  if (seconds < 60) return `${seconds}s 前`;
  return `${Math.floor(seconds / 60)}m 前`;
}

export function isStale(updatedAt, staleMs = 8000) {
  if (!updatedAt) return true;
  return Date.now() - updatedAt > staleMs;
}
