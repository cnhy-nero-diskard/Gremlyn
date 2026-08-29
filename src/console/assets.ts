import { createHash } from "node:crypto";

/** Fixed presentation assets. They intentionally contain no runtime values. */
export const stylesheet = `
:root {
  color-scheme: light;
  --bg: #f5f7fb; --surface: #fff; --surface-muted: #eef2f7; --text: #172033;
  --muted: #5e6a7e; --border: #d5dce8; --accent: #2457c5; --focus: #f59e0b;
  --success: #147d4d; --failure: #b42318; --cancelled: #8a4b08; --interrupted: #6941c6;
  --success-bg: #dcfae6; --failure-bg: #fee4e2; --cancelled-bg: #fff1d6; --interrupted-bg: #eee8ff;
  --mono: ui-monospace, SFMono-Regular, Consolas, monospace;
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
a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
.shell { max-width: 1240px; margin: 0 auto; padding: 1rem; }
/* The job page runs two live panels side by side; it needs the extra room. */
.shell-wide { max-width: 1760px; }
header.site-header { display: flex; gap: 1rem; align-items: baseline; justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: .8rem; margin-bottom: 1.25rem; }
nav { display: flex; gap: .8rem; flex-wrap: wrap; }
.grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
.lanes { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); align-items: start; }
.card, article, section.panel { background: var(--surface); border: 1px solid var(--border); border-radius: .65rem; padding: 1rem; box-shadow: 0 2px 8px #0000000d; }
.card h3, article h2, section h2 { margin-top: 0; }
/* One quiet header treatment for every card, so a page of panels reads as a
   set of labelled regions rather than a stack of competing headlines. */
section.panel > h2 { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap;
  font-size: .8rem; font-weight: 700; text-transform: uppercase; letter-spacing: .07em;
  color: var(--muted); margin: 0 0 .75rem; padding-bottom: .55rem; border-bottom: 1px solid var(--border); }
.panel-note { font-weight: 400; text-transform: none; letter-spacing: 0; font-size: .78rem; }
section.panel > h3 { font-size: .8rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: .05em; color: var(--muted); margin: 1rem 0 .4rem; }
.panel-foot { margin: .8rem 0 0; padding-top: .6rem; border-top: 1px solid var(--border); font-size: .85rem; }
.panel-foot strong { color: var(--muted); margin-right: .4rem; }
.health { display: grid; gap: .7rem; grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); margin-bottom: 1.3rem; }
.health .metric { background: var(--surface); border: 1px solid var(--border); border-radius: .5rem; padding: .75rem; }
.metric span { display: block; font-size: .74rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.metric strong { display: block; font-size: 1.35rem; line-height: 1.25; font-variant-numeric: tabular-nums; }
.metric small { color: var(--muted); }
.stale { border-color: var(--failure); color: var(--failure); }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: .55rem; border-bottom: 1px solid var(--border); vertical-align: top; }
th { color: var(--muted); font-size: .85rem; text-transform: uppercase; letter-spacing: .04em; }
.table-scroll { overflow-x: auto; }
td.num { font-variant-numeric: tabular-nums; }
/* Let the command column absorb the slack; the rest are fixed-width facts, so
   a two-row table does not stretch four columns across the whole panel. */
.validation-table th:nth-child(2), .validation-table td:nth-child(2) { width: 7rem; }
.validation-table th:nth-child(3), .validation-table td:nth-child(3) { width: 8rem; }
.validation-table th:nth-child(4), .validation-table td:nth-child(4) { width: 30%; }
.validation-table summary { cursor: pointer; color: var(--muted); font-size: .85rem; }
.exit { display: inline-block; min-width: 1.7rem; text-align: center; border-radius: .3rem;
  padding: .05rem .35rem; font-weight: 700; font-size: .82rem; font-variant-numeric: tabular-nums; }
.exit-ok { color: var(--success); background: var(--success-bg); }
.exit-bad { color: var(--failure); background: var(--failure-bg); }
pre, code { font-family: var(--mono); }
pre { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--surface-muted); border-radius: .4rem; padding: .75rem; }
button, input, select { font: inherit; }
button { cursor: pointer; border: 1px solid var(--border); border-radius: .35rem; padding: .4rem .7rem; color: var(--text); background: var(--surface-muted); }
button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
button.danger { color: var(--failure); border-color: var(--failure); }
button:disabled { cursor: not-allowed; opacity: .55; }
input, select { color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: .35rem; padding: .4rem .5rem; }
input:disabled, select:disabled { cursor: not-allowed; opacity: .55; }
.repo-defaults { display: flex; flex-wrap: wrap; gap: .8rem; }
.model-provider-picker { display: grid; gap: .55rem; min-width: min(100%, 34rem); }
.model-provider-picker label { display: grid; grid-template-columns: 5.5rem minmax(0, 1fr); gap: .45rem; align-items: center; }
.model-provider-picker select, .model-provider-picker input { min-width: 0; width: 100%; }
.model-picker-description, .model-picker-hint { color: var(--muted); display: block; grid-column: 2; font-size: .8rem; overflow-wrap: anywhere; }
.model-picker-description { color: var(--text); }
.catalog-note { color: var(--muted); margin-top: -.75rem; }
label { display: inline-flex; gap: .45rem; align-items: center; }
.chip { display: inline-flex; align-items: center; gap: .3rem; background: var(--surface-muted);
  border: 1px solid var(--border); border-radius: 999px; padding: .12rem .6rem; font-size: .78rem; color: var(--muted); }
.chip code { font-size: .78rem; color: var(--text); }
.status-pill { display: inline-flex; gap: .35rem; align-items: center; border-radius: 999px; padding: .18rem .55rem;
  font-weight: 700; font-size: .82rem; color: var(--muted); background: var(--surface-muted); }
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
.timeline li { position: relative; display: flex; align-items: center; gap: .5rem; flex-wrap: wrap;
  border-left: 2px solid var(--border); padding: .3rem 0 .55rem .95rem; margin-left: .4rem; }
.timeline li::before { content: ""; position: absolute; left: -.3rem; top: .7rem; width: .5rem; height: .5rem;
  border-radius: 50%; background: var(--border); }
.timeline li:last-child { border-left-color: transparent; }
.timeline time { font-family: var(--mono); font-size: .8rem; color: var(--muted); }
.timeline li > .muted:last-child { margin-left: auto; font-size: .8rem; font-variant-numeric: tabular-nums; }
.danger-zone { border: 1px solid var(--border); border-left: 3px solid var(--failure); background: var(--surface); }
.danger-zone > h2 { color: var(--failure); }
.danger-controls { margin-top: .6rem; }
.danger-controls input[name="reset-pr"] { width: 6.5rem; }
.actions { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
.muted { color: var(--muted); }
.sr-status { min-height: 1.5rem; color: var(--muted); }
.signin { max-width: 34rem; margin: 10vh auto; }

/* Job page ------------------------------------------------------------------
   Three bands: an identity-and-controls header, the two live panels side by
   side filling the viewport, and the forensic detail below. The two swapped
   regions are display:contents so their children land in this one grid, which
   is what lets the log sit beside the transcript despite being replaced by a
   separate stream fragment. */
.job-page { display: grid; gap: 1rem; align-items: start;
  grid-template-columns: minmax(0, 1fr);
  grid-template-areas: "head" "activity" "log" "aside"; }
#job-detail-region { display: contents; }
.job-head { grid-area: head; }
.activity-panel { grid-area: activity; }
#job-log-region { grid-area: log; display: flex; min-width: 0; }
.job-aside { grid-area: aside; }
@media (min-width: 1080px) {
  .job-page { grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr);
    grid-template-areas: "head head" "activity log" "aside aside"; }
}
.job-head { background: var(--surface); border: 1px solid var(--border); border-radius: .65rem;
  padding: .9rem 1rem 1rem; box-shadow: 0 2px 8px #0000000d; }
.crumbs { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; font-size: .8rem; color: var(--muted); }
.job-title { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; margin: .4rem 0 0; }
.job-title h1 { margin: 0; font-size: 1.4rem; letter-spacing: -.01em; }
.job-pr { color: var(--muted); font-weight: 500; }
.job-id { font-size: .78rem; font-variant-numeric: tabular-nums; }
.job-actions { margin-left: auto; display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; font-size: .85rem; }
.job-links { display: flex; gap: 1.1rem; flex-wrap: wrap; margin: .6rem 0 0; font-size: .85rem; }
.job-stats { display: grid; gap: .6rem; grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr)); margin-top: .9rem; }
.job-stats .metric { background: var(--surface-muted); border: 1px solid var(--border); border-radius: .5rem; padding: .55rem .7rem; }
.job-stats .metric strong { font-size: 1.2rem; }
.job-stats .metric small { font-size: .74rem; }
.job-head .sr-status { min-height: 0; font-size: .82rem; margin: .55rem 0 0; }
.job-head .sr-status:empty { display: none; }
.job-aside { display: grid; gap: 1rem; grid-template-columns: minmax(0, 1fr); align-items: start; }
.job-aside .span-all { grid-column: 1 / -1; }
@media (min-width: 900px) {
  .job-aside { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .job-aside .span-2 { grid-column: span 2; }
}
.kv { display: grid; gap: 0 1.2rem; margin: 0; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); }
.kv > div { display: grid; grid-template-columns: minmax(6rem, 36%) minmax(0, 1fr); gap: .6rem;
  align-items: baseline; padding: .28rem 0; border-bottom: 1px solid var(--border); }
.kv dt { color: var(--muted); font-size: .72rem; text-transform: uppercase; letter-spacing: .05em; }
.kv dd { margin: 0; min-width: 0; font-size: .85rem; overflow-wrap: anywhere; }
.review-split { display: grid; gap: 1rem 1.5rem; grid-template-columns: minmax(0, 1fr); margin-top: .3rem; }
@media (min-width: 1400px) { .review-split { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } }
.review-scroll { max-height: 26rem; overflow: auto; }
.thread { list-style: none; margin: 0; padding: 0; display: grid; gap: .55rem; max-height: 26rem; overflow: auto; }
.thread-comment { background: var(--surface-muted); border: 1px solid var(--border);
  border-radius: .45rem; padding: .55rem .7rem; }
.thread-author { display: block; font-size: .74rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: .05em; color: var(--accent); margin-bottom: .25rem; }
.thread-body { white-space: pre-wrap; overflow-wrap: anywhere; font-size: .86rem; }
/* A hunk reads as a diff: one row per line so the tint spans the full width. */
.diff { max-height: 26rem; overflow: auto; padding: .5rem 0; font-size: .8rem; line-height: 1.45; }
.diff span { display: block; padding: 0 .6rem; white-space: pre-wrap; overflow-wrap: anywhere; }
.diff .diff-add { background: var(--success-bg); color: var(--success); }
.diff .diff-del { background: var(--failure-bg); color: var(--failure); }
.diff .diff-meta { color: var(--muted); font-weight: 700; }

/* Attempts: a card each, summary first, forensics folded away. */
.attempt-grid { display: grid; gap: .85rem; grid-template-columns: repeat(auto-fit, minmax(23rem, 1fr)); }
.attempt { background: var(--surface-muted); box-shadow: none; padding: .85rem; }
.attempt-head { display: flex; align-items: center; gap: .55rem; flex-wrap: wrap; }
.attempt-head h3 { margin: 0; font-size: 1rem; }
.attempt-elapsed { margin-left: auto; font-size: .82rem; font-variant-numeric: tabular-nums; }
.attempt-spec { display: flex; gap: .35rem; flex-wrap: wrap; margin: .55rem 0; }
.attempt-spec .chip { background: var(--surface); }
.attempt-failure { margin: .55rem 0; padding: .45rem .6rem; border-radius: .35rem; font-size: .85rem;
  border-left: 3px solid var(--failure); background: var(--failure-bg); color: var(--failure); }
.attempt-failure strong { text-transform: uppercase; font-size: .7rem; letter-spacing: .05em; margin-right: .4rem; }
.attempt .kv { grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); }
.attempt .kv > div:last-child { border-bottom: 0; }
.attempt-folds { display: flex; gap: 1rem; flex-wrap: wrap; margin-top: .7rem; }
.attempt-folds > details { flex: 1 1 11rem; min-width: 0; }
.attempt-folds summary { cursor: pointer; font-size: .82rem; color: var(--muted); }

/* Live log ------------------------------------------------------------------
   A dense, scannable stream rather than a wall of JSON: fixed-width time and
   level columns so the eye tracks one vertical line, and structured fields as
   inline chips. The stream scrolls inside its own box so the surrounding job
   controls stay reachable while a long attempt runs. */
.log-controls { margin-bottom: .6rem; }
.log-search { flex: 1 1 11rem; min-width: 0; }
.log-search input { flex: 1; min-width: 0; }
.log-follow { margin-left: auto; }
.live-badge { font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .06em;
  color: var(--accent); background: var(--surface-muted); border-radius: 999px; padding: .1rem .5rem; vertical-align: middle; }
.live-badge::before { content: ""; display: inline-block; width: .45rem; height: .45rem; border-radius: 50%;
  background: currentColor; margin-right: .35rem; vertical-align: baseline; animation: log-pulse 1.6s ease-in-out infinite; }
.live-badge-off { font-size: .72rem; text-transform: uppercase; letter-spacing: .06em; vertical-align: middle; }
@keyframes log-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }
@media (prefers-reduced-motion: reduce) { .live-badge::before { animation: none; } }
.log-stream { max-height: 26rem; overflow: auto; border: 1px solid var(--border); border-radius: .45rem;
  background: var(--surface-muted); font-family: var(--mono); font-size: .82rem; }
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
  .job-actions { margin-left: 0; width: 100%; }
}

/* Agent activity ------------------------------------------------------------
   A vertical timeline: one rail down the left, a dot per step, colour-coded by
   what the agent was doing. Colour alone never carries the meaning — each step
   also states its kind — so the three types stay distinguishable without it. */
.activity-summary { font-size: .85rem; margin: 0 0 .7rem; }
.activity-stat { font-weight: 700; color: var(--text); }
.activity-stream { list-style: none; margin: 0; padding: 0 0 0 1.15rem; display: grid; gap: .45rem;
  align-content: start; max-height: 32rem; overflow: auto; position: relative; }
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
.activity-time { font-size: .72rem; color: var(--muted); font-family: var(--mono); }
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

/* Last word on the two live panels: they share a grid row, stretch to the same
   height and let their stream scroll inside. Placed after the log and activity
   blocks above so it overrides the standalone max-heights they set. */
.activity-panel, #job-log-region > .panel { display: flex; flex-direction: column;
  min-height: min(66vh, 46rem); max-height: min(80vh, 62rem); }
#job-log-region > .panel { flex: 1; min-width: 0; }
.activity-panel > .activity-stream, #log-viewer > .log-stream { flex: 1; min-height: 0; max-height: none; }
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
  let modelCatalog = null;
  const customProvider = '__custom__';
  const providerFor = (root) => {
    const select = root.querySelector('[data-repo-provider-select]');
    const input = root.querySelector('[data-repo-provider-input]');
    return select && select.value === customProvider ? (input?.value || '').trim() : (select?.value || '').trim();
  };
  const modelFor = (root) => {
    const select = root.querySelector('[data-repo-model-select]');
    const input = root.querySelector('[data-repo-model-input]');
    return select && !select.hidden ? select.value : (input?.value || '').trim();
  };
  const modelLabel = (model) => {
    const tier = model.tier === 'recommended' ? ' · RECOMMENDED' : model.tier === 'free' ? ' · FREE' : model.tier === 'subscribed' ? ' · PASS' : '';
    const tags = Array.isArray(model.tags) && model.tags.length ? ' · ' + model.tags.join(' · ') : '';
    return (model.name || model.id) + tier + tags;
  };
  const modelDescription = (model) => [model.description, 'ID: ' + model.id].filter(Boolean).join(' · ');
  const providerLabel = (provider) => (provider.name || provider.id) + ' — ' + (provider.auth || 'provider credentials');
  const updateModelDescription = (root) => {
    const description = root.querySelector('[data-repo-model-description]');
    if (!description) return;
    const select = root.querySelector('[data-repo-model-select]');
    const option = select && !select.hidden ? select.selectedOptions[0] : null;
    description.textContent = option?.dataset.modelDescription || (modelFor(root) ? 'ID: ' + modelFor(root) : 'Choose a model.');
  };
  const syncPicker = (root, preferredModel) => {
    const providerSelect = root.querySelector('[data-repo-provider-select]');
    const providerInput = root.querySelector('[data-repo-provider-input]');
    const modelSelect = root.querySelector('[data-repo-model-select]');
    const modelInput = root.querySelector('[data-repo-model-input]');
    if (!providerSelect || !modelSelect || !modelInput) return;
    const providerId = providerFor(root);
    const staticProvider = [...modelSelect.options].some((option) => option.dataset.providerId === providerId);
    const provider = modelCatalog?.find((entry) => entry.id === providerId) ||
      (staticProvider ? { id: providerId, description: '' } : null);
    providerInput.hidden = Boolean(provider);
    modelSelect.hidden = !provider;
    modelInput.hidden = Boolean(provider);
    if (!provider) { modelInput.value = preferredModel || modelInput.value; updateModelDescription(root); return; }
    [...modelSelect.options].forEach((option) => {
      const visible = option.dataset.providerId === provider.id;
      option.hidden = !visible;
    });
    modelSelect.querySelectorAll('optgroup').forEach((group) => {
      group.hidden = ![...group.options].some((option) => !option.hidden);
    });
    const current = preferredModel || modelSelect.value;
    const usable = [...modelSelect.options].find((option) => option.dataset.providerId === provider.id);
    const currentOption = [...modelSelect.options].find((option) => option.value === current && option.dataset.providerId === provider.id);
    modelSelect.value = currentOption ? current : (usable?.value || current);
    const hint = root.querySelector('[data-repo-hint]');
    if (hint) hint.textContent = provider.description + ' All catalog models are selectable.';
    updateModelDescription(root);
  };
  const renderLivePicker = (root, preferredModel) => {
    const providers = modelCatalog || [];
    const providerSelect = root.querySelector('[data-repo-provider-select]');
    const providerInput = root.querySelector('[data-repo-provider-input]');
    const modelSelect = root.querySelector('[data-repo-model-select]');
    if (!providerSelect || !providerInput || !modelSelect) return;
    const currentProvider = providerFor(root);
    const currentModel = preferredModel || modelFor(root);
    providerSelect.textContent = '';
    providers.forEach((provider) => {
      const option = document.createElement('option'); option.value = provider.id; option.textContent = providerLabel(provider); providerSelect.append(option);
    });
    const custom = document.createElement('option'); custom.value = customProvider; custom.textContent = 'Custom provider'; providerSelect.append(custom);
    const known = providers.some((provider) => provider.id === currentProvider);
    providerSelect.value = known ? currentProvider : customProvider;
    providerInput.value = known ? '' : currentProvider;
    modelSelect.textContent = '';
    providers.forEach((provider) => {
      const group = document.createElement('optgroup'); group.label = providerLabel(provider);
      const models = provider.models.slice();
      if (provider.id === currentProvider && currentModel && !models.some((model) => model.id === currentModel)) {
        models.push({ id: currentModel, name: currentModel, description: 'Current repository model.', tags: ['CURRENT'] });
      }
      models.forEach((model) => {
        const option = document.createElement('option'); option.value = model.id; option.textContent = modelLabel(model); option.dataset.providerId = provider.id; option.dataset.modelDescription = modelDescription(model); group.append(option);
      });
      modelSelect.append(group);
    });
    syncPicker(root, currentModel);
  };
  const setPickerSelection = (root, provider, model, effort) => {
    const providerSelect = root.querySelector('[data-repo-provider-select]');
    const providerInput = root.querySelector('[data-repo-provider-input]');
    const modelSelect = root.querySelector('[data-repo-model-select]');
    const modelInput = root.querySelector('[data-repo-model-input]');
    const effortSelect = root.querySelector('[data-repo-effort]');
    if (!providerSelect || !providerInput || !modelSelect || !modelInput || !effortSelect) return;
    const known = [...providerSelect.options].some((option) => option.value === provider);
    providerSelect.value = known ? provider : customProvider;
    providerInput.value = known ? '' : provider;
    if (!modelCatalog) { modelSelect.value = model; modelInput.value = model; }
    effortSelect.value = effort;
    syncPicker(root, model);
  };
  const effortFor = (root) => root.querySelector('[data-repo-effort]')?.value || '';
  const savePicker = async (root, previousProvider, previousModel, previousEffort) => {
    const provider = providerFor(root); const model = modelFor(root); const effort = effortFor(root); const id = root.dataset.repoId;
    const controls = [...root.querySelectorAll('select, input')]; controls.forEach((control) => { control.disabled = true; }); status('Saving model, provider, and effort…');
    try {
      const response = await fetch('/repos/' + id + '/model-provider', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider, model, effort }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || ('Request failed (' + response.status + ')'));
      root.dataset.savedProvider = payload.provider; root.dataset.savedModel = payload.model; root.dataset.savedEffort = payload.effort; status('Model, provider, and effort updated');
    } catch (error) {
      setPickerSelection(root, previousProvider, previousModel, previousEffort);
      status(error instanceof Error ? error.message : 'Update refused');
    } finally { controls.forEach((control) => { control.disabled = false; }); }
  };
  const refreshModelCatalog = async () => {
    try {
      const response = await fetch('/model-catalog'); if (!response.ok) return;
      const payload = await response.json(); if (!Array.isArray(payload.providers)) return;
      modelCatalog = payload.providers;
      document.querySelectorAll('[data-repo-picker]').forEach((root) => renderLivePicker(root));
    } catch { /* The server-rendered bundled catalog remains usable offline. */ }
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
    inputs: [...root.querySelectorAll('input, select')].map((i) => ({ name: i.name, value: i.value })),
    log: logState(root),
    scrolls: scrollState(root),
  });
  const restore = (root, state) => {
    [...root.querySelectorAll('details')].forEach((d, i) => {
      const key = d.dataset.detailsKey;
      if (key && state.detailKeys && state.detailKeys[key] !== undefined) { d.open = state.detailKeys[key]; return; }
      if (!key && state.details[i] !== undefined) d.open = state.details[i];
    });
    state.inputs.forEach((saved) => { if (!saved.name) return; const input = root.querySelector('[name="' + CSS.escape(saved.name) + '"]'); if (input && document.activeElement !== input) input.value = saved.value; });
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
    root.querySelectorAll('[data-repo-picker]').forEach((picker) => modelCatalog ? renderLivePicker(picker) : syncPicker(picker));
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
  document.addEventListener('change', async (event) => {
    const target = event.target;
    if (target instanceof HTMLSelectElement && target.matches('[data-log-level]')) { applyLogFilter(document); return; }
    // Ticking Follow jumps to the newest line immediately, rather than waiting
    // for the next stream tick to scroll.
    if (target instanceof HTMLInputElement && target.matches('[data-log-follow]') && target.checked) {
      const stream = document.querySelector('[data-log-items]');
      if (stream) stream.scrollTop = stream.scrollHeight;
      return;
    }
    if ((target instanceof HTMLSelectElement || target instanceof HTMLInputElement) && target.matches('[data-repo-provider-select], [data-repo-provider-input], [data-repo-model-select], [data-repo-model-input], [data-repo-effort]')) {
      const root = target.closest('[data-repo-picker]'); if (!root) return;
      const previousProvider = root.dataset.savedProvider || providerFor(root); const previousModel = root.dataset.savedModel || modelFor(root); const previousEffort = root.dataset.savedEffort || effortFor(root);
      if (target.matches('[data-repo-provider-select]')) syncPicker(root); else updateModelDescription(root);
      await savePicker(root, previousProvider, previousModel, previousEffort);
    }
  });
  // The log arrives server-rendered and is refreshed by the stream swap above;
  // /jobs/:id/log remains available as a JSON endpoint for callers outside the UI.
  const initialStream = document.querySelector('[data-log-items]');
  if (initialStream) initialStream.scrollTop = initialStream.scrollHeight;
  document.querySelectorAll('[data-repo-picker]').forEach((root) => { root.dataset.savedProvider = providerFor(root); root.dataset.savedModel = modelFor(root); root.dataset.savedEffort = effortFor(root); syncPicker(root); });
  void refreshModelCatalog();
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
