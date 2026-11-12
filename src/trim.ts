import { spawn } from 'child_process';
import crypto from 'crypto';
import { rename, rm, stat } from 'fs/promises';

// Cutting videos needs ffmpeg on the server (the Docker image includes it). Without it, the feature is
// switched off in the pages instead of failing.
let available: Promise<boolean> | null = null;
export const ffmpegAvailable = (): Promise<boolean> =>
  (available ??= new Promise((resolve) => {
    const probe = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    probe.on('error', () => resolve(false));
    probe.on('exit', (code) => resolve(code === 0));
  }));

export class TrimError extends Error {}

export interface Cut {
  start: number; // seconds
  end: number | null; // seconds; null = to the end
}

const MAX_SECONDS = 10_000_000;

/** Reads start/end seconds (either may be empty). Returns null if they are not a sensible range. */
export function parseCut(startRaw: unknown, endRaw: unknown): Cut | null {
  const empty = (v: unknown) => v === undefined || v === null || v === '';
  const start = empty(startRaw) ? 0 : Number(startRaw);
  const end = empty(endRaw) ? null : Number(endRaw);
  if (!Number.isFinite(start) || start < 0 || start > MAX_SECONDS) return null;
  if (end !== null && (!Number.isFinite(end) || end <= start || end > MAX_SECONDS)) return null;
  if (start === 0 && end === null) return null; // that is the whole video: nothing to cut
  return { start, end };
}

/**
 * Cuts the video at `file` down to the given range and replaces it with the clip. Returns the clip's size.
 * The video is not re-encoded (fast, no quality loss), so the start snaps to the nearest keyframe before it.
 * `format` is the container: mp4, webm or ogg.
 */
export async function cutVideo(file: string, format: string, cut: Cut): Promise<number> {
  const out = `${file}.${crypto.randomBytes(4).toString('hex')}.part`;
  const args = ['-v', 'error', '-y', '-ss', String(cut.start)];
  if (cut.end !== null) args.push('-to', String(cut.end));
  args.push('-i', file, '-c', 'copy', '-avoid_negative_ts', 'make_zero');
  if (format === 'mp4') args.push('-movflags', '+faststart');
  args.push('-f', format, out);

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let log = '';
      proc.stderr.on('data', (d) => (log = (log + d).slice(-1000)));
      const timer = setTimeout(() => proc.kill('SIGKILL'), 30 * 60 * 1000);
      proc.on('error', (e) => {
        clearTimeout(timer);
        reject(new TrimError(`ffmpeg could not run: ${e.message}`));
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new TrimError(`ffmpeg failed: ${log.trim() || `exit code ${code}`}`));
      });
    });
    const { size } = await stat(out);
    if (size === 0) throw new TrimError('The cut is empty: check the start and end times');
    await rename(out, file);
    return size;
  } catch (e) {
    await rm(out, { force: true });
    throw e;
  }
}
