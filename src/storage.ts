import fs from 'fs';
import { mkdir, readdir, rename, rm, stat } from 'fs/promises';
import { once } from 'events';
import path from 'path';
import { DATA_DIR } from './config.js';

// File contents live on disk, one file per token. Tokens are validated (isToken) before they get here,
// so they are always safe to use as file names. Uploads are written to "<token>.part" first.
const DIR = path.join(DATA_DIR, 'files');
const finalPath = (token: string): string => path.join(DIR, token);
/** Absolute path of a stored file (for res.sendFile). */
export const storedPath = (token: string): string => path.resolve(finalPath(token));
const partPath = (token: string): string => path.join(DIR, `${token}.part`);

/** Creates the storage folder and removes half-written uploads left by a crash. */
export async function initStorage(): Promise<void> {
  await mkdir(DIR, { recursive: true });
  for (const name of await readdir(DIR)) {
    if (name.endsWith('.part')) await rm(path.join(DIR, name), { force: true });
  }
}

/**
 * Writes the stream to a temporary file. Returns its size, or null (leaving nothing behind) if it
 * grows past `maxBytes`. Follow up with commitFile, or discardFile to drop it.
 */
export async function saveStream(token: string, source: AsyncIterable<Buffer>, maxBytes: number): Promise<number | null> {
  const out = fs.createWriteStream(partPath(token), { flags: 'wx' });
  out.on('error', () => {}); // failures surface through the awaits below
  let total = 0;
  try {
    for await (const chunk of source) {
      total += chunk.length;
      if (total > maxBytes) {
        await discardFile(token, out);
        return null;
      }
      if (!out.write(chunk)) await once(out, 'drain');
    }
    out.end();
    await once(out, 'finish');
    return total;
  } catch (e) {
    await discardFile(token, out);
    throw e;
  }
}

/** Makes a saved upload the real file. */
export async function commitFile(token: string): Promise<void> {
  await rename(partPath(token), finalPath(token));
}

/** Removes a temporary or committed file, if there is one. */
export async function discardFile(token: string, openStream?: fs.WriteStream): Promise<void> {
  if (openStream && !openStream.closed) {
    await new Promise<void>((resolve) => {
      openStream.once('close', () => resolve());
      openStream.destroy();
    });
  }
  await rm(partPath(token), { force: true, maxRetries: 3 });
  await rm(finalPath(token), { force: true, maxRetries: 3 });
}

export async function removeFiles(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    await rm(finalPath(token), { force: true, maxRetries: 3 }).catch((e) => console.error('Could not remove file:', e));
  }
}

/** Size in bytes of a stored file, or null if it is not on disk. */
export async function fileSize(token: string): Promise<number | null> {
  try {
    return (await stat(finalPath(token))).size;
  } catch {
    return null;
  }
}

export const readFile = (token: string): fs.ReadStream => fs.createReadStream(finalPath(token));
