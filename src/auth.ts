import { pool } from './db.js';
import { findGuestCredentials, MASTER_LABEL } from './guests.js';
import { hashPassword, verifyPassword } from './password.js';

export async function setMasterPassword(password: string): Promise<void> {
  const { salt, hash } = await hashPassword(password);
  await pool.query(
    `INSERT INTO credentials (role, salt, hash) VALUES ('master', $1, $2)
     ON CONFLICT (role) DO UPDATE SET salt = EXCLUDED.salt, hash = EXCLUDED.hash`,
    [salt, hash],
  );
}

export async function checkMasterPassword(password: unknown): Promise<boolean> {
  const { rows } = await pool.query<{ salt: Buffer; hash: Buffer }>(
    "SELECT salt, hash FROM credentials WHERE role = 'master'",
  );
  if (!rows.length) return false;
  return verifyPassword(password, rows[0].salt, rows[0].hash);
}

/**
 * Checks upload credentials. An empty guest name means the master password.
 * Returns the uploader label to store on the file, or null if the credentials are wrong.
 */
export async function authenticateUploader(guestName: string, password: string): Promise<string | null> {
  if (!guestName) return (await checkMasterPassword(password)) ? MASTER_LABEL : null;
  const guest = await findGuestCredentials(guestName);
  if (!guest) return null;
  return (await verifyPassword(password, guest.salt, guest.hash)) ? guest.name : null;
}

/** Seeds the master password from an env var, only if none is stored yet. */
export async function seedMasterPassword(envValue: string | undefined): Promise<void> {
  const { rowCount } = await pool.query("SELECT 1 FROM credentials WHERE role = 'master'");
  if (rowCount) return;
  if (!envValue) {
    console.warn('No master password set. Run: npm run set-password -- <password>');
    return;
  }
  await setMasterPassword(envValue);
  console.log('Seeded master password from environment.');
}
