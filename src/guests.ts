import { pool } from './db.js';
import { hashPassword } from './password.js';

export interface Guest {
  id: number;
  name: string;
  createdAt: Date;
}

/** Uploader label used for files uploaded with the master password. Guests cannot take this name. */
export const MASTER_LABEL = 'master';

export async function listGuests(): Promise<Guest[]> {
  const { rows } = await pool.query<{ id: number; name: string; created_at: Date }>(
    'SELECT id, name, created_at FROM guests ORDER BY lower(name)',
  );
  return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at }));
}

/** Throws a Postgres unique violation (code 23505) if the name is taken. */
export async function createGuest(name: string, password: string): Promise<number> {
  const { salt, hash } = await hashPassword(password);
  const { rows } = await pool.query<{ id: number }>(
    'INSERT INTO guests (name, salt, hash) VALUES ($1, $2, $3) RETURNING id',
    [name, salt, hash],
  );
  return rows[0].id;
}

export async function setGuestPassword(id: number, password: string): Promise<boolean> {
  const { salt, hash } = await hashPassword(password);
  const { rowCount } = await pool.query('UPDATE guests SET salt = $2, hash = $3 WHERE id = $1', [id, salt, hash]);
  return !!rowCount;
}

export async function deleteGuest(id: number): Promise<boolean> {
  const { rowCount } = await pool.query('DELETE FROM guests WHERE id = $1', [id]);
  return !!rowCount;
}

export async function findGuestCredentials(name: string): Promise<{ name: string; salt: Buffer; hash: Buffer } | null> {
  const { rows } = await pool.query<{ name: string; salt: Buffer; hash: Buffer }>(
    'SELECT name, salt, hash FROM guests WHERE lower(name) = lower($1)',
    [name],
  );
  return rows[0] ?? null;
}
