import express, { RequestHandler, Router } from 'express';
import { checkMasterPassword } from '../auth.js';
import { MAX_EXPIRY_MINUTES } from '../config.js';
import {
  deleteFile,
  FileChanges,
  isToken,
  listDownloads,
  listFiles,
  updateFile,
} from '../files.js';
import { createGuest, deleteGuest, listGuests, MASTER_LABEL, setGuestPassword } from '../guests.js';
import { cleanFilename, headerValue } from '../http.js';
import { hashPassword } from '../password.js';
import { isBlocked, recordFailure } from '../rateLimit.js';
import { render } from '../views.js';

const MIN_PASSWORD = 4;
const MAX_GUEST_NAME = 50;

const router = Router();

router.get('/admin', (_req, res) => {
  res.send(render('admin', 'Admin', {}, 'wide'));
});

// Every API call carries the master password in the x-password header; there are no sessions.
const requireMaster: RequestHandler = async (req, res, next) => {
  const ip = req.ip ?? 'unknown';
  try {
    if (isBlocked(ip)) {
      res.status(429).json({ error: 'Too many attempts. Try later.' });
      return;
    }
    if (!(await checkMasterPassword(headerValue(req, 'x-password')))) {
      recordFailure(ip);
      res.status(401).json({ error: 'Wrong master password' });
      return;
    }
    next();
  } catch (e) {
    next(e);
  }
};

const api = Router();
api.use(requireMaster);
api.use(express.json({ limit: '4kb' }));

const isPassword = (v: unknown): v is string => typeof v === 'string' && v.length >= MIN_PASSWORD;
const isValidMinutes = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_EXPIRY_MINUTES;
const parseId = (raw: string): number | null => (/^\d{1,9}$/.test(raw) ? Number(raw) : null);

// ---------- Files ----------

api.get('/files', async (_req, res) => {
  res.json(await listFiles());
});

api.get('/files/:token/downloads', async (req, res) => {
  if (!isToken(req.params.token)) return res.status(404).json({ error: 'Not found' });
  res.json(await listDownloads(req.params.token));
});

api.patch('/files/:token', async (req, res) => {
  const body = req.body ?? {};
  const changes: FileChanges = {};

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) return res.status(400).json({ error: 'Invalid name' });
    changes.name = cleanFilename(body.name.trim());
  }
  if (body.downloadPassword !== undefined) {
    if (!isPassword(body.downloadPassword)) {
      return res.status(400).json({ error: `Download password must be at least ${MIN_PASSWORD} characters` });
    }
    changes.password = await hashPassword(body.downloadPassword);
  }
  if (body.expiresInMinutes !== undefined) {
    if (!isValidMinutes(body.expiresInMinutes)) return res.status(400).json({ error: 'Invalid expiry' });
    changes.expiresInMinutes = body.expiresInMinutes;
  }
  if (!Object.keys(changes).length) return res.status(400).json({ error: 'Nothing to change' });

  if (!isToken(req.params.token) || !(await updateFile(req.params.token, changes))) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.json({ ok: true });
});

api.delete('/files/:token', async (req, res) => {
  if (!isToken(req.params.token) || !(await deleteFile(req.params.token))) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.json({ ok: true });
});

// ---------- Guest uploaders ----------

api.get('/guests', async (_req, res) => {
  res.json(await listGuests());
});

api.post('/guests', async (req, res) => {
  const { name, password } = req.body ?? {};
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed || trimmed.length > MAX_GUEST_NAME) {
    return res.status(400).json({ error: `Name must be 1-${MAX_GUEST_NAME} characters` });
  }
  if (trimmed.toLowerCase() === MASTER_LABEL) return res.status(400).json({ error: 'That name is reserved' });
  if (!isPassword(password)) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters` });
  }

  try {
    res.status(201).json({ id: await createGuest(trimmed, password) });
  } catch (e) {
    if ((e as { code?: string }).code === '23505') return res.status(409).json({ error: 'A guest with that name exists' });
    throw e;
  }
});

api.patch('/guests/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const password = req.body?.password;
  if (!isPassword(password)) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters` });
  }
  if (id === null || !(await setGuestPassword(id, password))) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

api.delete('/guests/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null || !(await deleteGuest(id))) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.use('/api/admin', api);

export default router;
