import express, { Response, Router } from 'express';
import { MAX_EXPIRY_MINUTES } from '../config.js';
import {
  canManage,
  CutError,
  cutStoredVideo,
  deleteFile,
  FileChanges,
  insertFile,
  isToken,
  listDownloads,
  fileName,
  listFiles,
  updateFile,
} from '../files.js';
import { MASTER_LABEL } from '../guests.js';
import { cleanFilename, headerValue } from '../http.js';
import { limitsFor } from '../limits.js';
import { hashPassword } from '../password.js';
import { previewOf } from '../preview.js';
import { storedPath } from '../storage.js';
import { ffmpegAvailable, parseCut } from '../trim.js';
import { currentIdentity, requireAuth } from '../session.js';

// No minimum length, but an empty password is not a password: use "no password" for open downloads.
export const isPassword = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isValidMinutes = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_EXPIRY_MINUTES;

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
  res.json({ ...(await limitsFor(currentIdentity(res))), canCut: await ffmpegAvailable() });
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

    // Optional: keep only part of a video (seconds).
    const cutStart = req.get('x-cut-start');
    const cutEnd = req.get('x-cut-end');
    let cut;
    if (cutStart || cutEnd) {
      cut = parseCut(cutStart, cutEnd);
      if (!cut) return res.status(400).json({ error: 'Invalid cut: the end must be after the start' });
      if (!(await ffmpegAvailable())) return res.status(400).json({ error: 'Cutting videos is not available on this server' });
    }

    const stored = await insertFile(
      {
        name: cleanFilename(headerValue(req, 'x-filename')),
        source: req, // streamed into the database, never held in memory whole
        maxBytes,
        cut,
        password: noPassword ? null : await hashPassword(downloadPassword),
        expiresInMinutes: minutes,
        uploader: identity.role === 'master' ? MASTER_LABEL : identity.name,
        guestId: identity.role === 'guest' ? identity.guestId : null,
      },
      limits.maxTotalBytes,
    );
    // Both limits are checked again while storing: the real size is only known then, and the quota
    // can change while the upload is in flight.
    if (!stored.ok) {
      return stored.reason === 'quota'
        ? res.status(413).json({ error: 'Not enough storage left. Delete a file or ask for more space.' })
        : res.status(413).json(tooLarge());
    }
    res.json({ link: `/d/${stored.token}`, expiresAt: stored.expiresAt });
  } catch (e) {
    if (req.destroyed) return; // the client cancelled or lost connection; nothing was stored
    if (e instanceof CutError) return res.status(400).json({ error: `Could not cut the video: ${e.message}` });
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

// The owner's own view of a stored file (for the cut editor), without any download password.
router.get('/api/files/:token/raw', async (req, res) => {
  if (!(await authorize(res, req.params.token))) return;
  const preview = previewOf((await fileName(req.params.token)) ?? '');
  if (!preview) return res.status(404).json({ error: 'No preview for this file type' });
  res.set({ 'Content-Type': preview.contentType, 'Content-Disposition': 'inline', 'Content-Security-Policy': "default-src 'none'; sandbox" });
  res.sendFile(storedPath(req.params.token), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Not found' });
  });
});

// Cuts a stored video, replacing it with the clip. Body: { start?: seconds, end?: seconds }.
router.post('/api/files/:token/cut', express.json({ limit: '1kb' }), async (req, res) => {
  if (!(await authorize(res, req.params.token))) return;
  const cut = parseCut(req.body?.start, req.body?.end);
  if (!cut) return res.status(400).json({ error: 'Invalid cut: the end must be after the start' });
  if (!(await ffmpegAvailable())) return res.status(400).json({ error: 'Cutting videos is not available on this server' });
  try {
    if (!(await cutStoredVideo(req.params.token, cut))) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof CutError) return res.status(400).json({ error: `Could not cut the video: ${e.message}` });
    throw e;
  }
});

router.delete('/api/files/:token', async (req, res) => {
  if (!(await authorize(res, req.params.token))) return;
  if (!(await deleteFile(req.params.token))) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

export default router;
