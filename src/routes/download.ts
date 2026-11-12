import express, { Response, Router } from 'express';
import { pipeline } from 'stream/promises';
import { FileInfo, findFileInfo, recordDownload } from '../files.js';
import { checkPreviewKey, createPreviewKey, previewOf } from '../preview.js';
import { PUBLIC_URL } from '../config.js';
import { fileSize, readFile, readHead, storedPath } from '../storage.js';
import { videoSize } from '../trim.js';
import { verifyPassword } from '../password.js';
import { isBlocked, recordFailure } from '../rateLimit.js';
import { escapeHtml, messagePage, render } from '../views.js';

const router = Router();

const formPage = (info: FileInfo, error?: string, head = ''): string =>
  render(
    'download',
    'Download',
    {
    name: info.name,
    size: (info.size / 1024 / 1024).toFixed(2),
    expires: info.expiresAt?.toISOString().replace('T', ' ').slice(0, 16),
    needsPassword: info.password ? '1' : undefined,
    previewable: previewOf(info.name) ? '1' : undefined,
    error,
    },
    '',
    head,
  );

const notFound = (res: Response) => res.status(404).send(messagePage('Not found'));
const serverError = (res: Response, e: unknown) => {
  console.error(e);
  res.status(500).send(messagePage('Server error'));
};

router.get('/d/:token', async (req, res) => {
  try {
    const info = await findFileInfo(req.params.token);
    if (!info) return notFound(res);
    res.send(formPage(info, undefined, info.password ? '' : await embedTags(req, info)));
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

// Link previews (WhatsApp, Discord, ...): crawlers only GET the page, so this is for files without a password,
// which anyone with the link can see anyway. Protected files get no embed, not even their name.
async function embedTags(req: express.Request<{ token: string }>, info: FileInfo): Promise<string> {
  const token = req.params.token;
  const base = `${PUBLIC_URL || `${req.protocol}://${req.get('host')}`}/d/${token}`;
  // The file name in the URL helps apps that guess the type from the extension.
  const rawUrl = `${base}/raw/${encodeURIComponent(info.name)}`;
  const preview = previewOf(info.name);
  const meta = (property: string, content: string) =>
    `  <meta property="${property}" content="${escapeHtml(content)}">`;
  const sizeText = `${(info.size / 1024 / 1024).toFixed(2)} MB`;

  let description = `${sizeText} - open the link to download`;
  if (preview?.kind === 'text') {
    // The first lines of the file, so the card shows what is inside.
    const head = (await readHead(token, 600).catch(() => Buffer.alloc(0))).toString('utf8').replace(/\s+/g, ' ').trim();
    if (head) description = head.length > 200 ? `${head.slice(0, 200)}...` : head;
  }

  const tags = [
    meta('og:site_name', 'File sharing'),
    meta('og:type', preview?.kind === 'video' ? 'video.other' : 'website'),
    meta('og:url', base),
    meta('og:title', info.name),
    meta('og:description', description),
  ];
  if (preview?.kind === 'image') {
    tags.push(meta('og:image', rawUrl), meta('og:image:secure_url', rawUrl), meta('og:image:type', preview.contentType));
    tags.push('  <meta name="twitter:card" content="summary_large_image">');
  } else if (preview?.kind === 'video') {
    const { width, height } = await videoSize(token, storedPath(token));
    tags.push(
      meta('og:video', rawUrl),
      meta('og:video:url', rawUrl),
      meta('og:video:secure_url', rawUrl),
      meta('og:video:type', preview.contentType),
      meta('og:video:width', String(width)),
      meta('og:video:height', String(height)),
    );
  }
  return tags.join('\n');
}

// Preview page and the raw content it loads. They need the key from a correct password,
// except for files without a password, which anyone with the link may already download.
async function previewAccess(req: express.Request<{ token: string }>, res: Response) {
  const info = await findFileInfo(req.params.token);
  const preview = info && previewOf(info.name);
  if (!info || !preview || (info.password && !checkPreviewKey(req.query.k, req.params.token))) {
    notFound(res);
    return null;
  }
  return { info, preview };
}

router.get('/d/:token/preview', async (req, res) => {
  try {
    const access = await previewAccess(req, res);
    if (!access) return;
    const key = typeof req.query.k === 'string' ? `?k=${encodeURIComponent(req.query.k)}` : '';
    res.send(
      render(
        'preview',
        access.info.name,
        { name: access.info.name, kind: access.preview.kind, src: `/d/${req.params.token}/raw${key}` },
        'wide',
      ),
    );
  } catch (e) {
    serverError(res, e);
  }
});

router.get('/d/:token/raw{/:name}', async (req, res) => {
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
