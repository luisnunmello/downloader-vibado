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
  source: AsyncIterable<Buffer>; // the file contents, streamed
  maxBytes: number; // refuse (and store nothing) if the contents are larger
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

export type StoreResult =
  | { ok: true; token: string; expiresAt: Date | null }
  | { ok: false; reason: 'too-large' | 'quota' };

const CHUNK_SIZE = 1024 * 1024;

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
 * Stores a file, streaming it into chunk rows inside one transaction, so nothing is kept if it fails.
 * Stores nothing if it is over `maxBytes`, or would take the guest over `maxTotalBytes`.
 * The guest's row is locked just before commit so simultaneous uploads cannot slip past the quota.
 */
export async function insertFile(file: NewFile, maxTotalBytes: number | null): Promise<StoreResult> {
  const token = crypto.randomBytes(24).toString('base64url');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO files (token, name, size, pw_salt, pw_hash, no_password, uploader, guest_id)
       VALUES ($1, $2, 0, $3, $4, $5, $6, $7)`,
      [
        token,
        file.name,
        file.password?.salt ?? null,
        file.password?.hash ?? null,
        file.password === null,
        file.uploader,
        file.guestId,
      ],
    );

    let total = 0;
    let index = 0;
    let pending: Buffer[] = [];
    let pendingLength = 0;
    const flush = async () => {
      if (!pendingLength) return;
      const data = Buffer.concat(pending, pendingLength);
      pending = [];
      pendingLength = 0;
      await client.query('INSERT INTO file_chunks (token, idx, data) VALUES ($1, $2, $3)', [token, index++, data]);
    };
    for await (const chunk of file.source) {
      total += chunk.length;
      if (total > file.maxBytes) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'too-large' };
      }
      pending.push(chunk);
      pendingLength += chunk.length;
      if (pendingLength >= CHUNK_SIZE) await flush();
    }
    await flush();

    if (file.guestId !== null && maxTotalBytes !== null) {
      await client.query('SELECT 1 FROM guests WHERE id = $1 FOR UPDATE', [file.guestId]);
      const { rows: used } = await client.query<{ used: string }>(
        `SELECT coalesce(sum(size), 0) AS used FROM files WHERE guest_id = $1 AND ${LIVE}`,
        [file.guestId],
      );
      if (Number(used[0].used) + total > maxTotalBytes) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'quota' };
      }
    }
    // Expiry counts from the end of the upload (clock_timestamp, not the transaction's start time).
    const { rows } = await client.query<{ expires_at: Date | null }>(
      `UPDATE files SET size = $2,
         expires_at = CASE WHEN $3::int > 0 THEN clock_timestamp() + $3::int * interval '1 minute' END
       WHERE token = $1 RETURNING expires_at`,
      [token, total, file.expiresInMinutes],
    );
    await client.query('COMMIT');
    return { ok: true, token, expiresAt: rows[0].expires_at };
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

/** Streams a live file's contents, or null if it is missing or expired. */
export async function openFile(token: string): Promise<AsyncGenerator<Buffer> | null> {
  const { rows } = await pool.query<{ chunked: boolean }>(
    `SELECT data IS NULL AS chunked FROM files WHERE token = $1 AND ${LIVE}`,
    [token],
  );
  if (!rows[0]) return null;
  return rows[0].chunked ? readChunks(token) : readLegacy(token);
}

// Files stored before chunking keep their contents in one column.
async function* readLegacy(token: string): AsyncGenerator<Buffer> {
  const { rows } = await pool.query<{ data: Buffer }>('SELECT data FROM files WHERE token = $1', [token]);
  if (rows[0]?.data) yield rows[0].data;
}

async function* readChunks(token: string): AsyncGenerator<Buffer> {
  for (let index = 0; ; index++) {
    const { rows } = await pool.query<{ data: Buffer }>(
      'SELECT data FROM file_chunks WHERE token = $1 AND idx = $2',
      [token, index],
    );
    if (!rows[0]) return;
    yield rows[0].data;
  }
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
