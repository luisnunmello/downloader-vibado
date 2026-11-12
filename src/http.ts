import { Request } from 'express';

// Passwords and filenames travel URI-encoded in headers so non-ASCII characters survive.
export function headerValue(req: Request, name: string): string {
  const raw = req.get(name) ?? '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function cleanFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  return base.replace(/[\r\n"]/g, '_').slice(0, 200) || 'file';
}
