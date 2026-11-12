import crypto from 'crypto';
import { Identity } from './auth.js';
import { pool } from './db.js';

/** Salted hash of a download password. */
export interface PasswordHash {
  salt: Buffer;
  hash: Buffer;
}

export interface FileInfo {
  name: string;
  size: number;
  expiresAt: Date | null;
  password: PasswordHash | null; // null = anyone with the link may download
}

export interface NewFile {
  name: string;
  data: Buffer;
  password: PasswordHash | null; // null = no download password
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
  passwordless: boolean;
}

export interface DownloadRecord {
  downloadedAt: Date;
  ip: string | null;
}

export interface FileChanges {
  name?: string;
  password?: PasswordHash | null; // null removes the password
  expiresInMinutes?: number; // counted from now; 0 = never
}

export const isToken = (t: string): boolean => /^[A-Za-z0-9_-]{32}$/.test(t);

// Expired files are treated as gone even before the cleanup job removes them.
const LIVE = '(expires_at IS NULL OR expires_at > now())';

/** Number of a guest's files that have not expired. */
export async function countLiveFiles(guestId: number): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM files WHERE guest_id = $1 AND ${LIVE}`, [
    guestId,
  ]);
  return Number(rows[0].n);
}

/**
 * Stores a file. Returns null, storing nothing, if it would take the guest over `maxFiles`.
 * The guest's row is locked so simultaneous uploads cannot slip past the limit.
 */
export async function insertFile(
  file: NewFile,
  maxFiles: number | null,
): Promise<{ token: string; expiresAt: Date | null } | null> {
  const token = crypto.randomBytes(24).toString('base64url');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (file.guestId !== null && maxFiles !== null) {
      await client.query('SELECT 1 FROM guests WHERE id = $1 FOR UPDATE', [file.guestId]);
      const { rows: count } = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM files WHERE guest_id = $1 AND ${LIVE}`,
        [file.guestId],
      );
      if (Number(count[0].n) >= maxFiles) {
        await client.query('ROLLBACK');
        return null;
      }
    }
    const { rows } = await client.query<{ expires_at: Date | null }>(
      `INSERT INTO files (token, name, size, data, pw_salt, pw_hash, no_password, uploader, guest_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               CASE WHEN $10::int > 0 THEN now() + $10::int * interval '1 minute' END)
       RETURNING expires_at`,
      [
        token,
        file.name,
        file.data.length,
        file.data,
        file.password?.salt ?? null,
        file.password?.hash ?? null,
        file.password === null,
        file.uploader,
        file.guestId,
        file.expiresInMinutes,
      ],
    );
    await client.query('COMMIT');
    return { token, expiresAt: rows[0].expires_at };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Metadata and password hash, or null if the file is missing, expired or unavailable.
 * Files from before per-file passwords (no hash, not marked passwordless) are unavailable until the owner sets a password.
 */
export async function findFileInfo(token: string): Promise<FileInfo | null> {
  if (!isToken(token)) return null;
  const { rows } = await pool.query<{
    name: string;
    size: string;
    expires_at: Date | null;
    pw_salt: Buffer | null;
    pw_hash: Buffer | null;
  }>(
    `SELECT name, size, expires_at, pw_salt, pw_hash FROM files
     WHERE token = $1 AND (no_password OR pw_hash IS NOT NULL) AND ${LIVE}`,
    [token],
  );
  const r = rows[0];
  if (!r) return null;
  // A stored hash always wins, so a stray flag can never make a protected file public.
  const password = r.pw_salt && r.pw_hash ? { salt: r.pw_salt, hash: r.pw_hash } : null;
  return { name: r.name, size: Number(r.size), expiresAt: r.expires_at, password };
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
    no_password: boolean;
  }>(
    `SELECT f.token, f.name, f.size, f.uploader, f.created_at, f.expires_at, f.no_password,
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
    passwordless: r.no_password,
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
  if (changes.password === null) {
    sets.push('pw_salt = NULL', 'pw_hash = NULL', 'no_password = true');
  } else if (changes.password) {
    sets.push(`pw_salt = ${param(changes.password.salt)}`, `pw_hash = ${param(changes.password.hash)}`);
    sets.push('no_password = false');
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
