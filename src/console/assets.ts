import { createHash } from "node:crypto";

/** Fixed presentation assets. They intentionally contain no runtime values. */
export const stylesheet = `
:root {
  color-scheme: light;
  --bg: #f5f7fb; --surface: #fff; --surface-muted: #eef2f7; --text: #172033;
  --muted: #5e6a7e; --border: #d5dce8; --accent: #2457c5; --focus: #f59e0b;
  --success: #147d4d; --failure: #b42318; --cancelled: #8a4b08; --interrupted: #6941c6;
  --success-bg: #dcfae6; --failure-bg: #fee4e2; --cancelled-bg: #fff1d6; --interrupted-bg: #eee8ff;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root { color-scheme: dark; --bg: #0e1420; --surface: #172033; --surface-muted: #222d40;
    --text: #eef3fb; --muted: #aebbd0; --border: #34435c; --accent: #8bb4ff; --focus: #fbbf24;
    --success: #65d99d; --failure: #ff8f87; --cancelled: #ffc46b; --interrupted: #c5aaff;
    --success-bg: #123c2c; --failure-bg: #4a201f; --cancelled-bg: #493516; --interrupted-bg: #30245b; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); line-height: 1.5; }
a { color: var(--accent); }
a:focus-visible, button:focus-visible, input:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
.shell { max-width: 1240px; margin: 0 auto; padding: 1rem; }
header.site-header { display: flex; gap: 1rem; align-items: baseline; justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: .8rem; margin-bottom: 1.25rem; }
nav { display: flex; gap: .8rem; flex-wrap: wrap; }
.grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
.lanes { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); align-items: start; }
.card, article, section.panel { background: var(--surface); border: 1px solid var(--border); border-radius: .65rem; padding: 1rem; box-shadow: 0 2px 8px #0000000d; }
.card h3, article h2, section h2 { margin-top: 0; }
.health { display: grid; gap: .7rem; grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); margin-bottom: 1.3rem; }
.health .metric { background: var(--surface); border: 1px solid var(--border); border-radius: .5rem; padding: .75rem; }
.metric strong { display: block; font-size: 1.35rem; }
.stale { border-color: var(--failure); color: var(--failure); }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: .55rem; border-bottom: 1px solid var(--border); vertical-align: top; }
th { color: var(--muted); font-size: .85rem; text-transform: uppercase; letter-spacing: .04em; }
pre, code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--surface-muted); border-radius: .4rem; padding: .75rem; }
button, input { font: inherit; }
button { cursor: pointer; border: 1px solid var(--border); border-radius: .35rem; padding: .4rem .7rem; color: var(--text); background: var(--surface-muted); }
button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
button.danger { color: var(--failure); border-color: var(--failure); }
button:disabled { cursor: not-allowed; opacity: .55; }
input { color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: .35rem; padding: .4rem .5rem; }
label { display: inline-flex; gap: .45rem; align-items: center; }
.status-pill { display: inline-flex; gap: .35rem; align-items: center; border-radius: 999px; padding: .18rem .55rem; font-weight: 700; font-size: .82rem; }
.status-pill::before { content: ""; display: inline-block; width: .55rem; height: .55rem; border-radius: 50%; background: currentColor; }
.status-succeeded { color: var(--success); background: var(--success-bg); }
.status-failed { color: var(--failure); background: var(--failure-bg); }
.status-cancelled { color: var(--cancelled); background: var(--cancelled-bg); }
.status-interrupted { color: var(--interrupted); background: var(--interrupted-bg); }
.status-queued, .status-preparing, .status-running, .status-validating, .status-publishing, .status-reporting { color: var(--accent); background: var(--surface-muted); }
.status-failed::before { border-radius: 0; transform: rotate(45deg); }
.status-cancelled::before { border-radius: 0; }
.status-interrupted::before { border-radius: 0; transform: rotate(45deg); }
.timeline { list-style: none; padding: 0; margin: 0; }
.timeline li { border-left: 3px solid var(--border); padding: .4rem 0 .7rem 1rem; margin-left: .4rem; }
.timeline li:last-child { border-left-color: transparent; }
.danger-zone { border: 2px solid var(--failure); background: var(--failure-bg); }
.actions { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
.muted { color: var(--muted); }
.sr-status { min-height: 1.5rem; color: var(--muted); }
.signin { max-width: 34rem; margin: 10vh auto; }
`;

export const clientScript = `
(() => {
  const status = (message) => { const node = document.querySelector('[data-live-status]'); if (node) node.textContent = message; };
  const remember = (root) => ({
    details: [...root.querySelectorAll('details')].map((d) => d.open),
    inputs: [...root.querySelectorAll('input')].map((i) => ({ name: i.name, value: i.value })),
  });
  const restore = (root, state) => {
    [...root.querySelectorAll('details')].forEach((d, i) => { if (state.details[i] !== undefined) d.open = state.details[i]; });
    state.inputs.forEach((saved) => { const input = root.querySelector('input[name="' + CSS.escape(saved.name) + '"]'); if (input && document.activeElement !== input) input.value = saved.value; });
    const confirmation = root.querySelector('[data-reset-confirm]'); const reset = root.querySelector('[data-reset-submit]');
    if (confirmation && reset) {
      reset.disabled = confirmation.value !== 'RESET';
      const pr = root.querySelector('input[name="reset-pr"]');
      reset.dataset.body = JSON.stringify({ confirm: 'RESET', prNumber: Number(pr?.value) });
    }
  };
  const swap = (fragments) => Object.entries(fragments || {}).forEach(([id, html]) => {
    const root = document.getElementById(id); if (!root) return;
    const atBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 24;
    const state = remember(root); root.innerHTML = html; restore(root, state);
    if (atBottom) root.scrollTop = root.scrollHeight;
  });
  const eventSource = document.querySelector('[data-stream]');
  if (eventSource && window.EventSource) {
    const stream = new EventSource(eventSource.dataset.stream);
    stream.addEventListener('job-update', (event) => { try { swap(JSON.parse(event.data)); status('Updated just now'); } catch { status('Unable to apply live update'); } });
    stream.addEventListener('dashboard-update', (event) => { try { swap(JSON.parse(event.data)); status('Updated just now'); } catch { status('Unable to apply live update'); } });
    stream.onerror = () => status('Live updates reconnecting…');
  }
  document.addEventListener('click', async (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-action]') : null; if (!button || button.disabled) return;
    const action = button.dataset.action; const url = button.dataset.url || window.location.pathname;
    if (action === 'reset' && !window.confirm('Reset this workspace?')) return;
    button.disabled = true; status('Working…');
    try {
      const body = button.dataset.body ? JSON.parse(button.dataset.body) : undefined;
      const response = await fetch(url, { method: 'POST', ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || ('Request failed (' + response.status + ')'));
      status(payload.enabled === undefined ? 'Action completed' : (payload.enabled ? 'Repository enabled' : 'Repository disabled'));
      if (payload.enabled !== undefined) { const label = button.parentElement.querySelector('[data-enabled]'); if (label) label.textContent = payload.enabled ? 'enabled' : 'disabled'; button.textContent = payload.enabled ? 'Disable' : 'Enable'; }
      button.disabled = false;
    } catch (error) { status(error instanceof Error ? error.message : 'Action refused'); button.disabled = false; }
  });
  document.addEventListener('input', (event) => {
    const target = event.target instanceof HTMLInputElement ? event.target : null;
    if (target?.matches('[data-reset-confirm], input[name="reset-pr"]')) {
      const root = target.closest('#danger-zone') || document; const confirmation = root.querySelector('[data-reset-confirm]'); const button = root.querySelector('[data-reset-submit]'); const pr = root.querySelector('input[name="reset-pr"]');
      if (button) { button.disabled = !confirmation || confirmation.value !== 'RESET'; button.dataset.body = JSON.stringify({ confirm: 'RESET', prNumber: Number(pr?.value) }); }
    }
    if (target?.matches('[data-log-filter]')) {
      const level = document.querySelector('[data-log-level]').value.toLowerCase(); const text = target.value.toLowerCase();
      document.querySelectorAll('[data-log-entry]').forEach((entry) => { entry.hidden = (level && entry.dataset.level !== level) || (text && !entry.textContent.toLowerCase().includes(text)); });
    }
  });
  document.addEventListener('change', (event) => {
    if (!(event.target instanceof HTMLSelectElement) || !event.target.matches('[data-log-level]')) return;
    const level = event.target.value.toLowerCase(); const text = document.querySelector('[data-log-filter]').value.toLowerCase();
    document.querySelectorAll('[data-log-entry]').forEach((entry) => { entry.hidden = (level && entry.dataset.level !== level) || (text && !entry.textContent.toLowerCase().includes(text)); });
  });
  document.querySelectorAll('[data-log-url]').forEach(async (viewer) => {
    try {
      const response = await fetch(viewer.dataset.logUrl);
      if (!response.ok) return;
      const rows = await response.json(); const items = viewer.querySelector('[data-log-items]'); if (!items || !Array.isArray(rows)) return;
      items.replaceChildren(...rows.map((row) => { const entry = document.createElement('article'); entry.dataset.logEntry = ''; entry.dataset.level = row.level || ''; const heading = document.createElement('div'); heading.textContent = (row.at || '') + ' ' + (row.level || '') + ' ' + (row.event || ''); const fields = document.createElement('pre'); fields.textContent = row.fields || '{}'; entry.append(heading, fields); return entry; }));
    } catch { /* The server-rendered log remains available when refresh fails. */ }
  });
  const signIn = document.querySelector('[data-sign-in]');
  if (signIn) signIn.addEventListener('click', async () => { const token = document.querySelector('#token').value; const response = await fetch('/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) }); if (response.ok) window.location.href = '/'; else document.querySelector('[data-auth-error]').textContent = 'Invalid token'; });
})();
`;

const hash = createHash("sha256")
  .update(stylesheet + clientScript)
  .digest("hex")
  .slice(0, 12);
export const assetHash = hash;
export const stylesheetPath = `/assets/app.${hash}.css`;
export const clientScriptPath = `/assets/app.${hash}.js`;
