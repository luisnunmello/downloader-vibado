import crypto from 'crypto';
import { Identity } from './auth.js';
import { pool } from './db.js';
import { adoptFile, commitFile, discardFile, removeFiles, removeThumbnail, saveStream } from './storage.js';

/** Salted hash of a download password. */
export interface PasswordHash {
  salt: Buffer;
  hash: Buffer;
}

export interface FileInfo {
  name: string; // the file's name, with its extension
  title: string; // what is shown: the title if there is one, else the name
  size: number;
  expiresAt: Date | null;
  password: PasswordHash | null; // null = anyone with the link may download
}

export interface NewFile {
  name: string;
  title: string | null; // optional display title
  // The contents: either streamed in, or a finished file on disk that is moved into place.
  source?: AsyncIterable<Buffer>;
  fromPath?: { path: string; size: number };
  maxBytes: number; // refuse (and store nothing) if streamed contents are larger
  password: PasswordHash | null; // null = no download password
  expiresInMinutes: number; // 0 = never
  uploader: string; // display label
  guestId: number | null; // owner, when uploaded by a guest
}

export interface FileSummary {
  token: string;
  name: string;
  title: string;
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
  title?: string | null; // null = back to showing the file name
  password?: PasswordHash | null; // null removes the password
  expiresInMinutes?: number; // counted from now; 0 = never
}

export type StoreResult =
  | { ok: true; token: string; expiresAt: Date | null }
  | { ok: false; reason: 'too-large' | 'quota' };

export const isToken = (t: string): boolean => /^[A-Za-z0-9_-]{32}$/.test(t);

// Expired files are treated as gone even before the cleanup job removes them.
const LIVE = '(expires_at IS NULL OR expires_at > now())';

/** Bytes used by a guest's files that have not expired. */
export async function storageUsed(guestId: number): Promise<number> {
  const { rows } = await pool.query<{ used: string }>(
    `SELECT coalesce(sum(size), 0) AS used FROM files WHERE guest_id = $1 AND ${LIVE}`,
    [guestId],
  );
  return Number(rows[0].used);
}

/**
 * Stores a file: the contents go to disk, the details to the database. Stores nothing if it is over
 * `maxBytes`, or would take the guest over `maxTotalBytes`.
 * The guest's row is locked briefly so simultaneous uploads cannot slip past the quota.
 */
export async function insertFile(file: NewFile, maxTotalBytes: number | null, reservedBytes = 0): Promise<StoreResult> {
  const token = crypto.randomBytes(24).toString('base64url');
  let size: number;
  if (file.fromPath) {
    size = file.fromPath.size;
  } else {
    const saved = await saveStream(token, file.source!, file.maxBytes);
    if (saved === null) return { ok: false, reason: 'too-large' };
    size = saved;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (file.guestId !== null && maxTotalBytes !== null) {
      await client.query('SELECT 1 FROM guests WHERE id = $1 FOR UPDATE', [file.guestId]);
      const { rows: used } = await client.query<{ used: string }>(
        `SELECT coalesce(sum(size), 0) AS used FROM files WHERE guest_id = $1 AND ${LIVE}`,
        [file.guestId],
      );
      // reservedBytes: the user's temporary video, which also takes up their space
      if (Number(used[0].used) + reservedBytes + size > maxTotalBytes) {
        await client.query('ROLLBACK');
        await discardFile(token);
        return { ok: false, reason: 'quota' };
      }
    }
    const { rows } = await client.query<{ expires_at: Date | null }>(
      `INSERT INTO files (token, name, title, size, pw_salt, pw_hash, no_password, uploader, guest_id, expires_at)
       VALUES ($1, $2, $10, $3, $4, $5, $6, $7, $8,
               CASE WHEN $9::int > 0 THEN now() + $9::int * interval '1 minute' END)
       RETURNING expires_at`,
      [
        token,
        file.name,
        size,
        file.password?.salt ?? null,
        file.password?.hash ?? null,
        file.password === null,
        file.uploader,
        file.guestId,
        file.expiresInMinutes,
        file.title,
      ],
    );
    if (file.fromPath) await adoptFile(token, file.fromPath.path);
    else await commitFile(token);
    await client.query('COMMIT');
    return { ok: true, token, expiresAt: rows[0].expires_at };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    await discardFile(token);
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
    title: string | null;
    size: string;
    expires_at: Date | null;
    pw_salt: Buffer | null;
    pw_hash: Buffer | null;
  }>(
    `SELECT name, title, size, expires_at, pw_salt, pw_hash FROM files
     WHERE token = $1 AND (no_password OR pw_hash IS NOT NULL) AND ${LIVE}`,
    [token],
  );
  const r = rows[0];
  if (!r) return null;
  // A stored hash always wins, so a stray flag can never make a protected file public.
  const password = r.pw_salt && r.pw_hash ? { salt: r.pw_salt, hash: r.pw_hash } : null;
  return { name: r.name, title: r.title || r.name, size: Number(r.size), expiresAt: r.expires_at, password };
}

export async function fileName(token: string): Promise<string | null> {
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM files WHERE token = $1', [token]);
  return rows[0]?.name ?? null;
}

/** After a video was edited: the new size, and the new name (a compressed video is always an mp4). */
export async function setEditedVideo(token: string, size: number, name: string): Promise<void> {
  await pool.query('UPDATE files SET size = $2, name = $3 WHERE token = $1', [token, size, name]);
  await removeThumbnail(token); // it showed the old video
}

export async function deleteExpiredFiles(): Promise<number> {
  const { rows } = await pool.query<{ token: string }>(
    'DELETE FROM files WHERE expires_at IS NOT NULL AND expires_at <= now() RETURNING token',
  );
  await removeFiles(rows.map((r) => r.token));
  return rows.length;
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
    title: string | null;
    size: string;
    uploader: string;
    created_at: Date;
    expires_at: Date | null;
    downloads: string;
    no_password: boolean;
  }>(
    `SELECT f.token, f.name, f.title, f.size, f.uploader, f.created_at, f.expires_at, f.no_password,
            (SELECT count(*) FROM downloads d WHERE d.token = f.token) AS downloads
     FROM files f
     WHERE $1::int IS NULL OR f.guest_id = $1
     ORDER BY f.created_at DESC`,
    [identity.role === 'guest' ? identity.guestId : null],
  );
  return rows.map((r) => ({
    token: r.token,
    name: r.name,
    title: r.title || r.name,
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

  if (changes.title !== undefined) sets.push(`title = ${param(changes.title)}`);
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
  if (!rowCount) return false;
  await removeFiles([token]);
  return true;
}
