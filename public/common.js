// Helpers shared by the signed-in pages (loaded before their own script).

const $ = (id) => document.getElementById(id);

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

function fmtMinutes(minutes) {
  const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (minutes % 1440 === 0) return plural(minutes / 1440, 'day');
  if (minutes % 60 === 0) return plural(minutes / 60, 'hour');
  return plural(minutes, 'minute');
}

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

