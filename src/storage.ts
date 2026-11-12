import fs from 'fs';
import { mkdir, open, readdir, rename, rm, stat } from 'fs/promises';
import { once } from 'events';
import path from 'path';
import { DATA_DIR } from './config.js';

// File contents live on disk, one file per token. Tokens are validated (isToken) before they get here,
// so they are always safe to use as file names. Uploads are written to "<token>.part" first.
const DIR = path.join(DATA_DIR, 'files');
const finalPath = (token: string): string => path.join(DIR, token);
const partPath = (token: string): string => path.join(DIR, `${token}.part`);
/** Absolute path of a stored file (for res.sendFile). */
export const storedPath = (token: string): string => path.resolve(finalPath(token));

// Each user has at most one temporary video (an upload being edited, or the preview of an edit): see video.ts.
// Its files live here, named after the user ("master" or "g<id>"), and never survive a restart.
const PREVIEW_DIR = path.join(DATA_DIR, 'preview');
export const previewSourcePath = (key: string): string => path.resolve(PREVIEW_DIR, `${key}.src`);
export const previewResultPath = (key: string): string => path.resolve(PREVIEW_DIR, `${key}.out`);

/** Creates the storage folders and removes half-written uploads and temporary videos left by a crash. */
export async function initStorage(): Promise<void> {
  await mkdir(DIR, { recursive: true });
  await mkdir(PREVIEW_DIR, { recursive: true });
  for (const name of await readdir(DIR)) {
    if (name.endsWith('.part')) await rm(path.join(DIR, name), { force: true });
  }
  for (const name of await readdir(PREVIEW_DIR)) await rm(path.join(PREVIEW_DIR, name), { force: true });
}

/**
 * Writes the stream to `target`. Returns its size, or null (leaving nothing behind) if it grows past
 * `maxBytes`. The file is removed again if anything goes wrong.
 */
export async function saveStreamTo(target: string, source: AsyncIterable<Buffer>, maxBytes: number): Promise<number | null> {
  const out = fs.createWriteStream(target, { flags: 'wx' });
  out.on('error', () => {}); // failures surface through the awaits below
  const drop = async () => {
    if (!out.closed) {
      await new Promise<void>((resolve) => {
        out.once('close', () => resolve());
        out.destroy();
      });
    }
    await rm(target, { force: true, maxRetries: 3 });
  };
  let total = 0;
  try {
    for await (const chunk of source) {
      total += chunk.length;
      if (total > maxBytes) {
        await drop();
        return null;
      }
      if (!out.write(chunk)) await once(out, 'drain');
    }
    out.end();
    await once(out, 'finish');
    return total;
  } catch (e) {
    await drop();
    throw e;
  }
}

/** Receives an upload into "<token>.part". Follow up with commitFile, or discardFile to drop it. */
export const saveStream = (token: string, source: AsyncIterable<Buffer>, maxBytes: number): Promise<number | null> =>
  saveStreamTo(partPath(token), source, maxBytes);

/** Makes a received upload the real file. */
export async function commitFile(token: string): Promise<void> {
  await rename(partPath(token), finalPath(token));
}

/** Makes an existing file (a finished temporary video) the real file, moving it without copying. */
export async function adoptFile(token: string, from: string): Promise<void> {
  await rename(from, finalPath(token));
}

/** Replaces the stored file with another one, moving it without copying. */
export const replaceStored = adoptFile;

/** Removes a temporary or committed file, if there is one. */
export async function discardFile(token: string): Promise<void> {
  await rm(partPath(token), { force: true, maxRetries: 3 });
  await rm(finalPath(token), { force: true, maxRetries: 3 });
}

/** Absolute path of a video's cached thumbnail (made on demand for link embeds). */
export const thumbnailPath = (token: string): string => path.resolve(`${finalPath(token)}.jpg`);

export async function removeThumbnail(token: string): Promise<void> {
  await rm(thumbnailPath(token), { force: true, maxRetries: 3 }).catch(() => {});
}

export async function removeFiles(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    await rm(finalPath(token), { force: true, maxRetries: 3 }).catch((e) => console.error('Could not remove file:', e));
    await removeThumbnail(token);
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

/** The first `bytes` bytes of a stored file (for text snippets in link embeds). */
export async function readHead(token: string, bytes: number): Promise<Buffer> {
  const handle = await open(finalPath(token), 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export const readFile = (token: string): fs.ReadStream => fs.createReadStream(finalPath(token));
