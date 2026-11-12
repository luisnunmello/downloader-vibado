async function run(action) {
  $('msg').textContent = '';
  try {
    await action();
  } catch (e) {
    $('msg').textContent = e.message;
  }
}

const button = (label, action, cls = '') => h('button', { class: cls, onclick: () => run(action) }, label);

// Empty input = no value; used to clear a limit.
const numberOrNull = (text) => (text.trim() === '' ? null : Number(text));

// ---------- Sign out ----------

$('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login';
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
  const size = guest.maxSizeMb === null ? 'default' : `${guest.maxSizeMb} MB`;
  const expiry = guest.maxExpiryMinutes === null ? 'no limit' : fmtMinutes(guest.maxExpiryMinutes);

  return h(
    'div',
    { class: 'card' },
    h('strong', {}, guest.name),
    h('div', { class: 'meta' }, `Created ${fmtDate(guest.createdAt)}`),
    h('div', { class: 'meta' }, `Max file size: ${size} - Max expiry: ${expiry}`),
    h(
      'div',
      { class: 'actions' },
      button('Limits', async () => {
        const sizeAnswer = prompt('Max file size in MB (1-1000). Leave empty for the server default.', guest.maxSizeMb ?? '');
        if (sizeAnswer === null) return;
        const expiryAnswer = prompt('Max expiry in minutes. Leave empty for no limit.', guest.maxExpiryMinutes ?? '');
        if (expiryAnswer === null) return;
        await api('PATCH', `/guests/${guest.id}`, {
          maxSizeMb: numberOrNull(sizeAnswer),
          maxExpiryMinutes: numberOrNull(expiryAnswer),
        });
        await loadGuests();
      }),
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
      await api('POST', '/guests', {
        name: $('gname').value,
        password: $('gpw').value,
        maxSizeMb: numberOrNull($('gsize').value),
        maxExpiryMinutes: numberOrNull($('gexp').value),
      });
      $('guestForm').reset();
      await loadGuests();
    });
  });
  run(loadGuests);
}

run(loadFiles);
