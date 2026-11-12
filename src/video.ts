import { ChildProcess, spawn } from 'child_process';
import { rename, rm, stat } from 'fs/promises';
import { Identity } from './auth.js';
import { previewResultPath, previewSourcePath, storedPath } from './storage.js';
import { probeVideo } from './trim.js';

// Cutting and compressing videos with ffmpeg. The result is made as a temporary video that the user can
// look at before deciding. Every user has at most one temporary video (a new one replaces it), and it
// takes up part of their storage quota until it is used or thrown away.
//
// Two kinds:
//   "new"      the user is uploading a video: the original is received into the temporary slot, edited, and
//              the result can then be published as the upload (the original is never stored).
//   "replace"  the user edits a video they already have: the result replaces it if they keep it.

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

/** Reads the request. Returns it, or a message saying what is wrong. */
export function parseVideoRequest(body: Record<string, unknown> | undefined): VideoRequest | string {
  const empty = (v: unknown) => v === undefined || v === null || v === '';
  const start = empty(body?.start) ? 0 : Number(body?.start);
  const end = empty(body?.end) ? null : Number(body?.end);
  if (!Number.isFinite(start) || start < 0 || start > MAX_SECONDS) return 'Invalid start time';
  if (end !== null && (!Number.isFinite(end) || end <= start || end > MAX_SECONDS)) return 'The end must be after the start';

  const preset = typeof body?.preset === 'string' && body.preset ? body.preset : 'original';
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
 * estimate from the same numbers (public/video-edit.js), so keep them in step.
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

// ---------- The temporary video of each user ----------

export const slotKey = (identity: Identity): string => (identity.role === 'master' ? 'master' : `g${identity.guestId}`);

export type TempState = 'uploading' | 'queued' | 'running' | 'done' | 'error';

/** What the pages are told. */
export interface TempVideo {
  state: TempState;
  percent: number;
  error?: string;
  kind: 'new' | 'replace';
  token?: string; // for "replace": the video being edited
  name: string; // the result's file name (a compressed video is always an mp4)
  sourceBytes: number;
  resultBytes?: number;
  contentType: string; // of the result
  reencoded: boolean;
}

interface Slot extends TempVideo {
  key: string;
  request: VideoRequest;
  sourcePath: string;
  allowedBytes: number | null; // the most the result may be (the free storage); null = no limit
  cancelled: boolean;
  proc?: ChildProcess;
  createdAt: number;
}

const slots = new Map<string, Slot>();
let queue: Promise<unknown> = Promise.resolve(); // one ffmpeg at a time, so the server stays responsive

const publicView = (slot: Slot): TempVideo => ({
  state: slot.state,
  percent: slot.percent,
  error: slot.error,
  kind: slot.kind,
  token: slot.token,
  name: slot.name,
  sourceBytes: slot.sourceBytes,
  resultBytes: slot.resultBytes,
  contentType: slot.contentType,
  reencoded: slot.reencoded,
});

export const getTemp = (key: string): TempVideo | null => {
  const slot = slots.get(key);
  return slot ? publicView(slot) : null;
};

/** Storage the temporary video takes up now, for the user's quota. */
export function reservedBytes(key: string): number {
  const slot = slots.get(key);
  if (!slot || slot.state === 'error') return 0;
  if (slot.state === 'done') return slot.resultBytes ?? 0;
  return slot.kind === 'new' ? slot.sourceBytes : 0;
}

/** Stops whatever is running and throws away the user's temporary video. */
export async function discardTemp(key: string): Promise<void> {
  const slot = slots.get(key);
  if (slot) {
    slot.cancelled = true;
    slot.proc?.kill('SIGKILL');
    slots.delete(key);
  }
  await rm(previewResultPath(key), { force: true });
  await rm(previewSourcePath(key), { force: true });
}

/** Discards temporary videos nobody came back for. */
export async function expireTemps(maxAgeMs: number): Promise<void> {
  const now = Date.now();
  for (const slot of [...slots.values()]) {
    if (now - slot.createdAt > maxAgeMs && slot.state !== 'running' && slot.state !== 'uploading') await discardTemp(slot.key);
  }
}

function newSlot(key: string, kind: 'new' | 'replace', name: string, contentType: string, request: VideoRequest, sourcePath: string, allowedBytes: number | null): Slot {
  const reencoded = request.preset !== 'original';
  const slot: Slot = {
    key,
    kind,
    request,
    sourcePath,
    allowedBytes,
    state: kind === 'new' ? 'uploading' : 'queued',
    percent: 0,
    // A compressed video is always an mp4, so its name has to say so.
    name: reencoded && !/\.mp4$/i.test(name) ? `${name.replace(/\.[^.]+$/, '')}.mp4` : name,
    sourceBytes: 0,
    contentType: reencoded ? 'video/mp4' : contentType,
    reencoded,
    cancelled: false,
    createdAt: Date.now(),
  };
  slots.set(key, slot);
  return slot;
}

/** The user is uploading a video to edit. The caller saves it to previewSourcePath(key), then calls sourceReceived. */
export function startUpload(key: string, name: string, contentType: string, request: VideoRequest, allowedBytes: number | null): { cancelled: () => boolean } {
  const slot = newSlot(key, 'new', name, contentType, request, previewSourcePath(key), allowedBytes);
  return { cancelled: () => slot.cancelled || slots.get(key) !== slot };
}

export function sourceReceived(key: string, bytes: number): void {
  const slot = slots.get(key);
  if (!slot) return;
  slot.sourceBytes = bytes;
  slot.state = 'queued';
  queue = queue.then(() => run(slot)).catch(() => {});
}

/** The user edits a video they already have. */
export async function startReplace(key: string, token: string, name: string, contentType: string, request: VideoRequest, allowedBytes: number | null, sourceBytes: number): Promise<void> {
  const slot = newSlot(key, 'replace', name, contentType, request, storedPath(token), allowedBytes);
  slot.token = token;
  slot.sourceBytes = sourceBytes;
  queue = queue.then(() => run(slot)).catch(() => {});
}

/** The finished result of a "new" video (to become the upload), or null if it is not ready. */
export function peekNewResult(key: string): { path: string; size: number; name: string } | null {
  const slot = slots.get(key);
  if (!slot || slot.kind !== 'new' || slot.state !== 'done') return null;
  return { path: previewResultPath(key), size: slot.resultBytes ?? 0, name: slot.name };
}

/** Forgets the temporary video once its file has been moved away (it became the upload). */
export function forgetTemp(key: string): void {
  slots.delete(key);
}

/** Makes the finished result replace the video being edited. Returns the new size and name. */
export async function keepReplace(key: string): Promise<{ token: string; size: number; name: string } | null> {
  const slot = slots.get(key);
  if (!slot || slot.kind !== 'replace' || slot.state !== 'done' || !slot.token) return null;
  const size = (await stat(previewResultPath(key))).size;
  await rename(previewResultPath(key), storedPath(slot.token));
  slots.delete(key);
  return { token: slot.token, size, name: slot.name };
}

async function run(slot: Slot): Promise<void> {
  if (slot.cancelled) return;
  slot.state = 'running';
  const output = previewResultPath(slot.key);
  const noRoom = () =>
    new Error(`Not enough storage left for the preview (${Math.floor(Math.max(0, slot.allowedBytes ?? 0) / 1024 / 1024)} MB free)`);
  try {
    const info = await probeVideo(slot.sourcePath);
    if (!info) throw new Error('Could not read the video');
    const start = slot.request.start;
    const end = Math.min(slot.request.end ?? info.seconds, info.seconds);
    if (end <= start) throw new Error('The start is past the end of the video');
    const clipSeconds = end - start;

    const args = ['-v', 'error', '-nostats', '-progress', 'pipe:1', '-y', '-ss', String(start)];
    if (slot.request.end !== null) args.push('-to', String(end));
    args.push('-i', slot.sourcePath);
    const settings = encodeSettings(slot.request, clipSeconds, info.kbps);
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
      const format = slot.contentType.split('/')[1];
      args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero');
      if (format === 'mp4') args.push('-movflags', '+faststart');
      args.push('-f', format);
    }
    args.push(output);

    let outOfRoom = false;
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      slot.proc = proc;
      let log = '';
      proc.stderr.on('data', (d) => (log = (log + d).slice(-1000)));
      proc.stdout.on('data', (d: Buffer) => {
        // ffmpeg reports "out_time_us=<microseconds done>" lines
        const match = /out_time_us=(\d+)/.exec(d.toString());
        if (match) slot.percent = Math.min(99, Math.floor((Number(match[1]) / 1e6 / clipSeconds) * 100));
        // Stop as soon as the result no longer fits in the user's storage.
        if (slot.allowedBytes !== null && !outOfRoom) {
          stat(output).then((s) => {
            if (s.size > slot.allowedBytes!) {
              outOfRoom = true;
              proc.kill('SIGKILL');
            }
          }, () => {});
        }
      });
      const timer = setTimeout(() => proc.kill('SIGKILL'), 2 * 60 * 60 * 1000);
      proc.on('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`ffmpeg could not run: ${e.message}`));
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (outOfRoom) reject(noRoom());
        else if (code === 0) resolve();
        else reject(new Error(slot.cancelled ? 'Cancelled' : `ffmpeg failed: ${log.trim() || `exit code ${code}`}`));
      });
    });

    const { size } = await stat(output);
    if (size === 0) throw new Error('The result is empty: check the start and end times');
    if (slot.allowedBytes !== null && size > slot.allowedBytes) throw noRoom();
    if (slot.cancelled) throw new Error('Cancelled');
    slot.resultBytes = size;
    slot.percent = 100;
    slot.state = 'done';
    // The original upload is no longer needed: only the result stays (and takes up space).
    if (slot.kind === 'new') await rm(slot.sourcePath, { force: true });
  } catch (e) {
    await rm(output, { force: true });
    if (slot.kind === 'new') await rm(slot.sourcePath, { force: true });
    if (slot.cancelled) return;
    slot.state = 'error';
    slot.error = e instanceof Error ? e.message : 'Could not process the video';
  } finally {
    slot.proc = undefined;
  }
}
