import { spawn } from 'child_process';
import crypto from 'crypto';
import { rename, rm, stat } from 'fs/promises';

// Everything that uses ffmpeg/ffprobe (thumbnails, cutting, compressing). Without them on the server
// (the Docker image has them), the features are switched off in the pages instead of failing.
let available: Promise<boolean> | null = null;
export const ffmpegAvailable = (): Promise<boolean> =>
  (available ??= new Promise((resolve) => {
    const probe = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    probe.on('error', () => resolve(false));
    probe.on('exit', (code) => resolve(code === 0));
  }));

export class TrimError extends Error {}

const sizes = new Map<string, { width: number; height: number }>();

/** Width and height of a video (link embeds want them), or a 16:9 guess if ffprobe cannot tell. */
export async function videoSize(key: string, file: string): Promise<{ width: number; height: number }> {
  const known = sizes.get(key);
  if (known) return known;
  const guess = { width: 1280, height: 720 };
  const found = await new Promise<{ width: number; height: number } | null>((resolve) => {
    const proc = spawn(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.on('error', () => resolve(null));
    proc.on('exit', () => {
      const [width, height] = out.trim().split(',').map(Number);
      resolve(width > 0 && height > 0 ? { width, height } : null);
    });
  });
  const result = found ?? guess;
  if (sizes.size > 500) sizes.clear();
  sizes.set(key, result);
  return result;
}

/** Length in seconds and overall bitrate in kbit/s of a video file, or null if ffprobe cannot read it. */
export async function probeVideo(file: string): Promise<{ seconds: number; kbps: number } | null> {
  return new Promise((resolve) => {
    const proc = spawn(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration,bit_rate', '-of', 'json', file],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.on('error', () => resolve(null));
    proc.on('exit', () => {
      try {
        const format = JSON.parse(out).format;
        const seconds = Number(format.duration);
        const kbps = Number(format.bit_rate) / 1000;
        resolve(seconds > 0 ? { seconds, kbps: kbps > 0 ? kbps : 0 } : null);
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * Writes a JPEG still from the video to `out` (for link embeds and the video poster).
 * Takes the frame at one second, or the first frame for shorter videos.
 */
export async function makeThumbnail(file: string, out: string): Promise<void> {
  const tmp = `${out}.${crypto.randomBytes(4).toString('hex')}.part`;
  const attempt = (seek: string) =>
    new Promise<boolean>((resolve) => {
      const proc = spawn(
        'ffmpeg',
        ['-v', 'error', '-y', '-ss', seek, '-i', file, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-q:v', '4', '-f', 'image2', tmp],
        { stdio: 'ignore' },
      );
      const timer = setTimeout(() => proc.kill('SIGKILL'), 60 * 1000);
      proc.on('error', () => resolve(false));
      proc.on('exit', async (code) => {
        clearTimeout(timer);
        resolve(code === 0 && (await stat(tmp).then((s) => s.size > 0, () => false)));
      });
    });
  try {
    if (!(await attempt('1')) && !(await attempt('0'))) throw new TrimError('Could not make a thumbnail');
    await rename(tmp, out);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}
