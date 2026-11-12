import { Request, Router } from 'express';
import { authenticateUploader } from '../auth.js';
import { MAX_EXPIRY_MINUTES, MAX_SIZE } from '../config.js';
import { insertFile } from '../files.js';
import { cleanFilename, headerValue } from '../http.js';
import { hashPassword } from '../password.js';
import { isBlocked, recordFailure } from '../rateLimit.js';
import { render } from '../views.js';

const router = Router();

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

router.get('/upload', (_req, res) => {
  res.send(render('upload', 'Upload'));
});

router.put('/api/upload', async (req, res) => {
  const ip = req.ip ?? 'unknown';
  try {
    if (isBlocked(ip)) return res.status(429).json({ error: 'Too many attempts. Try later.' });

    // No guest name = master password; otherwise the named guest's password.
    const uploader = await authenticateUploader(
      headerValue(req, 'x-guest-name').trim(),
      headerValue(req, 'x-password'),
    );
    if (!uploader) {
      recordFailure(ip);
      return res.status(401).json({ error: 'Wrong guest name or password' });
    }

    const downloadPassword = headerValue(req, 'x-download-password');
    if (downloadPassword.length < 4) {
      return res.status(400).json({ error: 'Download password must be at least 4 characters' });
    }
    const minutes = Number(req.get('x-expires-minutes') || 0);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_EXPIRY_MINUTES) {
      return res.status(400).json({ error: 'Invalid expiry' });
    }
    if (Number(req.get('content-length') || 0) > MAX_SIZE) {
      return res.status(413).json({ error: 'File too large' });
    }

    const data = await readBody(req, MAX_SIZE);
    if (!data) return res.status(413).json({ error: 'File too large' });

    const { salt, hash } = await hashPassword(downloadPassword);
    const { token, expiresAt } = await insertFile({
      name: cleanFilename(headerValue(req, 'x-filename')),
      data,
      salt,
      hash,
      expiresInMinutes: minutes,
      uploader,
    });
    res.json({ link: `/d/${token}`, expiresAt });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: 'Server error' });
  }
});

export default router;
