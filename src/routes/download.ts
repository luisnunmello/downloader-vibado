import express, { Response, Router } from 'express';
import { FileInfo, findFileInfo, getFileData, recordDownload } from '../files.js';
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

    const data = await getFileData(req.params.token);
    if (!data) return notFound(res);
    await recordDownload(req.params.token, ip).catch((e) => console.error('Could not log download:', e));
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(info.name)}`,
      'Content-Length': String(data.length),
    });
    res.end(data);
  } catch (e) {
    serverError(res, e);
  }
});

export default router;
