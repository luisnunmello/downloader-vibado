import { pool } from './db.js';
import { commitFile, discardFile, fileSize, saveStream } from './storage.js';

// Older versions kept file contents in Postgres: in files.data, then in file_chunks. On startup, move any
// such files to disk and drop the database storage. Safe to re-run: files already on disk are skipped, and
// nothing is dropped unless every file was moved.

async function* single(data: Buffer): AsyncGenerator<Buffer> {
  yield data;
}

async function* chunksOf(token: string): AsyncGenerator<Buffer> {
  for (let index = 0; ; index++) {
    const { rows } = await pool.query<{ data: Buffer }>('SELECT data FROM file_chunks WHERE token = $1 AND idx = $2', [
      token,
      index,
    ]);
    if (!rows[0]) return;
    yield rows[0].data;
  }
}

export async function moveLegacyFilesToDisk(): Promise<void> {
  const { rowCount: hasData } = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'files' AND column_name = 'data'",
  );
  const { rows: chunkTable } = await pool.query("SELECT to_regclass('file_chunks') AS t");
  const hasChunks = chunkTable[0].t !== null;
  if (!hasData && !hasChunks) return;

  const { rows } = await pool.query<{ token: string; size: string; chunked: boolean }>(
    hasData
      ? 'SELECT token, size, data IS NULL AS chunked FROM files'
      : 'SELECT token, size, true AS chunked FROM files',
  );
  let moved = 0;
  let failed = 0;
  for (const row of rows) {
    if ((await fileSize(row.token)) !== null) continue;
    try {
      let source: AsyncIterable<Buffer>;
      if (row.chunked) {
        source = chunksOf(row.token);
      } else {
        const { rows: data } = await pool.query<{ data: Buffer }>('SELECT data FROM files WHERE token = $1', [row.token]);
        source = single(data[0].data);
      }
      const size = await saveStream(row.token, source, Infinity);
      if (size !== Number(row.size)) {
        await discardFile(row.token);
        throw new Error(`size mismatch (${size} of ${row.size} bytes)`);
      }
      await commitFile(row.token);
      moved++;
    } catch (e) {
      failed++;
      console.error(`Could not move file ${row.token} to disk:`, e);
    }
  }
  if (moved) console.log(`Moved ${moved} file(s) from the database to disk.`);

  if (failed) {
    console.error(`${failed} file(s) could not be moved; they stay in the database and are unavailable until then.`);
    return;
  }
  await pool.query('DROP TABLE IF EXISTS file_chunks');
  await pool.query('ALTER TABLE files DROP COLUMN IF EXISTS data');
}
