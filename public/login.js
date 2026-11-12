const $ = (id) => document.getElementById(id);

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('msg').textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: $('name').value, password: $('pw').value }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'Sign in failed');
    location.href = json.redirect;
  } catch (err) {
    $('msg').textContent = err.message;
  }
});
