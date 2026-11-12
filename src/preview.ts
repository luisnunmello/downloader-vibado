import crypto from 'crypto';

// Which files the browser may show inline. Everything else is download only. HTML and SVG are deliberately
// absent: shown inline they could run scripts. Text is always served as text/plain.
const IMAGES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
};
const VIDEOS: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg' };
const TEXTS = new Set(
  'txt md log csv tsv json xml yml yaml ini conf toml js mjs ts py sh bat css java c h cpp go rs rb php sql'.split(' '),
);

export interface Preview {
  kind: 'image' | 'video' | 'text';
  contentType: string;
}

/** How a file with this name can be previewed, or null if it cannot. */
export function previewOf(name: string): Preview | null {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (IMAGES[ext]) return { kind: 'image', contentType: IMAGES[ext] };
  if (VIDEOS[ext]) return { kind: 'video', contentType: VIDEOS[ext] };
  if (TEXTS.has(ext)) return { kind: 'text', contentType: 'text/plain; charset=utf-8' };
  return null;
}

// A password-protected file has no cookie to prove the visitor entered the password, so a correct password
// is exchanged for a short-lived random key that the preview page uses to load the content.
const KEY_TTL_MS = 60 * 60 * 1000;
const keys = new Map<string, { token: string; expires: number }>();

export function createPreviewKey(token: string): string {
  const now = Date.now();
  for (const [key, entry] of keys) if (entry.expires <= now) keys.delete(key);
  const key = crypto.randomBytes(18).toString('base64url');
  keys.set(key, { token, expires: now + KEY_TTL_MS });
  return key;
}

export function checkPreviewKey(key: unknown, token: string): boolean {
  if (typeof key !== 'string') return false;
  const entry = keys.get(key);
  return !!entry && entry.token === token && entry.expires > Date.now();
}
