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

/**
 * Throttle HR publishes:
 * - bpm 變化：最多約 1Hz（minIntervalMs）
 * - bpm 不變：定期 heartbeat（maxSilenceMs）
 * - 內建 timer keepalive，不依賴 BLE 通知頻率
 * - flush()：重連後強制重送最後一筆
 */
export function createHrThrottle(
  sendFn,
  { minIntervalMs = 1000, maxSilenceMs = 4000 } = {},
) {
  let latest = null;
  let lastSentBpm = null;
  let lastSentAt = 0;
  let keepaliveTimer = null;
  let canSendFn = () => true;

  async function emit({ force = false, ts } = {}) {
    if (!latest) return false;
    if (!canSendFn()) return false;

    const now = ts ?? Date.now();
    if (!force) {
      const sameBpm = latest.bpm === lastSentBpm;
      if (sameBpm) {
        if (lastSentAt && now - lastSentAt < maxSilenceMs) return false;
      } else if (lastSentAt && now - lastSentAt < minIntervalMs) {
        return false;
      }
    }

    const payload = {
      bpm: latest.bpm,
      contact: latest.contact,
      ts: now,
    };
    await sendFn(payload);
    lastSentBpm = latest.bpm;
    lastSentAt = now;
    return true;
  }

  async function publish({ bpm, contact, ts }) {
    latest = { bpm, contact: Boolean(contact) };
    return emit({ force: false, ts });
  }

  publish.startKeepalive = (canSend) => {
    canSendFn = typeof canSend === 'function' ? canSend : () => true;
    if (keepaliveTimer != null) return;
    const interval = Math.max(500, Math.min(minIntervalMs, maxSilenceMs));
    keepaliveTimer = setInterval(() => {
      void emit({ force: false }).catch(() => {});
    }, interval);
  };

  publish.stopKeepalive = () => {
    if (keepaliveTimer != null) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  };

  publish.flush = () => emit({ force: true });

  return publish;
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
