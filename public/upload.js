const $ = (id) => document.getElementById(id);

function showError(message) {
  $('msg').className = 'err';
  $('msg').textContent = message;
}

function showLink(link, expiresAt) {
  const url = location.origin + link;
  const a = document.createElement('a');
  a.href = url;
  a.textContent = url;

  const msg = $('msg');
  msg.className = 'ok';
  msg.textContent = 'Done. Download link: ';
  msg.appendChild(document.createElement('br'));
  msg.appendChild(a);
  if (expiresAt) {
    msg.appendChild(document.createTextNode(` (deleted at ${new Date(expiresAt).toLocaleString()})`));
  }
}

$('go').onclick = async () => {
  const file = $('file').files[0];
  if (!file) return showError('Choose a file.');

  $('msg').className = '';
  $('msg').textContent = 'Uploading...';
  try {
    // Passwords and filename are URI-encoded so non-ASCII characters survive in headers.
    const res = await fetch('/api/upload', {
      method: 'PUT',
      headers: {
        'x-guest-name': encodeURIComponent($('guest').value),
        'x-password': encodeURIComponent($('pw').value),
        'x-download-password': encodeURIComponent($('dpw').value),
        'x-expires-minutes': $('exp').value,
        'x-filename': encodeURIComponent(file.name),
      },
      body: file,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Upload failed');
    showLink(json.link, json.expiresAt);
  } catch (e) {
    showError(e.message);
  }
};
