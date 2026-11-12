import crypto from 'crypto';

// PBKDF2 needs no extra memory (unlike scrypt) and runs in the libuv thread pool.
// Changing these values invalidates every stored hash.
const ITERATIONS = 100_000;
const KEY_LENGTH = 32;

const derive = (password: string, salt: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    crypto.pbkdf2(password, salt, ITERATIONS, KEY_LENGTH, 'sha256', (err, key) => (err ? reject(err) : resolve(key))),
  );

export async function hashPassword(password: string): Promise<{ salt: Buffer; hash: Buffer }> {
  const salt = crypto.randomBytes(16);
  return { salt, hash: await derive(password, salt) };
}

export async function verifyPassword(password: unknown, salt: Buffer, hash: Buffer): Promise<boolean> {
  if (typeof password !== 'string') return false;
  const candidate = await derive(password, salt);
  // Hashes from other schemes (e.g. the old scrypt ones) have a different length and never match.
  return candidate.length === hash.length && crypto.timingSafeEqual(candidate, hash);
}
