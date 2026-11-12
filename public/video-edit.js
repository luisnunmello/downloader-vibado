// Cutting and compressing videos. Shared by the upload page and the file list (after common.js).
//   videoOptions(video, sourceBytes, presets, onChange)   the cut / quality fields, with a size estimate
//   watchTemp(box, onDone, onFailed)                      follows the user's temporary video on the server
//   tempResult(job)                                       the finished result: its sizes and a player

const isVideoName = (name) => /\.(mp4|m4v|webm|ogv)$/i.test(name);

const SIZE_PRESET = 'size'; // "pick a target size"

// The size the server will roughly produce. Same numbers as encodeSettings in src/video.ts.
function estimateBytes(request, seconds, sourceBytes, presets) {
  const start = Number(request.start || 0);
  const end = request.end === '' ? seconds : Math.min(Number(request.end), seconds);
  const clip = end - start;
  if (!(seconds > 0) || !(clip > 0)) return null;
  const share = (sourceBytes * clip) / seconds; // the same part of the original, untouched
  if (request.preset === 'original') return share;
  if (request.preset === SIZE_PRESET) {
    const target = Number(request.targetMb) * 1024 * 1024;
    return target > 0 ? Math.min(target, share) : null;
  }
  const preset = presets.find((p) => p.id === request.preset);
  const sourceKbps = (sourceBytes * 8) / 1000 / seconds;
  const videoKbps = Math.min(preset.videoKbps, Math.max(100, Math.floor(sourceKbps) - preset.audioKbps));
  return Math.min(((videoKbps + preset.audioKbps) * 1000 * clip) / 8, share);
}

/**
 * Fields for editing a video: start and end (seconds, empty = whole video), the quality, and a live
 * estimate of the size. `video` is the <video> element showing the file. `read()` gives the request for
 * the server, null if nothing is set, and throws if something is invalid. `onChange` runs when the user
 * changes a field.
 */
function videoOptions(video, sourceBytes, presets, onChange) {
  const seconds = (value) => String(Math.round(value * 100) / 100);
  const start = h('input', { type: 'number', min: '0', step: 'any', placeholder: 'Start (seconds)' });
  const end = h('input', { type: 'number', min: '0', step: 'any', placeholder: 'End (seconds)' });
  const quality = h(
    'select',
    {},
    ...presets.map((p) => h('option', { value: p.id }, p.label)),
    h('option', { value: SIZE_PRESET }, 'Pick a target size...'),
  );
  const target = h('input', { type: 'number', min: '1', step: '1', placeholder: 'Target size (MB)' });
  target.hidden = true;
  const estimate = h('div', { class: 'meta' });

  const current = () => ({ start: start.value.trim(), end: end.value.trim(), preset: quality.value, targetMb: target.value.trim() });

  function refresh() {
    target.hidden = quality.value !== SIZE_PRESET;
    const request = current();
    if (!(video.duration > 0)) {
      estimate.textContent = 'Loading the video...';
      return;
    }
    const bytes = estimateBytes(request, video.duration, sourceBytes, presets);
    if (bytes === null) {
      estimate.textContent = quality.value === SIZE_PRESET ? 'Enter a target size and a valid start and end.' : 'Check the start and end times.';
      return;
    }
    const change = Math.round((1 - bytes / sourceBytes) * 100);
    estimate.textContent =
      `Estimated size: about ${fmtSize(bytes)} (now ${fmtSize(sourceBytes)}` +
      (change > 0 ? `, ${change}% smaller` : '') +
      '). The real size is shown when the preview is ready.';
  }
  const changed = () => {
    refresh();
    onChange?.();
  };
  for (const el of [start, end, quality, target]) el.addEventListener('input', changed);
  video.addEventListener('loadedmetadata', refresh);
  refresh();

  // Plays only the chosen part in the player. It is the original video, so it only shows where the cut
  // falls; the quality is shown by the preview of the finished result.
  let watching = null;
  const stopWatching = () => {
    if (watching) video.removeEventListener('timeupdate', watching);
    watching = null;
  };
  const playCut = () => {
    stopWatching();
    const from = Number(start.value || 0);
    const to = end.value.trim() === '' ? Infinity : Number(end.value);
    video.currentTime = from;
    watching = () => {
      if (video.currentTime >= to) {
        video.pause();
        stopWatching();
      }
    };
    video.addEventListener('timeupdate', watching);
    video.play();
  };

  const take = (input, label) =>
    h('button', { type: 'button', class: 'secondary', onclick: () => {
      input.value = seconds(video.currentTime);
      changed();
    } }, label);

  return {
    el: h(
      'div',
      { class: 'cut' },
      h('div', { class: 'meta' }, 'Cut: play to the right spot, then use the buttons. Leave empty to keep the whole video.'),
      h('div', { class: 'row' }, start, take(start, 'Start = current time')),
      h('div', { class: 'row' }, end, take(end, 'End = current time')),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'secondary', onclick: playCut }, 'Play the cut')),
      h('div', { class: 'meta' }, 'Quality: lower quality makes a smaller file.'),
      h('div', { class: 'row' }, quality, target),
      estimate,
    ),
    read() {
      const request = current();
      if (request.end !== '' && Number(request.end) <= Number(request.start || 0)) throw new Error('The end must be after the start');
      if (request.preset === SIZE_PRESET && !(Number(request.targetMb) >= 1)) throw new Error('Enter a target size in MB');
      if (request.preset === 'original' && request.start === '' && request.end === '') return null; // nothing to do
      return {
        start: request.start === '' ? null : Number(request.start),
        end: request.end === '' ? null : Number(request.end),
        preset: request.preset,
        targetMb: request.preset === SIZE_PRESET ? Number(request.targetMb) : null,
      };
    },
  };
}

/**
 * Follows the user's temporary video on the server, showing progress in `box`. Calls `onDone(job)` when
 * the result is ready (the caller then fills the box), or `onFailed()` after showing the error.
 */
function watchTemp(box, onDone, onFailed) {
  const status = h('div', { class: 'meta' }, 'Working...');
  const bar = h('progress', { max: '100', value: '0' });
  box.replaceChildren(status, bar);

  (async () => {
    while (box.contains(status)) {
      let job;
      try {
        job = await api('GET', '/video-preview');
      } catch (e) {
        box.replaceChildren(h('div', { class: 'err' }, e.message));
        return onFailed?.();
      }
      if (!box.contains(status)) return; // replaced by something newer meanwhile
      if (job.state === 'error') {
        box.replaceChildren(h('div', { class: 'err' }, `Failed: ${job.error}`));
        return onFailed?.();
      }
      if (job.state === 'none') return box.replaceChildren(); // discarded meanwhile
      if (job.state === 'done') return onDone(job);
      bar.value = job.percent;
      status.textContent =
        job.state === 'uploading' ? 'Receiving the video...' : job.state === 'queued' ? 'Waiting for other video jobs...' : `Processing... ${job.percent}%`;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  })();
}

/** The finished result: its real size compared with the original, and a player. */
function tempResult(job) {
  const change = job.sourceBytes ? Math.round((1 - job.resultBytes / job.sourceBytes) * 100) : 0;
  const video = h('video', { src: `/api/video-preview/video?t=${Date.now()}`, preload: 'metadata' });
  video.controls = true;
  return [
    h(
      'div',
      { class: 'meta' },
      `Preview: ${fmtSize(job.resultBytes)} (original ${fmtSize(job.sourceBytes)}, ` +
        (change >= 0 ? `${change}% smaller` : `${-change}% bigger`) + `). File name: ${job.name}`,
    ),
    video,
  ];
}
