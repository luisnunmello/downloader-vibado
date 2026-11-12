import { Identity } from './auth.js';
import { MAX_SIZE } from './config.js';
import { storageUsed } from './files.js';
import { getGuestLimits } from './guests.js';
import { getServerMaxMb } from './settings.js';

const MB = 1024 * 1024;

export interface Limits {
  /** Largest allowed upload in bytes. */
  maxSizeBytes: number;
  /** False for the master, whose only cap is the server maximum. */
  sizeLimited: boolean;
  /** Longest allowed lifetime in minutes. When set, files must expire (no "never"). null = no limit. */
  maxExpiryMinutes: number | null;
  /** Total storage the user may use across all their files, in bytes. null = no limit. */
  maxTotalBytes: number | null;
  /** Storage they use now (only filled in when there is a quota). */
  usedBytes: number | null;
}

export async function limitsFor(identity: Identity): Promise<Limits> {
  const serverMax = (await getServerMaxMb()) * MB;
  if (identity.role === 'master') {
    return { maxSizeBytes: serverMax, sizeLimited: false, maxExpiryMinutes: null, maxTotalBytes: null, usedBytes: null };
  }
  const limits = await getGuestLimits(identity.guestId);
  const maxTotalBytes = limits?.maxTotalMb != null ? limits.maxTotalMb * MB : null;
  return {
    maxSizeBytes: Math.min(limits?.maxSizeMb != null ? limits.maxSizeMb * MB : MAX_SIZE, serverMax),
    sizeLimited: true,
    maxExpiryMinutes: limits?.maxExpiryMinutes ?? null,
    maxTotalBytes,
    usedBytes: maxTotalBytes === null ? null : await storageUsed(identity.guestId),
  };
}
