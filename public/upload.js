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

function showLimits() {
  const maxMb = Math.floor(limits.maxSizeBytes / 1024 / 1024);
  $('limits').textContent = limits.sizeLimited
    ? `Maximum file size: ${maxMb} MB.`
    : `No size limit for you (the server maximum is ${maxMb} MB).`;
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

  $('msg').className = '';
  $('msg').textContent = 'Uploading...';
  try {
    // Filename and password are URI-encoded so non-ASCII characters survive in headers.
    const res = await fetch('/api/files', {
      method: 'PUT',
      headers: {
        'x-download-password': encodeURIComponent($('dpw').value),
        'x-no-password': $('nopw').checked ? '1' : '0',
        'x-expires-minutes': $('exp').value,
        'x-filename': encodeURIComponent(file.name),
      },
      body: file,
    });
    if (res.status === 401) return (location.href = '/login');
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'Upload failed');
    showResult(json.link, json.expiresAt);
    $('uploadForm').reset();
    syncPasswordField();
    // Refresh the "files used" count.
    limits = await api('GET', '/limits').catch(() => limits);
    showLimits();
  } catch (err) {
    showError(err.message);
  }
});

api('GET', '/limits')
  .then((result) => {
    limits = result;
    showLimits();
    fillExpiryOptions();
  })
  .catch((e) => showError(e.message));
