import fs from 'fs';
import path from 'path';
import { VIEWS_DIR } from './config.js';

type Vars = Record<string, string | number | undefined>;

const templates = new Map<string, string>();

function load(name: string): string {
  let tpl = templates.get(name);
  if (tpl === undefined) {
    tpl = fs.readFileSync(path.join(VIEWS_DIR, `${name}.html`), 'utf8');
    templates.set(name, tpl);
  }
  return tpl;
}

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Minimal templating:
 *   {{name}}                    HTML-escaped value
 *   {{{name}}}                  raw value (only for trusted HTML)
 *   {{#if name}}...{{/if}}      block kept when the value is non-empty
 * Substituted values are never re-scanned, so user data cannot inject markup or tags.
 */
function interpolate(tpl: string, vars: Vars): string {
  return tpl
    .replace(/\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_m, key: string, inner: string) => (vars[key] ? inner : ''))
    .replace(/\{\{\{(\w+)\}\}\}|\{\{(\w+)\}\}/g, (_m, raw?: string, escaped?: string) => {
      const value = String(vars[(raw ?? escaped)!] ?? '');
      return raw ? value : escapeHtml(value);
    });
}

/**
 * Renders views/<view>.html inside views/layout.html. `pageClass` is a CSS class for the page container;
 * `head` is trusted HTML added to <head> (the caller must escape anything user-supplied in it).
 */
export function render(view: string, title: string, vars: Vars = {}, pageClass = '', head = ''): string {
  return interpolate(load('layout'), { title, pageClass, head, body: interpolate(load(view), vars) });
}

export const messagePage = (heading: string): string => render('message', heading, { heading });
