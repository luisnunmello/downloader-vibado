import { Identity } from './auth.js';
import { HARD_MAX_SIZE, MAX_SIZE } from './config.js';
import { countLiveFiles } from './files.js';
import { getGuestLimits } from './guests.js';

const MB = 1024 * 1024;

export interface Limits {
  /** Largest allowed upload in bytes. */
  maxSizeBytes: number;
  /** False for the master, whose only cap is the server's hard maximum. */
  sizeLimited: boolean;
  /** Longest allowed lifetime in minutes. When set, files must expire (no "never"). null = no limit. */
  maxExpiryMinutes: number | null;
  /** Most files the user may have stored at once. null = no limit. */
  maxFiles: number | null;
  /** How many of those they have now (only filled in when there is a limit). */
  filesUsed: number | null;
}

export async function limitsFor(identity: Identity): Promise<Limits> {
  if (identity.role === 'master') {
    return { maxSizeBytes: HARD_MAX_SIZE, sizeLimited: false, maxExpiryMinutes: null, maxFiles: null, filesUsed: null };
  }
  const limits = await getGuestLimits(identity.guestId);
  const maxFiles = limits?.maxFiles ?? null;
  return {
    maxSizeBytes: limits?.maxSizeMb != null ? Math.min(limits.maxSizeMb * MB, HARD_MAX_SIZE) : MAX_SIZE,
    sizeLimited: true,
    maxExpiryMinutes: limits?.maxExpiryMinutes ?? null,
    maxFiles,
    filesUsed: maxFiles === null ? null : await countLiveFiles(identity.guestId),
  };
}
