import express, { Router } from 'express';
import { fileName, setEditedVideo } from '../files.js';
import { previewOf } from '../preview.js';
import { requireAuth } from '../session.js';
import { draftPath } from '../storage.js';
import { ffmpegAvailable } from '../trim.js';
import { applyJob, discardJob, getJob, parseVideoRequest, startJob } from '../video.js';
import { authorize } from './files.js';

// Cutting and compressing a stored video. The result is a draft: look at it, then keep it (it replaces
// the original) or discard it. Only the file's owner (or the master) can do any of this.
const router = Router();
router.use('/api/files/:token/video', requireAuth);

router.post('/api/files/:token/video', express.json({ limit: '1kb' }), async (req, res) => {
  const token = req.params.token;
  if (!(await authorize(res, token))) return;
  const preview = previewOf((await fileName(token)) ?? '');
  if (preview?.kind !== 'video') return res.status(400).json({ error: 'Only video files can be edited' });
  if (!(await ffmpegAvailable())) return res.status(400).json({ error: 'Editing videos is not available on this server' });

  const request = parseVideoRequest(req.body);
  if (typeof request === 'string') return res.status(400).json({ error: request });
  if (!(await startJob(token, preview.contentType, request))) {
    return res.status(409).json({ error: 'This video is already being edited' });
  }
  res.json(getJob(token));
});

// Progress, and the result's size once it is done.
router.get('/api/files/:token/video', async (req, res) => {
  if (!(await authorize(res, req.params.token))) return;
  res.json(getJob(req.params.token) ?? { state: 'none' });
});

// The finished draft, to play before deciding.
router.get('/api/files/:token/video/draft', async (req, res) => {
  if (!(await authorize(res, req.params.token))) return;
  const job = getJob(req.params.token);
  if (job?.state !== 'done') return res.status(404).json({ error: 'No finished result' });
  res.set({
    'Content-Type': job.contentType,
    'Content-Disposition': 'inline',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  res.sendFile(draftPath(req.params.token), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Not found' });
  });
});

router.post('/api/files/:token/video/apply', async (req, res) => {
  const token = req.params.token;
  if (!(await authorize(res, token))) return;
  const name = (await fileName(token)) ?? '';
  const applied = await applyJob(token);
  if (!applied) return res.status(400).json({ error: 'There is no finished result to keep' });
  // A compressed video is always an mp4, so its name has to say so.
  const newName = applied.reencoded && !/\.mp4$/i.test(name) ? `${name.replace(/\.[^.]+$/, '')}.mp4` : name;
  await setEditedVideo(token, applied.size, newName);
  res.json({ name: newName, size: applied.size });
});

// Cancels a running job, or throws away a finished draft.
router.delete('/api/files/:token/video', async (req, res) => {
  if (!(await authorize(res, req.params.token))) return;
  await discardJob(req.params.token);
  res.json({ ok: true });
});

export default router;
