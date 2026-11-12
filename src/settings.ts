import { DEFAULT_SERVER_MAX_MB, HARD_MAX_SIZE_MB } from './config.js';
import { pool } from './db.js';

/** The server-wide upload size cap in MB. It applies to everyone, the master included. */
export async function getServerMaxMb(): Promise<number> {
  const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'max_size_mb'");
  const stored = rows[0] ? Number(rows[0].value) : DEFAULT_SERVER_MAX_MB;
  return Math.min(stored, HARD_MAX_SIZE_MB);
}

export async function setServerMaxMb(mb: number): Promise<void> {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('max_size_mb', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [String(mb)],
  );
}
