import express, { Response, Router } from 'express';
import { FileInfo, findFileInfo, openFile, recordDownload } from '../files.js';
import { verifyPassword } from '../password.js';
import { isBlocked, recordFailure } from '../rateLimit.js';
import { messagePage, render } from '../views.js';

const router = Router();

const formPage = (info: FileInfo, error?: string): string =>
  render('download', 'Download', {
    name: info.name,
    size: (info.size / 1024 / 1024).toFixed(2),
    expires: info.expiresAt?.toISOString().replace('T', ' ').slice(0, 16),
    needsPassword: info.password ? '1' : undefined,
    error,
  });

// Resolves when the response can take more data, or is gone.
const drained = (res: Response): Promise<void> =>
  new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
  });

const notFound = (res: Response) => res.status(404).send(messagePage('Not found'));
const serverError = (res: Response, e: unknown) => {
  console.error(e);
  res.status(500).send(messagePage('Server error'));
};

router.get('/d/:token', async (req, res) => {
  try {
    const info = await findFileInfo(req.params.token);
    if (!info) return notFound(res);
    res.send(formPage(info));
  } catch (e) {
    serverError(res, e);
  }
});

router.post('/d/:token', express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
  const ip = req.ip ?? 'unknown';
  try {
    const info = await findFileInfo(req.params.token);
    if (!info) return notFound(res);
    // Passwordless files still go through this POST (the page has a button), so link previews
    // and crawlers that only fetch the page do not trigger or log a download.
    if (info.password) {
      if (isBlocked(ip)) return res.status(429).send(formPage(info, 'Too many attempts. Try later.'));
      if (!(await verifyPassword(req.body?.password, info.password.salt, info.password.hash))) {
        recordFailure(ip);
        return res.status(401).send(formPage(info, 'Wrong password'));
      }
    }

    const chunks = await openFile(req.params.token);
    if (!chunks) return notFound(res);
    await recordDownload(req.params.token, ip).catch((e) => console.error('Could not log download:', e));
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(info.name)}`,
      'Content-Length': String(info.size),
    });
    // Streamed chunk by chunk, so big files do not sit in memory.
    let sent = 0;
    for await (const chunk of chunks) {
      if (res.destroyed) break;
      sent += chunk.length;
      if (!res.write(chunk)) await drained(res);
    }
    // If the file vanished or was cut short midway, drop the connection so the client sees a failed download.
    if (sent !== info.size) res.destroy();
    else res.end();
  } catch (e) {
    serverError(res, e);
  }
});

export default router;
