import crypto from 'crypto';
import { Identity } from './auth.js';
import { pool } from './db.js';

export interface FileInfo {
  name: string;
  size: number;
  expiresAt: Date | null;
  salt: Buffer;
  hash: Buffer;
}

export interface NewFile {
  name: string;
  data: Buffer;
  salt: Buffer;
  hash: Buffer;
  expiresInMinutes: number; // 0 = never
  uploader: string; // display label
  guestId: number | null; // owner, when uploaded by a guest
}

export interface FileSummary {
  token: string;
  name: string;
  size: number;
  uploader: string;
  createdAt: Date;
  expiresAt: Date | null;
  downloads: number;
}

export interface DownloadRecord {
  downloadedAt: Date;
  ip: string | null;
}

export interface FileChanges {
  name?: string;
  password?: { salt: Buffer; hash: Buffer };
  expiresInMinutes?: number; // counted from now; 0 = never
}

export const isToken = (t: string): boolean => /^[A-Za-z0-9_-]{32}$/.test(t);

// Expired files are treated as gone even before the cleanup job removes them.
const LIVE = '(expires_at IS NULL OR expires_at > now())';

export async function insertFile(file: NewFile): Promise<{ token: string; expiresAt: Date | null }> {
  const token = crypto.randomBytes(24).toString('base64url');
  const { rows } = await pool.query<{ expires_at: Date | null }>(
    `INSERT INTO files (token, name, size, data, pw_salt, pw_hash, uploader, guest_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $8, $9, CASE WHEN $7::int > 0 THEN now() + $7::int * interval '1 minute' END)
     RETURNING expires_at`,
    [token, file.name, file.data.length, file.data, file.salt, file.hash, file.expiresInMinutes, file.uploader, file.guestId],
  );
  return { token, expiresAt: rows[0].expires_at };
}

/** Metadata and password hash. Files without a download password (legacy rows) are not served. */
export async function findFileInfo(token: string): Promise<FileInfo | null> {
  if (!isToken(token)) return null;
  const { rows } = await pool.query<{
    name: string;
    size: string;
    expires_at: Date | null;
    pw_salt: Buffer;
    pw_hash: Buffer;
  }>(
    `SELECT name, size, expires_at, pw_salt, pw_hash FROM files
     WHERE token = $1 AND pw_hash IS NOT NULL AND ${LIVE}`,
    [token],
  );
  const r = rows[0];
  return r ? { name: r.name, size: Number(r.size), expiresAt: r.expires_at, salt: r.pw_salt, hash: r.pw_hash } : null;
}

export async function getFileData(token: string): Promise<Buffer | null> {
  const { rows } = await pool.query<{ data: Buffer }>(`SELECT data FROM files WHERE token = $1 AND ${LIVE}`, [token]);
  return rows[0]?.data ?? null;
}

export async function deleteExpiredFiles(): Promise<number> {
  const { rowCount } = await pool.query('DELETE FROM files WHERE expires_at IS NOT NULL AND expires_at <= now()');
  return rowCount ?? 0;
}

export async function recordDownload(token: string, ip: string): Promise<void> {
  await pool.query('INSERT INTO downloads (token, ip) VALUES ($1, $2)', [token, ip]);
}

// ---------- Management (master sees everything, a guest only their own files) ----------

/** Whether the identity may view, edit or delete this file. */
export async function canManage(identity: Identity, token: string): Promise<boolean> {
  const { rowCount } =
    identity.role === 'master'
      ? await pool.query('SELECT 1 FROM files WHERE token = $1', [token])
      : await pool.query('SELECT 1 FROM files WHERE token = $1 AND guest_id = $2', [token, identity.guestId]);
  return !!rowCount;
}

/** Files newest first, including ones that have expired but not yet been cleaned up. */
export async function listFiles(identity: Identity): Promise<FileSummary[]> {
  const { rows } = await pool.query<{
    token: string;
    name: string;
    size: string;
    uploader: string;
    created_at: Date;
    expires_at: Date | null;
    downloads: string;
  }>(
    `SELECT f.token, f.name, f.size, f.uploader, f.created_at, f.expires_at,
            (SELECT count(*) FROM downloads d WHERE d.token = f.token) AS downloads
     FROM files f
     WHERE $1::int IS NULL OR f.guest_id = $1
     ORDER BY f.created_at DESC`,
    [identity.role === 'guest' ? identity.guestId : null],
  );
  return rows.map((r) => ({
    token: r.token,
    name: r.name,
    size: Number(r.size),
    uploader: r.uploader,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    downloads: Number(r.downloads),
  }));
}

export async function listDownloads(token: string): Promise<DownloadRecord[]> {
  const { rows } = await pool.query<{ downloaded_at: Date; ip: string | null }>(
    'SELECT downloaded_at, ip FROM downloads WHERE token = $1 ORDER BY downloaded_at DESC LIMIT 200',
    [token],
  );
  return rows.map((r) => ({ downloadedAt: r.downloaded_at, ip: r.ip }));
}

export async function updateFile(token: string, changes: FileChanges): Promise<boolean> {
  const params: unknown[] = [token];
  const sets: string[] = [];
  const param = (value: unknown): string => `$${params.push(value)}`;

  if (changes.name !== undefined) sets.push(`name = ${param(changes.name)}`);
  if (changes.password) {
    sets.push(`pw_salt = ${param(changes.password.salt)}`);
    sets.push(`pw_hash = ${param(changes.password.hash)}`);
  }
  if (changes.expiresInMinutes !== undefined) {
    const minutes = `${param(changes.expiresInMinutes)}::int`;
    sets.push(`expires_at = CASE WHEN ${minutes} > 0 THEN now() + ${minutes} * interval '1 minute' END`);
  }
  if (!sets.length) return true;

  const { rowCount } = await pool.query(`UPDATE files SET ${sets.join(', ')} WHERE token = $1`, params);
  return !!rowCount;
}

export async function deleteFile(token: string): Promise<boolean> {
  const { rowCount } = await pool.query('DELETE FROM files WHERE token = $1', [token]);
  return !!rowCount;
}
