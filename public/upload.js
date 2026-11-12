const PRESETS = [10, 60, 1440, 10080, 43200]; // minutes

let limits = null;

// Offers only lifetimes the user is allowed. When a maximum is set, "never" is not offered.
function fillExpiryOptions() {
  const max = limits.maxExpiryMinutes;
  const minutes = PRESETS.filter((m) => max === null || m <= max);
  if (max !== null && !minutes.includes(max)) minutes.push(max);
  minutes.sort((a, b) => a - b);

  const options = minutes.map((m) => [m, fmtMinutes(m)]);
  if (max === null) options.unshift([0, 'Never (permanent)']);
  $('exp').replaceChildren(...options.map(([value, label]) => h('option', { value }, label)));
}

// Refreshes the "storage used" figures, e.g. after an upload or after a video was made smaller.
async function refreshLimits() {
  limits = await api('GET', '/limits').catch(() => limits);
  showLimits();
}

function showLimits() {
  const maxMb = Math.floor(limits.maxSizeBytes / 1024 / 1024);
  $('limits').textContent = limits.sizeLimited
    ? `Maximum file size: ${maxMb} MB.`
    : `Maximum file size: ${maxMb} MB (the server maximum).`;
  if (limits.maxExpiryMinutes !== null) {
    $('limits').textContent += ` Files are deleted after at most ${fmtMinutes(limits.maxExpiryMinutes)}.`;
  }
  if (limits.maxTotalBytes !== null) {
    $('limits').textContent += ` Storage used: ${fmtSize(limits.usedBytes)} of ${fmtSize(limits.maxTotalBytes)}.`;
  }
}

// Without a password the field is disabled and not required.
function syncPasswordField() {
  $('dpw').disabled = $('nopw').checked;
  $('dpw').required = !$('nopw').checked;
}
$('nopw').addEventListener('change', syncPasswordField);

function showResult(link, expiresAt) {
  const url = location.origin + link;
  $('msg').className = 'ok';
  $('msg').replaceChildren(
    'Done. Download link: ',
    h('br'),
    h('a', { href: url }, url),
    expiresAt ? ` (deleted at ${fmtDate(expiresAt)})` : '',
  );
}

function showError(message) {
  $('msg').className = 'err';
  $('msg').textContent = message;
}

// Shows the chosen file (image, video or text) before it is uploaded. Nothing is sent anywhere.
const PREVIEW_TEXT = /\.(txt|md|log|csv|tsv|json|xml|ya?ml|ini|conf|toml|m?js|ts|py|sh|bat|css|java|c|h|cpp|go|rs|rb|php|sql)$/i;
const PREVIEW_TEXT_LIMIT = 256 * 1024;
let previewUrl = null;
let videoUi = null; // cut / quality fields, for a chosen video

async function showPreview() {
  const box = $('preview');
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  box.replaceChildren();
  box.hidden = true;
  videoUi = null;

  const file = $('file').files[0];
  if (!file) return;
  if (/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(file.type)) {
    previewUrl = URL.createObjectURL(file);
    box.append(h('img', { src: previewUrl, alt: '' }));
  } else if (/^video\/(mp4|webm|ogg)$/.test(file.type)) {
    previewUrl = URL.createObjectURL(file);
    const video = h('video', { src: previewUrl });
    video.controls = true;
    box.append(video);
    if (limits?.canEditVideo) {
      videoUi = videoOptions(video, file.size, limits.videoPresets);
      box.append(videoUi.el);
    }
  } else if (PREVIEW_TEXT.test(file.name)) {
    const text = await file.slice(0, PREVIEW_TEXT_LIMIT).text();
    if ($('file').files[0] !== file) return; // another file was picked meanwhile
    box.append(h('pre', {}, text));
  } else {
    return;
  }
  box.hidden = false;
}
$('file').addEventListener('change', () => showPreview().catch(() => {}));

let currentUpload = null; // the request in flight, so it can be cancelled

// Sends the file as the raw request body and shows progress while it goes up.
function sendFile(file, headers) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    currentUpload = xhr;
    xhr.open('PUT', '/api/files');
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const percent = Math.floor((e.loaded / e.total) * 100);
      $('bar').value = percent;
      $('msg').textContent =
        e.loaded === e.total
          ? 'Finishing...'
          : `Uploading... ${percent}% (${fmtSize(e.loaded)} of ${fmtSize(e.total)})`;
    };
    xhr.onload = () => {
      let json = {};
      try {
        json = JSON.parse(xhr.responseText);
      } catch {}
      resolve({ status: xhr.status, json });
    };
    xhr.onabort = () => reject(new Error('Upload cancelled'));
    xhr.onerror = () => reject(new Error('Upload failed (connection lost)'));
    xhr.send(file);
  });
}

$('uploadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = $('file').files[0];
  if (!limits) return showError('Still loading your limits, try again in a moment.');
  if (limits.maxTotalBytes !== null && file.size > limits.maxTotalBytes - limits.usedBytes) {
    return showError(`Not enough storage left (${fmtSize(Math.max(0, limits.maxTotalBytes - limits.usedBytes))} free)`);
  }
  if (file.size > limits.maxSizeBytes) {
    return showError(`File too large (maximum ${Math.floor(limits.maxSizeBytes / 1024 / 1024)} MB)`);
  }

  // Optional: cut and/or compress a video. It is uploaded as it is, then edited on the server.
  let request = null;
  if (videoUi) {
    try {
      request = videoUi.read();
    } catch (err) {
      return showError(err.message);
    }
  }
  $('review').replaceChildren();

  $('msg').className = '';
  $('msg').textContent = 'Uploading... 0%';
  $('go').disabled = true;
  $('bar').value = 0;
  $('bar').hidden = false;
  $('cancel').hidden = false;
  try {
    // XMLHttpRequest, because fetch cannot report upload progress.
    // Filename and password are URI-encoded so non-ASCII characters survive in headers.
    const { status, json } = await sendFile(file, {
      'x-download-password': encodeURIComponent($('dpw').value),
      'x-no-password': $('nopw').checked ? '1' : '0',
      'x-expires-minutes': $('exp').value,
      'x-filename': encodeURIComponent(file.name),
    });
    if (status === 401) return (location.href = '/login');
    if (status < 200 || status >= 300) throw new Error(json.error || 'Upload failed');
    showResult(json.link, json.expiresAt);
    // The video was uploaded as it is; now make the cut/compressed version and let the user look at it.
    if (request) {
      $('review').replaceChildren(videoReview(json.link.split('/').pop(), request, refreshLimits));
    }
    $('uploadForm').reset();
    syncPasswordField();
    showPreview();
    await refreshLimits();
  } catch (err) {
    showError(err.message);
  } finally {
    $('go').disabled = false;
    $('bar').hidden = true;
    $('cancel').hidden = true;
    currentUpload = null;
  }
});

// The server throws away the partly received file when the connection closes.
$('cancel').addEventListener('click', () => currentUpload?.abort());

api('GET', '/limits')
  .then((result) => {
    limits = result;
    showLimits();
    fillExpiryOptions();
  })
  .catch((e) => showError(e.message));
