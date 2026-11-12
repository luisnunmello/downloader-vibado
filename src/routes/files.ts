import express, { Request, Response, Router } from 'express';
import { MAX_EXPIRY_MINUTES, MAX_SIZE } from '../config.js';
import {
  canManage,
  deleteFile,
  FileChanges,
  insertFile,
  isToken,
  listDownloads,
  listFiles,
  updateFile,
} from '../files.js';
import { MASTER_LABEL } from '../guests.js';
import { cleanFilename, headerValue } from '../http.js';
import { hashPassword } from '../password.js';
import { currentIdentity, requireAuth } from '../session.js';

export const MIN_PASSWORD = 4;

export const isPassword = (v: unknown): v is string => typeof v === 'string' && v.length >= MIN_PASSWORD;
const isValidMinutes = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_EXPIRY_MINUTES;

/** Reads the request body, or returns null if it exceeds the size limit. */
async function readBody(req: Request, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Sends 404 (not 403, so tokens of other people's files are not confirmed) unless the user may manage the file. */
async function authorize(res: Response, token: string): Promise<boolean> {
  if (isToken(token) && (await canManage(currentIdentity(res), token))) return true;
  res.status(404).json({ error: 'Not found' });
  return false;
}

const router = Router();
router.use('/api/files', requireAuth);

router.get('/api/files', async (_req, res) => {
  res.json(await listFiles(currentIdentity(res)));
});

// Upload: the raw file is the request body; the metadata travels in headers.
router.put('/api/files', async (req, res) => {
  try {
    const downloadPassword = headerValue(req, 'x-download-password');
    if (!isPassword(downloadPassword)) {
      return res.status(400).json({ error: `Download password must be at least ${MIN_PASSWORD} characters` });
    }
    const minutes = Number(req.get('x-expires-minutes') || 0);
    if (!isValidMinutes(minutes)) return res.status(400).json({ error: 'Invalid expiry' });
    if (Number(req.get('content-length') || 0) > MAX_SIZE) {
      return res.status(413).json({ error: 'File too large' });
    }

    const data = await readBody(req, MAX_SIZE);
    if (!data) return res.status(413).json({ error: 'File too large' });

    const identity = currentIdentity(res);
    const { salt, hash } = await hashPassword(downloadPassword);
    const { token, expiresAt } = await insertFile({
      name: cleanFilename(headerValue(req, 'x-filename')),
      data,
      salt,
      hash,
      expiresInMinutes: minutes,
      uploader: identity.role === 'master' ? MASTER_LABEL : identity.name,
      guestId: identity.role === 'guest' ? identity.guestId : null,
    });
    res.json({ link: `/d/${token}`, expiresAt });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: 'Server error' });
  }
});

router.get('/api/files/:token/downloads', async (req, res) => {
  if (!(await authorize(res, req.params.token))) return;
  res.json(await listDownloads(req.params.token));
});

router.patch('/api/files/:token', express.json({ limit: '4kb' }), async (req, res) => {
  if (!(await authorize(res, req.params.token))) return;

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

  if (!(await updateFile(req.params.token, changes))) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.delete('/api/files/:token', async (req, res) => {
  if (!(await authorize(res, req.params.token))) return;
  if (!(await deleteFile(req.params.token))) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

export default router;
