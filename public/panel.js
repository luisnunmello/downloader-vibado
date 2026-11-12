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

// Max-expiry input: a list of common choices, or a custom amount with a unit.
const EXPIRY_PRESETS = [10, 60, 1440, 10080, 43200]; // minutes

function expiryPicker(current) {
  const select = h(
    'select',
    {},
    h('option', { value: 'none' }, 'No expiry limit'),
    ...EXPIRY_PRESETS.map((m) => h('option', { value: String(m) }, fmtMinutes(m))),
    h('option', { value: 'custom' }, 'Custom...'),
  );
  const amount = h('input', { type: 'number', min: '1', step: 'any', placeholder: 'Amount' });
  const unit = h(
    'select',
    {},
    h('option', { value: '1' }, 'minutes'),
    h('option', { value: '60' }, 'hours'),
    h('option', { value: '1440' }, 'days'),
  );
  const custom = h('span', { class: 'picker' }, amount, unit);
  const sync = () => (custom.hidden = select.value !== 'custom');
  select.addEventListener('change', sync);

  if (current === null) {
    select.value = 'none';
  } else if (EXPIRY_PRESETS.includes(current)) {
    select.value = String(current);
  } else {
    select.value = 'custom';
    unit.value = current % 1440 === 0 ? '1440' : current % 60 === 0 ? '60' : '1';
    amount.value = String(current / Number(unit.value));
  }
  sync();

  return {
    el: h('span', { class: 'picker' }, select, custom),
    /** Minutes, or null for no limit. Throws if the custom value is not a whole number of minutes. */
    value() {
      if (select.value === 'none') return null;
      if (select.value !== 'custom') return Number(select.value);
      const minutes = Number(amount.value) * Number(unit.value);
      if (!Number.isInteger(minutes) || minutes < 1) throw new Error('Enter a valid custom expiry');
      return minutes;
    },
  };
}

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
    h('div', { class: 'meta' }, 'Download: ' + (file.passwordless ? 'no password, anyone with the link' : 'password protected')),
    h('div', { class: 'meta' }, h('a', { href: link }, link)),
    h(
      'div',
      { class: 'actions' },
      button(`Downloads (${file.downloads})`, () => toggleDownloads(file.token, log)),
      button('Rename', async () => {
        const name = prompt('New file name', file.name);
        if (name !== null) await edit({ name });
      }),
      button(file.passwordless ? 'Set password' : 'Change password', async () => {
        const downloadPassword = prompt('New download password');
        if (downloadPassword !== null) await edit({ downloadPassword });
      }),
      !file.passwordless &&
        button('Remove password', async () => {
          if (!confirm(`Remove the password from "${file.name}"? Anyone with the link will be able to download it.`)) return;
          await edit({ downloadPassword: null });
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
  const storage =
    guest.maxTotalMb === null
      ? `${fmtSize(guest.usedBytes)} used, no limit`
      : `${fmtSize(guest.usedBytes)} of ${guest.maxTotalMb} MB used`;

  const sizeInput = h('input', {
    type: 'number',
    min: '1',
    step: '1',
    placeholder: 'Max file size (MB, empty = default)',
    value: guest.maxSizeMb ?? '',
  });
  const totalInput = h('input', {
    type: 'number',
    min: '1',
    step: '1',
    placeholder: 'Total storage (MB, empty = no limit)',
    value: guest.maxTotalMb ?? '',
  });
  const picker = expiryPicker(guest.maxExpiryMinutes);
  const editor = h(
    'div',
    { class: 'editor row' },
    sizeInput,
    totalInput,
    h('div', { class: 'field' }, h('span', { class: 'meta' }, 'Max expiry'), picker.el),
    button('Save', async () => {
      await api('PATCH', `/guests/${guest.id}`, {
        maxSizeMb: numberOrNull(sizeInput.value),
        maxExpiryMinutes: picker.value(),
        maxTotalMb: numberOrNull(totalInput.value),
      });
      await loadGuests();
    }),
  );
  editor.hidden = true;

  return h(
    'div',
    { class: 'card' },
    h('strong', {}, guest.name),
    h('div', { class: 'meta' }, `Created ${fmtDate(guest.createdAt)}`),
    h('div', { class: 'meta' }, `Max file size: ${size} - Max expiry: ${expiry}`),
    h('div', { class: 'meta' }, `Storage: ${storage}`),
    h(
      'div',
      { class: 'actions' },
      button('Limits', async () => (editor.hidden = !editor.hidden)),
      button('Reset password', async () => {
        const password = prompt(`New password for ${guest.name}`);
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
    editor,
  );
}

async function loadGuests() {
  const guests = await api('GET', '/guests');
  $('guests').replaceChildren(...(guests.length ? guests.map(guestCard) : [h('p', {}, 'No guests yet.')]));
}

if ($('settingsForm')) {
  const showSettings = (s) => {
    $('smax').value = s.maxSizeMb;
    $('smax').max = s.hardMaxSizeMb;
    if (!s.storage) return;
    const { disk, filesBytes, databaseBytes } = s.storage;
    const parts = [];
    if (disk) parts.push(`Server disk: ${fmtSize(disk.freeBytes)} free of ${fmtSize(disk.totalBytes)}`);
    parts.push(`files stored: ${fmtSize(filesBytes)}`, `database size: ${fmtSize(databaseBytes)}`);
    $('space').textContent = parts.join(' - ');
  };
  $('settingsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    run(async () => {
      showSettings(await api('PATCH', '/settings', { maxSizeMb: Number($('smax').value) }));
      $('msg').textContent = 'Saved.';
    });
  });
  run(async () => showSettings(await api('GET', '/settings')));
}

if ($('guestForm')) {
  let createPicker = expiryPicker(null);
  $('gexpBox').append(createPicker.el);

  $('guestForm').addEventListener('submit', (e) => {
    e.preventDefault();
    run(async () => {
      await api('POST', '/guests', {
        name: $('gname').value,
        password: $('gpw').value,
        maxSizeMb: numberOrNull($('gsize').value),
        maxExpiryMinutes: createPicker.value(),
        maxTotalMb: numberOrNull($('gtotal').value),
      });
      $('guestForm').reset();
      // reset() restores the picker's selects, but its custom fields must re-hide too.
      createPicker = expiryPicker(null);
      $('gexpBox').replaceChildren(createPicker.el);
      await loadGuests();
    });
  });
  run(loadGuests);
}

run(loadFiles);
