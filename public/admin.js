const $ = (id) => document.getElementById(id);

// The master password is kept only in memory and sent with every request; reloading signs out.
let password = '';

async function api(method, path, body) {
  const headers = { 'x-password': encodeURIComponent(password) };
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch('/api/admin' + path, { method, headers, body: body && JSON.stringify(body) });
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

  const edit = (changes) => async () => {
    await api('PATCH', `/files/${file.token}`, changes());
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
        if (name === null) return;
        await edit(() => ({ name }))();
      }),
      button('Download password', async () => {
        const downloadPassword = prompt('New download password (min 4 characters)');
        if (downloadPassword === null) return;
        await edit(() => ({ downloadPassword }))();
      }),
      button('Expiry', async () => {
        const answer = prompt('Delete after how many minutes from now? (0 = never)', '60');
        if (answer === null || answer.trim() === '') return;
        await edit(() => ({ expiresInMinutes: Number(answer) }))();
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

// ---------- Guests ----------

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
        const newPassword = prompt(`New password for ${guest.name} (min 4 characters)`);
        if (newPassword === null) return;
        await api('PATCH', `/guests/${guest.id}`, { password: newPassword });
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

$('guestForm').addEventListener('submit', (e) => {
  e.preventDefault();
  run(async () => {
    await api('POST', '/guests', { name: $('gname').value, password: $('gpw').value });
    $('gname').value = '';
    $('gpw').value = '';
    await loadGuests();
  });
});

// ---------- Sign in ----------

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  password = $('pw').value;
  $('loginMsg').textContent = '';
  try {
    await Promise.all([loadFiles(), loadGuests()]);
    $('pw').value = '';
    $('login').hidden = true;
    $('panel').hidden = false;
  } catch (err) {
    password = '';
    $('loginMsg').textContent = err.message;
  }
});
