import { pool } from './db.js';
import { hashPassword } from './password.js';

export interface GuestLimits {
  maxSizeMb: number | null; // null = server default
  maxExpiryMinutes: number | null; // null = no limit
  maxTotalMb: number | null; // total storage across all their files; null = no limit
}

export interface Guest extends GuestLimits {
  id: number;
  name: string;
  createdAt: Date;
  usedBytes: number; // storage used by files that have not expired
}

/** `undefined` = leave unchanged, `null` = clear the limit. */
export interface GuestChanges {
  password?: string;
  maxSizeMb?: number | null;
  maxExpiryMinutes?: number | null;
  maxTotalMb?: number | null;
}

/** Uploader label used for files uploaded with the master password. Guests cannot take this name. */
export const MASTER_LABEL = 'master';

export async function listGuests(): Promise<Guest[]> {
  const { rows } = await pool.query<{
    id: number;
    name: string;
    created_at: Date;
    max_size_mb: number | null;
    max_expiry_minutes: number | null;
    max_total_mb: number | null;
    used_bytes: string;
  }>(
    `SELECT g.id, g.name, g.created_at, g.max_size_mb, g.max_expiry_minutes, g.max_total_mb,
            (SELECT coalesce(sum(f.size), 0) FROM files f
             WHERE f.guest_id = g.id AND (f.expires_at IS NULL OR f.expires_at > now())) AS used_bytes
     FROM guests g ORDER BY lower(g.name)`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    maxSizeMb: r.max_size_mb,
    maxExpiryMinutes: r.max_expiry_minutes,
    maxTotalMb: r.max_total_mb,
    usedBytes: Number(r.used_bytes),
  }));
}

export async function getGuestLimits(id: number): Promise<GuestLimits | null> {
  const { rows } = await pool.query<{
    max_size_mb: number | null;
    max_expiry_minutes: number | null;
    max_total_mb: number | null;
  }>('SELECT max_size_mb, max_expiry_minutes, max_total_mb FROM guests WHERE id = $1', [id]);
  const r = rows[0];
  return r ? { maxSizeMb: r.max_size_mb, maxExpiryMinutes: r.max_expiry_minutes, maxTotalMb: r.max_total_mb } : null;
}

/** Throws a Postgres unique violation (code 23505) if the name is taken. */
export async function createGuest(name: string, password: string, limits: GuestLimits): Promise<number> {
  const { salt, hash } = await hashPassword(password);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO guests (name, salt, hash, max_size_mb, max_expiry_minutes, max_total_mb)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [name, salt, hash, limits.maxSizeMb, limits.maxExpiryMinutes, limits.maxTotalMb],
  );
  return rows[0].id;
}

export async function updateGuest(id: number, changes: GuestChanges): Promise<boolean> {
  const params: unknown[] = [id];
  const sets: string[] = [];
  const param = (value: unknown): string => `$${params.push(value)}`;

  if (changes.password !== undefined) {
    const { salt, hash } = await hashPassword(changes.password);
    sets.push(`salt = ${param(salt)}`, `hash = ${param(hash)}`);
  }
  if (changes.maxSizeMb !== undefined) sets.push(`max_size_mb = ${param(changes.maxSizeMb)}`);
  if (changes.maxExpiryMinutes !== undefined) sets.push(`max_expiry_minutes = ${param(changes.maxExpiryMinutes)}`);
  if (changes.maxTotalMb !== undefined) sets.push(`max_total_mb = ${param(changes.maxTotalMb)}`);
  if (!sets.length) return true;

  const { rowCount } = await pool.query(`UPDATE guests SET ${sets.join(', ')} WHERE id = $1`, params);
  return !!rowCount;
}

export async function deleteGuest(id: number): Promise<boolean> {
  const { rowCount } = await pool.query('DELETE FROM guests WHERE id = $1', [id]);
  return !!rowCount;
}

export async function findGuestCredentials(
  name: string,
): Promise<{ id: number; name: string; salt: Buffer; hash: Buffer } | null> {
  const { rows } = await pool.query<{ id: number; name: string; salt: Buffer; hash: Buffer }>(
    'SELECT id, name, salt, hash FROM guests WHERE lower(name) = lower($1)',
    [name],
  );
  return rows[0] ?? null;
}
