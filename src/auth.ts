import { pool } from './db.js';
import { findGuestCredentials } from './guests.js';
import { hashPassword, verifyPassword } from './password.js';

/** Who is signed in: the master, or a guest uploader. */
export type Identity = { role: 'master' } | { role: 'guest'; guestId: number; name: string };

export async function setMasterPassword(password: string): Promise<void> {
  const { salt, hash } = await hashPassword(password);
  await pool.query(
    `INSERT INTO credentials (role, salt, hash) VALUES ('master', $1, $2)
     ON CONFLICT (role) DO UPDATE SET salt = EXCLUDED.salt, hash = EXCLUDED.hash`,
    [salt, hash],
  );
}

async function checkMasterPassword(password: string): Promise<boolean> {
  const { rows } = await pool.query<{ salt: Buffer; hash: Buffer }>(
    "SELECT salt, hash FROM credentials WHERE role = 'master'",
  );
  if (!rows.length) return false;
  return verifyPassword(password, rows[0].salt, rows[0].hash);
}

/** Checks sign-in credentials. An empty guest name means the master password. */
export async function authenticate(guestName: string, password: string): Promise<Identity | null> {
  if (!guestName) return (await checkMasterPassword(password)) ? { role: 'master' } : null;
  const guest = await findGuestCredentials(guestName);
  if (!guest || !(await verifyPassword(password, guest.salt, guest.hash))) return null;
  return { role: 'guest', guestId: guest.id, name: guest.name };
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
