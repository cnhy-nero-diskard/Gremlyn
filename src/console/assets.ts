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

/* Live log ------------------------------------------------------------------
   A dense, scannable stream rather than a wall of JSON: fixed-width time and
   level columns so the eye tracks one vertical line, and structured fields as
   inline chips. The stream scrolls inside its own box so the surrounding job
   controls stay reachable while a long attempt runs. */
.log-count { margin: .35rem 0 .5rem; font-size: .85rem; }
.log-follow { margin-left: auto; }
.live-badge { font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .06em;
  color: var(--accent); background: var(--surface-muted); border-radius: 999px; padding: .1rem .5rem; vertical-align: middle; }
.live-badge::before { content: ""; display: inline-block; width: .45rem; height: .45rem; border-radius: 50%;
  background: currentColor; margin-right: .35rem; vertical-align: baseline; animation: log-pulse 1.6s ease-in-out infinite; }
.live-badge-off { font-size: .72rem; text-transform: uppercase; letter-spacing: .06em; vertical-align: middle; }
@keyframes log-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }
@media (prefers-reduced-motion: reduce) { .live-badge::before { animation: none; } }
.log-stream { max-height: 26rem; overflow: auto; border: 1px solid var(--border); border-radius: .45rem;
  background: var(--surface-muted); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: .82rem; }
.log-line { display: grid; grid-template-columns: 6.2rem 3.6rem 1fr; gap: .5rem; align-items: baseline;
  padding: .28rem .6rem; border: 0; border-bottom: 1px solid var(--border); border-radius: 0;
  background: transparent; box-shadow: none; }
.log-line:last-child { border-bottom: 0; }
.log-line:nth-child(even) { background: #8888880d; }
.log-line:hover { background: #8888881f; }
.log-time { color: var(--muted); white-space: nowrap; }
.log-level { text-transform: uppercase; font-size: .7rem; font-weight: 700; letter-spacing: .04em; color: var(--muted); }
.log-event { font-weight: 700; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
.log-body { min-width: 0; }
.log-chips { display: inline-flex; flex-wrap: wrap; gap: .3rem; margin-left: .5rem; vertical-align: baseline; }
.log-chip { background: var(--surface); border: 1px solid var(--border); border-radius: .3rem; padding: 0 .3rem; color: var(--muted); }
.log-key { color: var(--accent); font-weight: 600; margin-right: .2rem; }
.log-detail { margin: .3rem 0 0; padding: .4rem .5rem; background: var(--surface); font-size: .8rem; }
.log-warn .log-level { color: var(--cancelled); }
.log-error .log-level { color: var(--failure); }
.log-error { background: var(--failure-bg); }
.log-error:nth-child(even), .log-error:hover { background: var(--failure-bg); }
.log-debug { opacity: .75; }
@media (max-width: 640px) {
  .log-line { grid-template-columns: 1fr; gap: .15rem; }
  .log-chips { margin-left: 0; }
}

/* Agent activity ------------------------------------------------------------
   A vertical timeline: one rail down the left, a dot per step, colour-coded by
   what the agent was doing. Colour alone never carries the meaning — each step
   also states its kind — so the three types stay distinguishable without it. */
.activity-panel { border-color: var(--accent); }
.activity-attempt { font-size: .8rem; font-weight: 400; }
.activity-summary { font-size: .85rem; margin: .2rem 0 .7rem; }
.activity-stat { font-weight: 700; color: var(--text); }
.activity-stream { list-style: none; margin: 0; padding: 0 0 0 1.15rem; display: grid; gap: .45rem;
  max-height: 32rem; overflow: auto; position: relative; }
/* The rail itself, behind the dots. */
.activity-stream::before { content: ""; position: absolute; left: .32rem; top: .3rem; bottom: .3rem;
  width: 2px; background: var(--border); border-radius: 2px; }
.activity-block { position: relative; background: var(--surface-muted); border: 1px solid var(--border);
  border-left: 3px solid var(--kind, var(--border)); border-radius: .45rem; padding: .45rem .65rem; }
.activity-dot { position: absolute; left: -1.02rem; top: .75rem; width: .55rem; height: .55rem;
  border-radius: 50%; background: var(--kind, var(--muted)); box-shadow: 0 0 0 3px var(--surface); }
.activity-reasoning { --kind: var(--interrupted); }
.activity-text { --kind: var(--accent); }
.activity-tool { --kind: var(--success); }
.activity-head { display: flex; align-items: baseline; gap: .45rem; flex-wrap: wrap; }
.activity-kind { font-size: .68rem; font-weight: 700; text-transform: uppercase; letter-spacing: .06em;
  border-radius: 999px; padding: .08rem .5rem; background: var(--surface); border: 1px solid var(--kind, var(--border)); color: var(--kind, var(--muted)); }
.activity-time { font-size: .72rem; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.activity-fold > summary, .activity-args > summary { cursor: pointer; }
.activity-args > summary { font-size: .74rem; color: var(--muted); margin-top: .3rem; }
.activity-tool-name { margin: .3rem 0 0; }
.activity-tool-name code { font-size: .84rem; font-weight: 700; }
/* .activity-text doubles as the block body; keep it quiet inside a card. */
pre.activity-text { margin: .3rem 0 0; background: transparent; padding: 0; font-size: .84rem; }
.activity-open { font-size: .72rem; color: var(--kind, var(--muted)); font-style: italic; }

/* The step still being written: a travelling sheen along its left edge and a
   pulsing dot, so a live attempt is obvious at a glance from the rail alone. */
.activity-block.is-open { border-left-color: var(--kind, var(--accent)); overflow: hidden; }
.activity-block.is-open::after { content: ""; position: absolute; left: -3px; top: 0; width: 3px; height: 40%;
  background: linear-gradient(180deg, transparent, var(--kind, var(--accent)), transparent);
  animation: activity-sheen 1.8s ease-in-out infinite; }
.activity-block.is-open .activity-dot { animation: activity-ping 1.4s ease-out infinite; }
@keyframes activity-sheen { 0% { top: -40%; } 100% { top: 100%; } }
@keyframes activity-ping {
  0% { box-shadow: 0 0 0 3px var(--surface), 0 0 0 3px var(--kind, var(--accent)); }
  70% { box-shadow: 0 0 0 3px var(--surface), 0 0 0 9px transparent; }
  100% { box-shadow: 0 0 0 3px var(--surface), 0 0 0 9px transparent; }
}
@media (prefers-reduced-motion: reduce) {
  .activity-block.is-open::after { animation: none; opacity: .8; height: 100%; top: 0; }
  .activity-block.is-open .activity-dot { animation: none; }
}
`;

export const clientScript = `
(() => {
  const status = (message) => { const node = document.querySelector('[data-live-status]'); if (node) node.textContent = message; };
  // The log region is replaced wholesale on every stream tick, so anything the
  // operator set by hand — filter text, level, follow, scroll position — has to
  // be carried across the swap or it resets several times a second.
  const logState = (root) => {
    const stream = root.querySelector('[data-log-items]');
    const level = root.querySelector('[data-log-level]');
    const filter = root.querySelector('[data-log-filter]');
    const follow = root.querySelector('[data-log-follow]');
    if (!stream && !level && !filter) return null;
    return {
      level: level ? level.value : '',
      filter: filter ? filter.value : '',
      follow: follow ? follow.checked : true,
      scrollTop: stream ? stream.scrollTop : 0,
      pinned: stream ? stream.scrollHeight - stream.scrollTop - stream.clientHeight < 24 : true,
    };
  };
  const applyLogFilter = (root) => {
    const levelNode = root.querySelector('[data-log-level]');
    const filterNode = root.querySelector('[data-log-filter]');
    const level = levelNode ? levelNode.value.toLowerCase() : '';
    const text = filterNode ? filterNode.value.toLowerCase() : '';
    root.querySelectorAll('[data-log-entry]').forEach((entry) => {
      entry.hidden = (level && (entry.dataset.level || '').toLowerCase() !== level) || (text && !entry.textContent.toLowerCase().includes(text));
    });
  };
  // Any scrollable panel inside a swapped region loses its position, because
  // the region's innerHTML is replaced wholesale. Key by name, not index, so a
  // panel appearing or disappearing between ticks cannot shift the mapping.
  const scrollState = (root) => {
    const state = {};
    root.querySelectorAll('[data-scroll-keep]').forEach((el) => {
      state[el.dataset.scrollKeep] = {
        top: el.scrollTop,
        pinned: el.scrollHeight - el.scrollTop - el.clientHeight < 24,
      };
    });
    return state;
  };
  const remember = (root) => ({
    // Keyed where a stable identity exists: a live transcript appends blocks,
    // and index-based restore would reopen whichever element slid into the slot.
    details: [...root.querySelectorAll('details')].map((d) => d.open),
    detailKeys: Object.fromEntries([...root.querySelectorAll('details[data-details-key]')].map((d) => [d.dataset.detailsKey, d.open])),
    inputs: [...root.querySelectorAll('input')].map((i) => ({ name: i.name, value: i.value })),
    log: logState(root),
    scrolls: scrollState(root),
  });
  const restore = (root, state) => {
    [...root.querySelectorAll('details')].forEach((d, i) => {
      const key = d.dataset.detailsKey;
      if (key && state.detailKeys && state.detailKeys[key] !== undefined) { d.open = state.detailKeys[key]; return; }
      if (!key && state.details[i] !== undefined) d.open = state.details[i];
    });
    state.inputs.forEach((saved) => { const input = root.querySelector('input[name="' + CSS.escape(saved.name) + '"]'); if (input && document.activeElement !== input) input.value = saved.value; });
    root.querySelectorAll('[data-scroll-keep]').forEach((el) => {
      const saved = state.scrolls[el.dataset.scrollKeep];
      if (!saved) return;
      // The log panel has its own follow rule below; everything else simply
      // holds the operator's place, sticking to the bottom only if it was
      // already there.
      if (el.dataset.scrollKeep === 'log') return;
      el.scrollTop = saved.pinned ? el.scrollHeight : saved.top;
    });
    if (state.log) {
      const level = root.querySelector('[data-log-level]');
      const filter = root.querySelector('[data-log-filter]');
      const follow = root.querySelector('[data-log-follow]');
      const stream = root.querySelector('[data-log-items]');
      if (level && document.activeElement !== level) level.value = state.log.level;
      if (filter && document.activeElement !== filter) filter.value = state.log.filter;
      if (follow) follow.checked = state.log.follow;
      applyLogFilter(root);
      // Follow means stay on the newest line; otherwise hold the operator's
      // place so reading back through the log is not yanked away mid-scroll.
      if (stream) stream.scrollTop = (state.log.follow || state.log.pinned) ? stream.scrollHeight : state.log.scrollTop;
    }
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
    if (target?.matches('[data-log-filter]')) applyLogFilter(document);
  });
  document.addEventListener('change', (event) => {
    const target = event.target;
    if (target instanceof HTMLSelectElement && target.matches('[data-log-level]')) { applyLogFilter(document); return; }
    // Ticking Follow jumps to the newest line immediately, rather than waiting
    // for the next stream tick to scroll.
    if (target instanceof HTMLInputElement && target.matches('[data-log-follow]') && target.checked) {
      const stream = document.querySelector('[data-log-items]');
      if (stream) stream.scrollTop = stream.scrollHeight;
    }
  });
  // The log arrives server-rendered and is refreshed by the stream swap above;
  // /jobs/:id/log remains available as a JSON endpoint for callers outside the UI.
  const initialStream = document.querySelector('[data-log-items]');
  if (initialStream) initialStream.scrollTop = initialStream.scrollHeight;
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
