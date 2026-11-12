const $ = (id) => document.getElementById(id);

// The session lives in an HttpOnly cookie; a 401 means it expired, so go back to the sign-in page.
async function api(method, path, body) {
  const headers = body ? { 'content-type': 'application/json' } : {};
  const res = await fetch('/api' + path, { method, headers, body: body && JSON.stringify(body) });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('Signed out');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'Request failed');
  return json;
}

// Tiny DOM builder. Children are appended as text nodes, so nothing here can inject markup.
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value);
  }
  el.append(...children.filter((c) => c != null && c !== false));
  return el;
}

const fmtDate = (d) => (d ? new Date(d).toLocaleString() : '-');
const fmtSize = (bytes) => (bytes / 1024 / 1024).toFixed(2) + ' MB';

async function run(action) {
  $('msg').textContent = '';
  try {
    await action();
  } catch (e) {
    $('msg').textContent = e.message;
  }
}

const button = (label, action, cls = '') => h('button', { class: cls, onclick: () => run(action) }, label);

// ---------- Sign out ----------

$('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login';
});

// ---------- Upload ----------

function showUploadResult(link, expiresAt) {
  const url = location.origin + link;
  const msg = $('uploadMsg');
  msg.className = 'ok';
  msg.replaceChildren(
    'Done. Download link: ',
    h('br'),
    h('a', { href: url }, url),
    expiresAt ? ` (deleted at ${fmtDate(expiresAt)})` : '',
  );
}

$('uploadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = $('file').files[0];
  const msg = $('uploadMsg');
  msg.className = '';
  msg.textContent = 'Uploading...';
  try {
    // Filename and password are URI-encoded so non-ASCII characters survive in headers.
    const res = await fetch('/api/files', {
      method: 'PUT',
      headers: {
        'x-download-password': encodeURIComponent($('dpw').value),
        'x-expires-minutes': $('exp').value,
        'x-filename': encodeURIComponent(file.name),
      },
      body: file,
    });
    if (res.status === 401) return (location.href = '/login');
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'Upload failed');
    showUploadResult(json.link, json.expiresAt);
    $('uploadForm').reset();
    await loadFiles();
  } catch (err) {
    msg.className = 'err';
    msg.textContent = err.message;
  }
});

// ---------- Files ----------

async function toggleDownloads(token, box) {
  if (!box.hidden) {
    box.hidden = true;
    return;
  }
  const downloads = await api('GET', `/files/${token}/downloads`);
  box.replaceChildren(
    ...(downloads.length
      ? downloads.map((d) => h('div', {}, `${fmtDate(d.downloadedAt)} - ${d.ip || 'unknown IP'}`))
      : [h('div', {}, 'No downloads yet.')]),
  );
  box.hidden = false;
}

function fileCard(file) {
  const link = `${location.origin}/d/${file.token}`;
  const expired = file.expiresAt && new Date(file.expiresAt) <= new Date();
  const log = h('div', { class: 'meta log' });
  log.hidden = true;

  const edit = async (changes) => {
    await api('PATCH', `/files/${file.token}`, changes);
    await loadFiles();
  };

  return h(
    'div',
    { class: 'card' },
    h('strong', {}, file.name),
    h('div', { class: 'meta' }, `Uploaded by ${file.uploader} on ${fmtDate(file.createdAt)} - ${fmtSize(file.size)}`),
    h('div', { class: 'meta' }, 'Expires: ' + (file.expiresAt ? fmtDate(file.expiresAt) + (expired ? ' (expired)' : '') : 'never')),
    h('div', { class: 'meta' }, h('a', { href: link }, link)),
    h(
      'div',
      { class: 'actions' },
      button(`Downloads (${file.downloads})`, () => toggleDownloads(file.token, log)),
      button('Rename', async () => {
        const name = prompt('New file name', file.name);
        if (name !== null) await edit({ name });
      }),
      button('Download password', async () => {
        const downloadPassword = prompt('New download password (min 4 characters)');
        if (downloadPassword !== null) await edit({ downloadPassword });
      }),
      button('Expiry', async () => {
        const answer = prompt('Delete after how many minutes from now? (0 = never)', '60');
        if (answer !== null && answer.trim() !== '') await edit({ expiresInMinutes: Number(answer) });
      }),
      button(
        'Delete',
        async () => {
          if (!confirm(`Delete "${file.name}"? This cannot be undone.`)) return;
          await api('DELETE', `/files/${file.token}`);
          await loadFiles();
        },
        'danger',
      ),
    ),
    log,
  );
}

async function loadFiles() {
  const files = await api('GET', '/files');
  $('files').replaceChildren(...(files.length ? files.map(fileCard) : [h('p', {}, 'No files yet.')]));
}

// ---------- Guests (master only: these elements exist only on the admin page) ----------

function guestCard(guest) {
  return h(
    'div',
    { class: 'card' },
    h('strong', {}, guest.name),
    h('div', { class: 'meta' }, `Created ${fmtDate(guest.createdAt)}`),
    h(
      'div',
      { class: 'actions' },
      button('Reset password', async () => {
        const password = prompt(`New password for ${guest.name} (min 4 characters)`);
        if (password !== null) await api('PATCH', `/guests/${guest.id}`, { password });
      }),
      button(
        'Delete',
        async () => {
          if (!confirm(`Delete guest "${guest.name}"? Their uploaded files are kept.`)) return;
          await api('DELETE', `/guests/${guest.id}`);
          await loadGuests();
        },
        'danger',
      ),
    ),
  );
}

async function loadGuests() {
  const guests = await api('GET', '/guests');
  $('guests').replaceChildren(...(guests.length ? guests.map(guestCard) : [h('p', {}, 'No guests yet.')]));
}

if ($('guestForm')) {
  $('guestForm').addEventListener('submit', (e) => {
    e.preventDefault();
    run(async () => {
      await api('POST', '/guests', { name: $('gname').value, password: $('gpw').value });
      $('gname').value = '';
      $('gpw').value = '';
      await loadGuests();
    });
  });
  run(loadGuests);
}

run(loadFiles);
