import express, { Response, Router } from 'express';
import { MAX_EXPIRY_MINUTES } from '../config.js';
import {
  canManage,
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
import { Limits, limitsFor, uploadBound } from '../limits.js';
import { hashPassword } from '../password.js';
import { previewOf } from '../preview.js';
import { storedPath } from '../storage.js';
import { ffmpegAvailable } from '../trim.js';
import { PRESETS, reservedBytes, slotKey } from '../video.js';
import { currentIdentity, requireAuth } from '../session.js';

// No minimum length, but an empty password is not a password: use "no password" for open downloads.
export const isPassword = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isValidMinutes = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_EXPIRY_MINUTES;

/** Sends 404 (not 403, so tokens of other people's files are not confirmed) unless the user may manage the file. */
export async function authorize(res: Response, token: string): Promise<boolean> {
  if (isToken(token) && (await canManage(currentIdentity(res), token))) return true;
  res.status(404).json({ error: 'Not found' });
  return false;
}

const MAX_TITLE = 200;
/** A title from user input: trimmed, null when empty. Returns false if it is too long. */
export const cleanTitle = (v: unknown): string | null | false => {
  if (typeof v !== 'string' || !v.trim()) return null;
  return v.trim().length > MAX_TITLE ? false : v.trim();
};

export interface UploadMeta {
  noPassword: boolean;
  downloadPassword: unknown;
  minutes: number; // 0 = never
}

/** Checks the password choice and the expiry against the user's limits. Returns a message, or null if fine. */
export function checkUploadMeta(meta: UploadMeta, limits: Limits): string | null {
  // Either a download password, or an explicit "no password" choice.
  if (!meta.noPassword && !isPassword(meta.downloadPassword)) return 'Enter a download password, or choose "No password"';
  if (!isValidMinutes(meta.minutes)) return 'Invalid expiry';
  if (limits.maxExpiryMinutes !== null && (meta.minutes === 0 || meta.minutes > limits.maxExpiryMinutes)) {
    return `Files must be deleted within ${limits.maxExpiryMinutes} minutes`;
  }
  return null;
}

const router = Router();
router.use(['/api/files', '/api/limits'], requireAuth);

// What the signed-in user may upload, so the upload page can show and enforce it.
router.get('/api/limits', async (_req, res) => {
  res.json({ ...(await limitsFor(currentIdentity(res))), canEditVideo: await ffmpegAvailable(), videoPresets: PRESETS });
});

router.get('/api/files', async (_req, res) => {
  res.json(await listFiles(currentIdentity(res)));
});

// Upload: the raw file is the request body; the metadata travels in headers.
router.put('/api/files', async (req, res) => {
  try {
    const identity = currentIdentity(res);
    const limits = await limitsFor(identity);

    const noPassword = req.get('x-no-password') === '1';
    const downloadPassword = headerValue(req, 'x-download-password');
    const minutes = Number(req.get('x-expires-minutes') || 0);
    const problem = checkUploadMeta({ noPassword, downloadPassword, minutes }, limits);
    if (problem) return res.status(400).json({ error: problem });
    const title = cleanTitle(headerValue(req, 'x-title'));
    if (title === false) return res.status(400).json({ error: `The title can be at most ${MAX_TITLE} characters` });

    // The largest this upload may be: the per-file limit, or what is left of the guest's storage quota.
    const bound = uploadBound(limits);
    if (Number(req.get('content-length') || 0) > bound.maxBytes) return res.status(413).json({ error: bound.message });

    const stored = await insertFile(
      {
        name: cleanFilename(headerValue(req, 'x-filename')),
        title,
        source: req, // streamed to disk, never held in memory whole
        maxBytes: bound.maxBytes,
        password: noPassword ? null : await hashPassword(downloadPassword as string),
        expiresInMinutes: minutes,
        uploader: identity.role === 'master' ? MASTER_LABEL : identity.name,
        guestId: identity.role === 'guest' ? identity.guestId : null,
      },
      limits.maxTotalBytes,
      reservedBytes(slotKey(identity)),
    );
    // Both limits are checked again while storing: the real size is only known then, and the quota
    // can change while the upload is in flight.
    if (!stored.ok) {
      return stored.reason === 'quota'
        ? res.status(413).json({ error: 'Not enough storage left. Delete a file or ask for more space.' })
        : res.status(413).json({ error: bound.message });
    }
    res.json({ link: `/d/${stored.token}`, expiresAt: stored.expiresAt });
  } catch (e) {
    if (req.destroyed) return; // the client cancelled or lost connection; nothing was stored
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
  if (body.title !== undefined) {
    // The title is only what is shown. The file name (and its extension) never changes, so previews,
    // embeds and video editing keep working whatever the title is.
    const title = cleanTitle(body.title);
    if (title === false) return res.status(400).json({ error: `The title can be at most ${MAX_TITLE} characters` });
    changes.title = title;
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

router.delete('/api/files/:token', async (req, res) => {
  if (!(await authorize(res, req.params.token))) return;
  if (!(await deleteFile(req.params.token))) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

export default router;
