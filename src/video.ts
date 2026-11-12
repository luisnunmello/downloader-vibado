import { ChildProcess, spawn } from 'child_process';
import { rename, rm, stat } from 'fs/promises';
import { draftPath, fileSize, storedPath } from './storage.js';
import { probeVideo } from './trim.js';

// Cutting and compressing a stored video with ffmpeg. The result is first written next to the original as a
// "draft" so the owner can look at it, then either kept (it replaces the original) or discarded.

export interface Preset {
  id: string;
  label: string;
  height: number | null; // null = keep as is
  videoKbps: number | null;
  audioKbps: number;
}

export const PRESETS: Preset[] = [
  { id: 'original', label: 'Original quality (cut only, no re-encoding)', height: null, videoKbps: null, audioKbps: 0 },
  { id: 'high', label: 'High (up to 1080p)', height: 1080, videoKbps: 4000, audioKbps: 128 },
  { id: 'medium', label: 'Medium (up to 720p)', height: 720, videoKbps: 2000, audioKbps: 128 },
  { id: 'low', label: 'Low (up to 480p)', height: 480, videoKbps: 800, audioKbps: 96 },
  { id: 'tiny', label: 'Tiny (up to 360p)', height: 360, videoKbps: 400, audioKbps: 64 },
];
/** Not a preset: the user names the size they want, and the bitrate follows from the length. */
export const SIZE_PRESET = 'size';

export interface VideoRequest {
  start: number; // seconds
  end: number | null; // seconds; null = to the end
  preset: string; // a PRESETS id, or SIZE_PRESET
  targetMb: number | null; // for SIZE_PRESET
}

const MAX_SECONDS = 10_000_000;

/** Reads the request body. Returns the request, or a message saying what is wrong with it. */
export function parseVideoRequest(body: Record<string, unknown> | undefined): VideoRequest | string {
  const empty = (v: unknown) => v === undefined || v === null || v === '';
  const start = empty(body?.start) ? 0 : Number(body?.start);
  const end = empty(body?.end) ? null : Number(body?.end);
  if (!Number.isFinite(start) || start < 0 || start > MAX_SECONDS) return 'Invalid start time';
  if (end !== null && (!Number.isFinite(end) || end <= start || end > MAX_SECONDS)) return 'The end must be after the start';

  const preset = typeof body?.preset === 'string' ? body.preset : 'original';
  let targetMb: number | null = null;
  if (preset === SIZE_PRESET) {
    targetMb = Number(body?.targetMb);
    if (!Number.isFinite(targetMb) || targetMb < 1 || targetMb > 100_000) return 'Enter a target size in MB';
  } else if (!PRESETS.some((p) => p.id === preset)) {
    return 'Unknown quality option';
  }
  if (preset === 'original' && start === 0 && end === null) return 'Nothing to do: set a start or end time, or pick a lower quality';
  return { start, end, preset, targetMb };
}

const AUDIO_KBPS_FOR_TARGET = 96;
const heightFor = (videoKbps: number): number => (videoKbps >= 3000 ? 1080 : videoKbps >= 1500 ? 720 : videoKbps >= 600 ? 480 : 360);

/**
 * The encoder settings for a request, given the clip length and the source's bitrate. The pages show an
 * estimate from the same numbers (see public/common.js), so keep them in step.
 */
export function encodeSettings(req: VideoRequest, clipSeconds: number, sourceKbps: number) {
  if (req.preset === 'original') return null;
  let videoKbps: number;
  let audioKbps: number;
  let height: number;
  if (req.preset === SIZE_PRESET) {
    audioKbps = AUDIO_KBPS_FOR_TARGET;
    videoKbps = Math.max(100, Math.floor((req.targetMb! * 8192) / clipSeconds) - audioKbps);
    height = heightFor(videoKbps);
  } else {
    const preset = PRESETS.find((p) => p.id === req.preset)!;
    audioKbps = preset.audioKbps;
    // Never ask for more than the source has: that would only make the file bigger.
    videoKbps = Math.min(preset.videoKbps!, Math.max(100, Math.floor(sourceKbps) - audioKbps));
    height = preset.height!;
  }
  return { videoKbps, audioKbps, height };
}

export type JobState = 'queued' | 'running' | 'done' | 'error';

export interface VideoJob {
  state: JobState;
  percent: number;
  error?: string;
  originalBytes: number;
  resultBytes?: number;
  contentType: string; // of the result
  reencoded: boolean; // the result is an mp4, whatever the original was
}

interface Job extends VideoJob {
  request: VideoRequest;
  proc?: ChildProcess;
  cancelled: boolean;
  finishedAt?: number;
}

const jobs = new Map<string, Job>();
let queue: Promise<unknown> = Promise.resolve(); // one ffmpeg at a time, so the server stays responsive

export const getJob = (token: string): VideoJob | null => {
  const job = jobs.get(token);
  if (!job) return null;
  const { request: _r, proc: _p, cancelled: _c, finishedAt: _f, ...visible } = job;
  return visible;
};

/** Starts a job for the file. Returns false if one is already running for it. */
export async function startJob(token: string, sourceContentType: string, request: VideoRequest): Promise<boolean> {
  const running = jobs.get(token);
  if (running && (running.state === 'queued' || running.state === 'running')) return false;
  const now = Date.now();
  for (const [key, job] of jobs) if (job.finishedAt && now - job.finishedAt > 60 * 60 * 1000) jobs.delete(key);
  await rm(draftPath(token), { force: true });

  const reencoded = request.preset !== 'original';
  const job: Job = {
    state: 'queued',
    percent: 0,
    originalBytes: (await fileSize(token)) ?? 0,
    contentType: reencoded ? 'video/mp4' : sourceContentType,
    reencoded,
    request,
    cancelled: false,
  };
  jobs.set(token, job);
  queue = queue.then(() => run(token, job)).catch(() => {});
  return true;
}

/** Stops a running job, or throws away a finished one and its draft. */
export async function discardJob(token: string): Promise<void> {
  const job = jobs.get(token);
  if (job) {
    job.cancelled = true;
    job.proc?.kill('SIGKILL');
    jobs.delete(token);
  }
  await rm(draftPath(token), { force: true });
}

/** Makes the finished draft the real file. Returns its size and whether it is now an mp4, or null if there is none. */
export async function applyJob(token: string): Promise<{ size: number; reencoded: boolean } | null> {
  const job = jobs.get(token);
  if (!job || job.state !== 'done') return null;
  const size = (await stat(draftPath(token))).size;
  await rename(draftPath(token), storedPath(token));
  jobs.delete(token);
  return { size, reencoded: job.reencoded };
}

async function run(token: string, job: Job): Promise<void> {
  if (job.cancelled) return;
  job.state = 'running';
  const output = draftPath(token);
  try {
    const source = storedPath(token);
    const info = await probeVideo(source);
    if (!info) throw new Error('Could not read the video');
    const start = job.request.start;
    const end = Math.min(job.request.end ?? info.seconds, info.seconds);
    if (end <= start) throw new Error('The start is past the end of the video');
    const clipSeconds = end - start;

    const args = ['-v', 'error', '-nostats', '-progress', 'pipe:1', '-y', '-ss', String(start)];
    if (job.request.end !== null) args.push('-to', String(end));
    args.push('-i', source);
    const settings = encodeSettings(job.request, clipSeconds, info.kbps);
    if (settings) {
      args.push(
        '-vf', `scale=-2:'min(${settings.height},ih)'`,
        '-c:v', 'libx264', '-preset', 'veryfast',
        '-b:v', `${settings.videoKbps}k`, '-maxrate', `${Math.round(settings.videoKbps * 1.5)}k`, '-bufsize', `${settings.videoKbps * 2}k`,
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', `${settings.audioKbps}k`, '-ac', '2',
        '-movflags', '+faststart', '-f', 'mp4',
      );
    } else {
      // Cut only: copy the streams as they are (fast, lossless; the start snaps to the keyframe before it).
      const format = job.contentType.split('/')[1];
      args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero');
      if (format === 'mp4') args.push('-movflags', '+faststart');
      args.push('-f', format);
    }
    args.push(output);

    await new Promise<void>((resolve, reject) => {
      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      job.proc = proc;
      let log = '';
      proc.stderr.on('data', (d) => (log = (log + d).slice(-1000)));
      proc.stdout.on('data', (d: Buffer) => {
        // ffmpeg reports "out_time_us=<microseconds done>" lines
        const match = /out_time_us=(\d+)/.exec(d.toString());
        if (match) job.percent = Math.min(99, Math.floor((Number(match[1]) / 1e6 / clipSeconds) * 100));
      });
      const timer = setTimeout(() => proc.kill('SIGKILL'), 2 * 60 * 60 * 1000);
      proc.on('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`ffmpeg could not run: ${e.message}`));
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(job.cancelled ? 'Cancelled' : `ffmpeg failed: ${log.trim() || `exit code ${code}`}`));
      });
    });

    const { size } = await stat(output);
    if (size === 0) throw new Error('The result is empty: check the start and end times');
    if (job.cancelled) throw new Error('Cancelled');
    job.resultBytes = size;
    job.percent = 100;
    job.state = 'done';
  } catch (e) {
    await rm(output, { force: true });
    if (job.cancelled) return;
    job.state = 'error';
    job.error = e instanceof Error ? e.message : 'Could not process the video';
  } finally {
    job.proc = undefined;
    job.finishedAt = Date.now();
  }
}
