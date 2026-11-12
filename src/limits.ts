import { Identity } from './auth.js';
import { HARD_MAX_SIZE, MAX_SIZE } from './config.js';
import { getGuestLimits } from './guests.js';

const MB = 1024 * 1024;

export interface Limits {
  /** Largest allowed upload in bytes. */
  maxSizeBytes: number;
  /** False for the master, whose only cap is the server's hard maximum. */
  sizeLimited: boolean;
  /** Longest allowed lifetime in minutes. When set, files must expire (no "never"). null = no limit. */
  maxExpiryMinutes: number | null;
}

export async function limitsFor(identity: Identity): Promise<Limits> {
  if (identity.role === 'master') {
    return { maxSizeBytes: HARD_MAX_SIZE, sizeLimited: false, maxExpiryMinutes: null };
  }
  const limits = await getGuestLimits(identity.guestId);
  return {
    maxSizeBytes: limits?.maxSizeMb != null ? Math.min(limits.maxSizeMb * MB, HARD_MAX_SIZE) : MAX_SIZE,
    sizeLimited: true,
    maxExpiryMinutes: limits?.maxExpiryMinutes ?? null,
  };
}
