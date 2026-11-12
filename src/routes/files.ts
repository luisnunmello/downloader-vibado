import express, { Request, Response, Router } from 'express';
import { MAX_EXPIRY_MINUTES } from '../config.js';
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
import { limitsFor } from '../limits.js';
import { hashPassword } from '../password.js';
import { currentIdentity, requireAuth } from '../session.js';

// No minimum length, but an empty password is not a password: use "no password" for open downloads.
export const isPassword = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
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

const mb = (bytes: number): string => String(Math.floor(bytes / 1024 / 1024));

const router = Router();
router.use(['/api/files', '/api/limits'], requireAuth);

// What the signed-in user may upload, so the upload page can show and enforce it.
router.get('/api/limits', async (_req, res) => {
  res.json(await limitsFor(currentIdentity(res)));
});

router.get('/api/files', async (_req, res) => {
  res.json(await listFiles(currentIdentity(res)));
});

// Upload: the raw file is the request body; the metadata travels in headers.
router.put('/api/files', async (req, res) => {
  try {
    const identity = currentIdentity(res);
    const limits = await limitsFor(identity);

    // Either a download password, or an explicit "no password" choice.
    const noPassword = req.get('x-no-password') === '1';
    const downloadPassword = headerValue(req, 'x-download-password');
    if (!noPassword && !isPassword(downloadPassword)) {
      return res.status(400).json({ error: 'Enter a download password, or choose "No password"' });
    }
    const minutes = Number(req.get('x-expires-minutes') || 0);
    if (!isValidMinutes(minutes)) return res.status(400).json({ error: 'Invalid expiry' });
    if (limits.maxExpiryMinutes !== null && (minutes === 0 || minutes > limits.maxExpiryMinutes)) {
      return res.status(400).json({ error: `Files must be deleted within ${limits.maxExpiryMinutes} minutes` });
    }

    // The largest this upload may be: the per-file limit, or what is left of the guest's storage quota.
    const free =
      limits.maxTotalBytes === null ? Infinity : Math.max(0, limits.maxTotalBytes - (limits.usedBytes ?? 0));
    const maxBytes = Math.min(limits.maxSizeBytes, free);
    const tooLarge = () =>
      free < limits.maxSizeBytes
        ? { error: `Not enough storage left (${mb(free)} MB free of ${mb(limits.maxTotalBytes ?? 0)} MB)` }
        : { error: `File too large (maximum ${mb(limits.maxSizeBytes)} MB)` };
    if (Number(req.get('content-length') || 0) > maxBytes) return res.status(413).json(tooLarge());
    const data = await readBody(req, maxBytes);
    if (!data) return res.status(413).json(tooLarge());

    const stored = await insertFile(
      {
        name: cleanFilename(headerValue(req, 'x-filename')),
        data,
        password: noPassword ? null : await hashPassword(downloadPassword),
        expiresInMinutes: minutes,
        uploader: identity.role === 'master' ? MASTER_LABEL : identity.name,
        guestId: identity.role === 'guest' ? identity.guestId : null,
      },
      limits.maxTotalBytes,
    );
    // The quota is checked again inside the insert, in case other uploads finished while this one was in flight.
    if (!stored) return res.status(413).json({ error: 'Not enough storage left. Delete a file or ask for more space.' });
    const { token, expiresAt } = stored;
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
    // null removes the password, so anyone with the link can download
    if (body.downloadPassword === null) {
      changes.password = null;
    } else if (isPassword(body.downloadPassword)) {
      changes.password = await hashPassword(body.downloadPassword);
    } else {
      return res.status(400).json({ error: 'Download password cannot be empty' });
    }
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
