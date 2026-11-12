import express, { Response, Router } from 'express';
import fs from 'fs';
import { pipeline } from 'stream/promises';
import { PUBLIC_URL } from '../config.js';
import { FileInfo, findFileInfo, recordDownload } from '../files.js';
import { verifyPassword } from '../password.js';
import { checkPreviewKey, createPreviewKey, previewOf } from '../preview.js';
import { isBlocked, recordFailure } from '../rateLimit.js';
import { fileSize, readFile, readHead, storedPath, thumbnailPath } from '../storage.js';
import { ffmpegAvailable, makeThumbnail, videoSize } from '../trim.js';
import { escapeHtml, messagePage, render } from '../views.js';

const router = Router();

interface PageOptions {
  error?: string;
  head?: string; // extra <head> tags (link embeds)
  previewKey?: string; // proves the password was entered, so a protected file may be previewed
}

/**
 * The download page. A file without a password shows its preview right away; a protected one shows it
 * once the visitor has entered the password and asked for it (previewKey). Heavy parts (video, big
 * images) only start loading when the visitor interacts with them: see public/preview.js.
 */
async function formPage(info: FileInfo, token: string, opts: PageOptions = {}): Promise<string> {
  const preview = previewOf(info.name);
  const unlocked = !info.password || !!opts.previewKey;
  const showPreview = !!preview && unlocked;
  const query = info.password && opts.previewKey ? `?k=${encodeURIComponent(opts.previewKey)}` : '';
  const poster =
    showPreview && preview.kind === 'video' && (await ffmpegAvailable())
      ? `/d/${token}/thumb/preview.jpg${query}`
      : undefined;

  return render(
    'download',
    'Download',
    {
      name: info.name,
      size: (info.size / 1024 / 1024).toFixed(2),
      expires: info.expiresAt?.toISOString().replace('T', ' ').slice(0, 16),
      needsPassword: info.password && !opts.previewKey ? '1' : undefined,
      key: info.password ? opts.previewKey : undefined,
      canPreview: info.password && preview && !opts.previewKey ? '1' : undefined,
      previewKind: showPreview ? preview.kind : undefined,
      previewSrc: showPreview ? `/d/${token}/raw/${encodeURIComponent(info.name)}${query}` : undefined,
      previewBytes: showPreview ? info.size : undefined,
      previewPoster: poster,
      error: opts.error,
    },
    showPreview ? 'wide' : '',
    opts.head,
  );
}

const notFound = (res: Response) => res.status(404).send(messagePage('Not found'));
const serverError = (res: Response, e: unknown) => {
  console.error(e);
  res.status(500).send(messagePage('Server error'));
};

router.get('/d/:token', async (req, res) => {
  try {
    const info = await findFileInfo(req.params.token);
    if (!info) return notFound(res);
    res.send(await formPage(info, req.params.token, { head: info.password ? '' : await embedTags(req, info) }));
  } catch (e) {
    serverError(res, e);
  }
});

router.post('/d/:token', express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
  const ip = req.ip ?? 'unknown';
  const token = req.params.token;
  try {
    const info = await findFileInfo(token);
    if (!info) return notFound(res);

    // A key from an earlier correct password (given with the preview) stands in for the password.
    const key = typeof req.body?.key === 'string' ? req.body.key : '';
    const hasKey = !!info.password && checkPreviewKey(key, token);
    // Passwordless files still go through this POST (the page has a button), so link previews
    // and crawlers that only fetch the page do not trigger or log a download.
    if (info.password && !hasKey) {
      if (isBlocked(ip)) return res.status(429).send(await formPage(info, token, { error: 'Too many attempts. Try later.' }));
      if (!(await verifyPassword(req.body?.password, info.password.salt, info.password.hash))) {
        recordFailure(ip);
        return res.status(401).send(await formPage(info, token, { error: 'Wrong password' }));
      }
    }

    const size = await fileSize(token);
    if (size === null) return notFound(res);

    // "Preview" button (protected files): the password was right, so show the page again with the preview.
    if (req.body?.preview === '1') {
      if (!previewOf(info.name)) return res.status(400).send(await formPage(info, token, { error: 'This file cannot be previewed' }));
      await recordDownload(token, ip).catch((e) => console.error('Could not log download:', e));
      return res.send(await formPage(info, token, { previewKey: createPreviewKey(token) }));
    }

    // A download that follows a logged preview is not logged a second time.
    if (!hasKey) await recordDownload(token, ip).catch((e) => console.error('Could not log download:', e));
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(info.name)}`,
      'Content-Length': String(size),
    });
    // Streamed from disk, so big files do not sit in memory. A cut-off download just ends the connection.
    await pipeline(readFile(token), res).catch(() => res.destroy());
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
    // A still image too: big videos are not played inline by chat apps, which then show this instead.
    if (await ffmpegAvailable()) {
      const thumb = `${base}/thumb/preview.jpg`;
      tags.push(meta('og:image', thumb), meta('og:image:secure_url', thumb), meta('og:image:type', 'image/jpeg'));
      tags.push('  <meta name="twitter:card" content="summary_large_image">');
    }
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

// The content shown inline on the download page. Protected files need the key from a correct password;
// files without a password need nothing, since anyone with the link may already download them.
async function previewAccess(req: express.Request<{ token: string }>, res: Response) {
  const info = await findFileInfo(req.params.token);
  const preview = info && previewOf(info.name);
  if (!info || !preview || (info.password && !checkPreviewKey(req.query.k, req.params.token))) {
    notFound(res);
    return null;
  }
  return { info, preview };
}

// Still image of a video: the poster on the page, and the card image of link embeds. Made once, kept on disk.
router.get('/d/:token/thumb{/:name}', async (req, res) => {
  try {
    const access = await previewAccess(req, res);
    if (!access) return;
    if (access.preview.kind !== 'video' || !(await ffmpegAvailable())) return notFound(res);
    const thumb = thumbnailPath(req.params.token);
    if (!fs.existsSync(thumb)) await makeThumbnail(storedPath(req.params.token), thumb);
    res.set('Content-Type', 'image/jpeg');
    res.sendFile(thumb, (err) => {
      if (err && !res.headersSent) notFound(res);
    });
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
