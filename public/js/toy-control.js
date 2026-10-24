export const GRANT_MAX_SECONDS = 1800;

/**
 * Who this browser is allowed to be for the room's toy leases.
 * @param {{
 *   clientId?: string | null,
 *   leases?: { ownerId?: string, controllerId?: string | null, expiresAt?: number | null }[],
 *   now?: number,
 *   toyControl?: boolean,
 *   localOwner?: boolean,
 * }} input
 */
export function controlRole({
  clientId = null,
  leases = [],
  now = Date.now(),
  toyControl = false,
  localOwner = false,
} = {}) {
  if (toyControl == null) return { mode: 'pending', lease: null };
  if (!toyControl) return { mode: 'unavailable', lease: null };
  const list = Array.isArray(leases) ? leases : [];
  const active = (lease) =>
    Boolean(
      lease &&
        lease.controllerId &&
        lease.expiresAt &&
        lease.expiresAt > now &&
        lease.controllerId !== lease.ownerId,
    );
  const mine = list.find((lease) => lease && lease.ownerId === clientId) || null;
  if (localOwner && mine && active(mine)) return { mode: 'owner-locked', lease: mine };
  if (localOwner) return { mode: 'owner', lease: mine };
  if (mine && active(mine)) return { mode: 'owner-locked', lease: mine };
  if (mine) return { mode: 'owner', lease: mine };
  const granted = list.find((lease) => lease && lease.controllerId === clientId && lease.expiresAt > now);
  if (granted) return { mode: 'controller', lease: granted };
  const spectating = list.find((lease) => active(lease));
  if (spectating) return { mode: 'spectator', lease: spectating };
  return { mode: 'spectator', lease: null };
}

export function canSendToy(role) {
  return role?.mode === 'owner' || role?.mode === 'controller';
}

/** @returns {number | null} */
export function clampGrantSeconds(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1 || n > GRANT_MAX_SECONDS) return null;
  return n;
}

export function grantVisible(role, onlineCount) {
  if (!role) return false;
  if (role.mode === 'unavailable') return true;
  if (role.mode === 'owner') return onlineCount > 1;
  if (role.mode === 'owner-locked' || role.mode === 'controller') return true;
  return role.mode === 'spectator' && Boolean(role.lease?.controllerId);
}
