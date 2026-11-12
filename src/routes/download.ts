import express, { Response, Router } from 'express';
import { pipeline } from 'stream/promises';
import { FileInfo, findFileInfo, recordDownload } from '../files.js';
import { checkPreviewKey, createPreviewKey, previewOf } from '../preview.js';
import { fileSize, readFile, storedPath } from '../storage.js';
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
    previewable: previewOf(info.name) ? '1' : undefined,
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

    const size = await fileSize(req.params.token);
    if (size === null) return notFound(res);
    await recordDownload(req.params.token, ip).catch((e) => console.error('Could not log download:', e));

    // "Preview" button: the password was right, so open the preview page with a short-lived key.
    if (req.body?.preview === '1') {
      if (!previewOf(info.name)) return res.status(400).send(formPage(info, 'This file cannot be previewed'));
      return res.redirect(303, `/d/${req.params.token}/preview?k=${createPreviewKey(req.params.token)}`);
    }
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(info.name)}`,
      'Content-Length': String(size),
    });
    // Streamed from disk, so big files do not sit in memory. A cut-off download just ends the connection.
    await pipeline(readFile(req.params.token), res).catch(() => res.destroy());
  } catch (e) {
    serverError(res, e);
  }
});

// Preview page and the raw content it loads. Both need the key from a correct password.
async function previewAccess(req: express.Request<{ token: string }>, res: Response) {
  const info = await findFileInfo(req.params.token);
  const preview = info && previewOf(info.name);
  if (!info || !preview || !checkPreviewKey(req.query.k, req.params.token)) {
    notFound(res);
    return null;
  }
  return { info, preview };
}

router.get('/d/:token/preview', async (req, res) => {
  try {
    const access = await previewAccess(req, res);
    if (!access) return;
    const key = encodeURIComponent(String(req.query.k));
    res.send(
      render(
        'preview',
        access.info.name,
        { name: access.info.name, kind: access.preview.kind, src: `/d/${req.params.token}/raw?k=${key}` },
        'wide',
      ),
    );
  } catch (e) {
    serverError(res, e);
  }
});

router.get('/d/:token/raw', async (req, res) => {
  try {
    const access = await previewAccess(req, res);
    if (!access) return;
    res.set({
      'Content-Type': access.preview.contentType,
      'Content-Disposition': 'inline',
      // The file is data, never a page: no scripts, whatever it contains.
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    // sendFile handles Range requests, so videos can seek and text can be fetched in part.
    res.sendFile(storedPath(req.params.token), (err) => {
      if (err && !res.headersSent) notFound(res);
    });
  } catch (e) {
    serverError(res, e);
  }
});

export default router;
