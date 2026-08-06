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

/** Exponential backoff delay for WSS reconnect (ms), capped at 15s. */
export function reconnectDelayMs(attempt, { baseMs = 1000, maxMs = 15000 } = {}) {
  const n = Math.max(0, Number(attempt) || 0);
  return Math.min(baseMs * 2 ** n, maxMs);
}

/**
 * Throttle HR publishes:
 * - bpm 變化：最多約 1Hz（minIntervalMs）
 * - bpm 不變：定期 heartbeat（maxSilenceMs）
 * - 內建 timer keepalive，不依賴 BLE 通知頻率
 * - flush()：重連後強制重送最後一筆
 * - sendFn 失敗不推進 lastSentAt，可自動重試
 */
export function createHrThrottle(
  sendFn,
  { minIntervalMs = 1000, maxSilenceMs = 4000 } = {},
) {
  let latest = null;
  let lastSentBpm = null;
  /** @type {number | null} */
  let lastSentAt = null;
  let keepaliveTimer = null;
  let canSendFn = () => true;

  async function emit({ force = false, ts } = {}) {
    if (!latest) return false;
    if (!canSendFn()) return false;

    const now = ts ?? Date.now();
    if (!force) {
      const sameBpm = latest.bpm === lastSentBpm;
      if (sameBpm) {
        if (lastSentAt != null && now - lastSentAt < maxSilenceMs) return false;
      } else if (lastSentAt != null && now - lastSentAt < minIntervalMs) {
        return false;
      }
    }

    const payload = {
      bpm: latest.bpm,
      contact: latest.contact,
      ts: now,
    };
    try {
      await sendFn(payload);
    } catch (err) {
      // Swallow only transient transport gaps so BLE path does not flash errors.
      const msg = String(err?.message || err);
      if (
        msg.includes('尚未連線') ||
        msg.includes('尚未就緒') ||
        msg.includes('NETWORK_ERROR') ||
        msg.includes('network')
      ) {
        return false;
      }
      throw err;
    }
    lastSentBpm = latest.bpm;
    lastSentAt = now;
    return true;
  }

  async function publish({ bpm, contact, ts }) {
    latest = { bpm, contact: Boolean(contact) };
    return emit({ force: false, ts });
  }

  /**
   * @param {() => boolean} [canSend]
   * @param {(err: unknown) => void} [onError] called for non-transient emit failures
   */
  publish.startKeepalive = (canSend, onError) => {
    canSendFn = typeof canSend === 'function' ? canSend : () => true;
    if (keepaliveTimer != null) return;
    const interval = Math.max(500, Math.min(minIntervalMs, maxSilenceMs));
    keepaliveTimer = setInterval(() => {
      void emit({ force: false }).catch((err) => {
        // Transient failures return false from emit; only real errors land here.
        onError?.(err);
        publish.stopKeepalive();
      });
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
