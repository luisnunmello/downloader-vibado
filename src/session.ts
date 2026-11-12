import crypto from 'crypto';
import { Request, RequestHandler, Response } from 'express';
import { Identity } from './auth.js';
import { pool } from './db.js';

export const SESSION_COOKIE = 'session';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// Only a hash of the token is stored, so a database leak does not expose live sessions.
const hashToken = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');

export async function createSession(identity: Identity): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO sessions (token_hash, role, guest_id, expires_at)
     VALUES ($1, $2, $3, now() + $4 * interval '1 millisecond')`,
    [hashToken(token), identity.role, identity.role === 'guest' ? identity.guestId : null, SESSION_TTL_MS],
  );
  return token;
}

export async function deleteSession(token: string): Promise<void> {
  await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

export async function deleteExpiredSessions(): Promise<void> {
  await pool.query('DELETE FROM sessions WHERE expires_at <= now()');
}

async function findIdentity(token: string): Promise<Identity | null> {
  const { rows } = await pool.query<{ role: 'master' | 'guest'; guest_id: number | null; name: string | null }>(
    `SELECT s.role, s.guest_id, g.name FROM sessions s
     LEFT JOIN guests g ON g.id = s.guest_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  );
  const r = rows[0];
  if (!r) return null;
  if (r.role === 'master') return { role: 'master' };
  return r.guest_id !== null && r.name !== null ? { role: 'guest', guestId: r.guest_id, name: r.name } : null;
}

export function sessionToken(req: Request): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === SESSION_COOKIE && value.length) return value.join('=');
  }
  return null;
}

export async function identityFromRequest(req: Request): Promise<Identity | null> {
  const token = sessionToken(req);
  return token ? findIdentity(token) : null;
}

/** The identity attached by requireAuth. */
export const currentIdentity = (res: Response): Identity => res.locals.identity as Identity;

export const requireAuth: RequestHandler = async (req, res, next) => {
  try {
    const identity = await identityFromRequest(req);
    if (!identity) {
      res.status(401).json({ error: 'Not signed in' });
      return;
    }
    res.locals.identity = identity;
    next();
  } catch (e) {
    next(e);
  }
};

export const requireMaster: RequestHandler = (_req, res, next) => {
  if (currentIdentity(res).role !== 'master') {
    res.status(403).json({ error: 'Master only' });
    return;
  }
  next();
};
