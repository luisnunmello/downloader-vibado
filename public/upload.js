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
let tempExists = false; // the server holds a temporary video of this user (being made, or ready)
let tempReady = false; // ...and it is finished, so Upload will use it

async function showPreview() {
  await discardTemp(); // a preview made for another file or other options no longer applies
  $('previewBtn').hidden = true;
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
      videoUi = videoOptions(video, file.size, limits.videoPresets, discardTemp);
      box.append(videoUi.el);
      $('previewBtn').hidden = false;
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
function sendFile(url, file, headers, label) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    currentUpload = xhr;
    xhr.open('PUT', url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const percent = Math.floor((e.loaded / e.total) * 100);
      $('bar').value = percent;
      $('msg').textContent =
        e.loaded === e.total
          ? 'Finishing...'
          : `${label}... ${percent}% (${fmtSize(e.loaded)} of ${fmtSize(e.total)})`;
    };
    xhr.onload = () => {
      let json = {};
      try {
        json = JSON.parse(xhr.responseText);
      } catch {}
      resolve({ status: xhr.status, json });
    };
    xhr.onabort = () => reject(new Error('Cancelled'));
    xhr.onerror = () => reject(new Error('Upload failed (connection lost)'));
    xhr.send(file);
  });
}

// Shows progress and the Cancel button while a file is going up.
function busy(on) {
  $('go').disabled = on;
  $('previewBtn').disabled = on;
  $('bar').hidden = !on;
  $('cancel').hidden = !on;
  if (on) $('bar').value = 0;
  else currentUpload = null;
}

// Throws away the temporary video on the server, when what it was made from changes.
async function discardTemp() {
  if (!tempExists) return;
  tempExists = false;
  tempReady = false;
  $('result').replaceChildren();
  await api('DELETE', '/video-preview').catch(() => {});
  await refreshLimits();
}

// Checks the file against what the user may store, like an upload would.
function fitsLimits(file) {
  if (limits.maxTotalBytes !== null && file.size > limits.maxTotalBytes - limits.usedBytes) {
    showError(`Not enough storage left (${fmtSize(Math.max(0, limits.maxTotalBytes - limits.usedBytes))} free)`);
    return false;
  }
  if (file.size > limits.maxSizeBytes) {
    showError(`File too large (maximum ${Math.floor(limits.maxSizeBytes / 1024 / 1024)} MB)`);
    return false;
  }
  return true;
}

// "Preview the result": the video goes to a temporary file on the server, is cut and compressed there,
// and the result is shown. Upload then uses that result instead of sending the file again.
$('previewBtn').addEventListener('click', async () => {
  const file = $('file').files[0];
  if (!file || !limits) return;
  let request;
  try {
    request = videoUi.read();
  } catch (err) {
    return showError(err.message);
  }
  if (!request) return showError('Set a start or end time, or pick a lower quality, first.');
  await discardTemp();
  await refreshLimits(); // the old preview's space is free again
  if (!fitsLimits(file)) return;

  $('msg').className = '';
  $('msg').textContent = 'Sending the video... 0%';
  busy(true);
  tempExists = true;
  try {
    const { status, json } = await sendFile(
      '/api/video-preview',
      file,
      {
        'x-filename': encodeURIComponent(file.name),
        'x-start': request.start ?? '',
        'x-end': request.end ?? '',
        'x-preset': request.preset,
        'x-target-mb': request.targetMb ?? '',
      },
      'Sending the video',
    );
    if (status === 401) return (location.href = '/login');
    if (status < 200 || status >= 300) throw new Error(json.error || 'Could not make the preview');
    $('msg').textContent = '';
    watchTemp(
      $('result'),
      (job) => {
        tempReady = true;
        $('result').replaceChildren(
          ...tempResult(job),
          h('div', { class: 'meta' }, 'Happy with it? Fill in the details below and press Upload to publish this version.'),
        );
        refreshLimits();
      },
      () => {
        tempExists = false;
        refreshLimits();
      },
    );
    await refreshLimits();
  } catch (err) {
    tempExists = false;
    showError(err.message);
  } finally {
    busy(false);
  }
});

$('uploadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = $('file').files[0];
  if (!limits) return showError('Still loading your limits, try again in a moment.');

  // A finished preview is what gets uploaded: nothing is sent again.
  if (tempReady) return publishPreview();
  if (tempExists) return showError('The preview is still being made. Wait for it to finish, or change the options to start over.');

  // Cut / quality options are only applied through a preview, so what is uploaded is what was shown.
  if (videoUi) {
    let request;
    try {
      request = videoUi.read();
    } catch (err) {
      return showError(err.message);
    }
    if (request) {
      return showError('You set cut or quality options: press "Preview the result" first, or clear them to upload the video as it is.');
    }
  }
  if (!fitsLimits(file)) return;

  $('msg').className = '';
  $('msg').textContent = 'Uploading... 0%';
  busy(true);
  try {
    // XMLHttpRequest, because fetch cannot report upload progress.
    // Filename, title and password are URI-encoded so non-ASCII characters survive in headers.
    const { status, json } = await sendFile(
      '/api/files',
      file,
      {
        'x-download-password': encodeURIComponent($('dpw').value),
        'x-no-password': $('nopw').checked ? '1' : '0',
        'x-expires-minutes': $('exp').value,
        'x-filename': encodeURIComponent(file.name),
        'x-title': encodeURIComponent($('title').value),
      },
      'Uploading',
    );
    if (status === 401) return (location.href = '/login');
    if (status < 200 || status >= 300) throw new Error(json.error || 'Upload failed');
    finished(json);
  } catch (err) {
    showError(err.message);
  } finally {
    busy(false);
  }
});

// Publishes the finished temporary video as the upload.
async function publishPreview() {
  $('go').disabled = true;
  try {
    const json = await api('POST', '/video-preview/publish', {
      title: $('title').value,
      downloadPassword: $('dpw').value,
      noPassword: $('nopw').checked,
      expiresInMinutes: Number($('exp').value),
    });
    tempExists = false;
    tempReady = false;
    finished(json);
  } catch (err) {
    showError(err.message);
  } finally {
    $('go').disabled = false;
  }
}

// After an upload: show the link and clear the form.
function finished(json) {
  showResult(json.link, json.expiresAt);
  $('uploadForm').reset();
  syncPasswordField();
  $('result').replaceChildren();
  showPreview();
  refreshLimits();
}

// The server throws away the partly received file when the connection closes.
$('cancel').addEventListener('click', () => currentUpload?.abort());

api('GET', '/limits')
  .then((result) => {
    limits = result;
    showLimits();
    fillExpiryOptions();
  })
  .catch((e) => showError(e.message));
