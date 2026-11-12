import express, { Response, Router } from 'express';
import { authenticate, Identity } from '../auth.js';
import { isBlocked, recordFailure } from '../rateLimit.js';
import {
  createSession,
  deleteSession,
  identityFromRequest,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  sessionToken,
} from '../session.js';
import { render } from '../views.js';

const router = Router();

export const homeFor = (identity: Identity): string => (identity.role === 'master' ? '/admin' : '/guest');

router.get('/login', async (req, res) => {
  const identity = await identityFromRequest(req);
  if (identity) return res.redirect(homeFor(identity));
  res.send(render('login', 'Sign in'));
});

// Old bookmark: uploading now happens inside the admin and guest pages.
router.get('/upload', (_req, res) => res.redirect('/login'));

router.post('/api/login', express.json({ limit: '4kb' }), async (req, res) => {
  const ip = req.ip ?? 'unknown';
  if (isBlocked(ip)) return res.status(429).json({ error: 'Too many attempts. Try later.' });

  const { name, password } = req.body ?? {};
  const identity =
    typeof password === 'string' && (name === undefined || typeof name === 'string')
      ? await authenticate((name ?? '').trim(), password)
      : null;
  if (!identity) {
    recordFailure(ip);
    return res.status(401).json({ error: 'Wrong name or password' });
  }

  const token = await createSession(identity);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure,
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
  res.json({ redirect: homeFor(identity) });
});

router.post('/api/logout', async (req, res: Response) => {
  const token = sessionToken(req);
  if (token) await deleteSession(token);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

export default router;
