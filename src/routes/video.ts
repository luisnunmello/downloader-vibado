import express, { Router } from 'express';
import { rm } from 'fs/promises';
import { fileName, insertFile, setEditedVideo } from '../files.js';
import { MASTER_LABEL } from '../guests.js';
import { cleanFilename, headerValue } from '../http.js';
import { limitsFor, uploadBound } from '../limits.js';
import { hashPassword } from '../password.js';
import { previewOf } from '../preview.js';
import { currentIdentity, requireAuth } from '../session.js';
import { fileSize, previewResultPath, previewSourcePath, saveStreamTo } from '../storage.js';
import { ffmpegAvailable } from '../trim.js';
import {
  discardTemp,
  forgetTemp,
  getTemp,
  keepReplace,
  parseVideoRequest,
  peekNewResult,
  slotKey,
  sourceReceived,
  startReplace,
  startUpload,
} from '../video.js';
import { authorize, checkUploadMeta, cleanTitle } from './files.js';

// Cutting and compressing videos. Each user has one temporary video: it is made here, looked at, and then
// either used (as the upload, or in place of the video it was made from) or thrown away. Starting another
// one replaces it. See src/video.ts.
const router = Router();
router.use(['/api/video-preview', '/api/files/:token/video-preview'], requireAuth);

const mbText = (bytes: number): string => String(Math.floor(bytes / 1024 / 1024));

// A video being uploaded to be edited: the raw file is the body, the options travel in headers.
router.put('/api/video-preview', async (req, res) => {
  const identity = currentIdentity(res);
  const key = slotKey(identity);
  let handle: ReturnType<typeof startUpload> | undefined;
  try {
    if (!(await ffmpegAvailable())) return res.status(400).json({ error: 'Editing videos is not available on this server' });
    const name = cleanFilename(headerValue(req, 'x-filename'));
    const preview = previewOf(name);
    if (preview?.kind !== 'video') return res.status(400).json({ error: 'Only mp4, webm and ogv videos can be edited' });
    const request = parseVideoRequest({
      start: req.get('x-start'),
      end: req.get('x-end'),
      preset: req.get('x-preset'),
      targetMb: req.get('x-target-mb'),
    });
    if (typeof request === 'string') return res.status(400).json({ error: request });

    await discardTemp(key); // a new preview replaces the old one, before the space is counted
    const limits = await limitsFor(identity);
    const bound = uploadBound(limits);
    if (Number(req.get('content-length') || 0) > bound.maxBytes) return res.status(413).json({ error: bound.message });

    // The result has to fit in what is left of the storage quota, like an upload.
    const free = limits.maxTotalBytes === null ? null : Math.max(0, limits.maxTotalBytes - (limits.usedBytes ?? 0));
    handle = startUpload(key, name, preview.contentType, request, free);
    const size = await saveStreamTo(previewSourcePath(key), req, bound.maxBytes);
    if (handle.cancelled()) {
      await rm(previewSourcePath(key), { force: true }); // replaced or discarded while uploading
      return res.status(409).json({ error: 'This preview was replaced by another one' });
    }
    if (size === null) {
      await discardTemp(key);
      return res.status(413).json({ error: bound.message });
    }
    sourceReceived(key, size);
    res.json(getTemp(key));
  } catch (e) {
    if (handle && !handle.cancelled()) await discardTemp(key);
    if (req.destroyed) return; // the client cancelled or lost connection
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: 'Server error' });
  }
});

// Editing a video the user already has: the result is kept beside it until they decide.
router.post('/api/files/:token/video-preview', express.json({ limit: '1kb' }), async (req, res) => {
  const token = req.params.token;
  if (!(await authorize(res, token))) return;
  const identity = currentIdentity(res);
  const key = slotKey(identity);
  const name = (await fileName(token)) ?? '';
  const preview = previewOf(name);
  if (preview?.kind !== 'video') return res.status(400).json({ error: 'Only video files can be edited' });
  if (!(await ffmpegAvailable())) return res.status(400).json({ error: 'Editing videos is not available on this server' });
  const request = parseVideoRequest(req.body);
  if (typeof request === 'string') return res.status(400).json({ error: request });

  await discardTemp(key);
  const limits = await limitsFor(identity);
  const free = limits.maxTotalBytes === null ? null : Math.max(0, limits.maxTotalBytes - (limits.usedBytes ?? 0));
  if (free !== null && free <= 0) {
    return res.status(413).json({ error: `Not enough storage left for the preview (${mbText(free)} MB free)` });
  }
  const sourceBytes = (await fileSize(token)) ?? 0;
  await startReplace(key, token, name, preview.contentType, request, free, sourceBytes);
  res.json(getTemp(key));
});

// Progress, and the result's size once it is done.
router.get('/api/video-preview', (_req, res) => {
  res.json(getTemp(slotKey(currentIdentity(res))) ?? { state: 'none' });
});

// The finished result, to play before deciding.
router.get('/api/video-preview/video', (_req, res) => {
  const key = slotKey(currentIdentity(res));
  const temp = getTemp(key);
  if (temp?.state !== 'done') return res.status(404).json({ error: 'No finished preview' });
  res.set({
    'Content-Type': temp.contentType,
    'Content-Disposition': 'inline',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  res.sendFile(previewResultPath(key), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Not found' });
  });
});

// Uploads the finished result (of a video that was uploaded to be edited): it becomes the file, and the
// original is never stored.
router.post('/api/video-preview/publish', express.json({ limit: '4kb' }), async (req, res) => {
  const identity = currentIdentity(res);
  const key = slotKey(identity);
  const result = peekNewResult(key);
  if (!result) return res.status(400).json({ error: 'There is no finished preview to upload' });

  const limits = await limitsFor(identity);
  const body = req.body ?? {};
  const noPassword = body.noPassword === true;
  const minutes = Number(body.expiresInMinutes || 0);
  const problem = checkUploadMeta({ noPassword, downloadPassword: body.downloadPassword, minutes }, limits);
  if (problem) return res.status(400).json({ error: problem });
  const title = cleanTitle(body.title);
  if (title === false) return res.status(400).json({ error: 'The title is too long' });

  const stored = await insertFile(
    {
      name: result.name,
      title,
      fromPath: { path: result.path, size: result.size },
      maxBytes: limits.maxSizeBytes,
      password: noPassword ? null : await hashPassword(body.downloadPassword as string),
      expiresInMinutes: minutes,
      uploader: identity.role === 'master' ? MASTER_LABEL : identity.name,
      guestId: identity.role === 'guest' ? identity.guestId : null,
    },
    limits.maxTotalBytes,
    0, // the preview is what is being stored, so it is not counted twice
  );
  if (!stored.ok) {
    return res.status(413).json({ error: 'Not enough storage left. Delete a file or ask for more space.' });
  }
  forgetTemp(key);
  res.json({ link: `/d/${stored.token}`, expiresAt: stored.expiresAt, name: result.name, size: result.size });
});

// Keeps the finished result of an edit: it replaces the video it was made from.
router.post('/api/video-preview/keep', async (req, res) => {
  const key = slotKey(currentIdentity(res));
  const kept = await keepReplace(key);
  if (!kept) return res.status(400).json({ error: 'There is no finished preview to keep' });
  await setEditedVideo(kept.token, kept.size, kept.name);
  res.json({ name: kept.name, size: kept.size });
});

// Cancels a running job, or throws away the temporary video.
router.delete('/api/video-preview', async (_req, res) => {
  await discardTemp(slotKey(currentIdentity(res)));
  res.json({ ok: true });
});

export default router;
