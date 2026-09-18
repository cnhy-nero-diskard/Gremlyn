import { createHash } from "node:crypto";

/** Fixed presentation assets. They intentionally contain no runtime values. */
export const stylesheet = `
:root {
  color-scheme: light;
  --font-sans: "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
  --font-mono: "Cascadia Mono", "SFMono-Regular", Consolas, monospace;
  --type-caption: .75rem; --type-meta: .8125rem; --type-body: 1rem;
  --type-control: .875rem; --type-section: 1.125rem; --type-page: 1.75rem;
  --type-display: 2rem;
  --line-tight: 1.2; --line-body: 1.5; --line-relaxed: 1.6;
  --weight-regular: 400; --weight-medium: 500; --weight-semibold: 600; --weight-bold: 700;
  --space-1: .25rem; --space-2: .5rem; --space-3: .75rem; --space-4: 1rem;
  --space-5: 1.25rem; --space-6: 1.5rem; --space-7: 2rem; --space-8: 2.5rem;
  --radius-sm: .35rem; --radius-md: .55rem; --radius-lg: .75rem; --radius-pill: 999px;
  --border-thin: 1px; --border-strong: 2px;
  --shadow-none: none; --shadow-panel: 0 1px 2px rgb(15 23 42 / .07);
  --shadow-peak: 0 4px 14px rgb(15 23 42 / .1); --shadow-inset: inset 0 1px 2px rgb(15 23 42 / .06);
  --motion-fast: 120ms; --motion-standard: 180ms; --motion-slow: 260ms;
  --ease-standard: cubic-bezier(.2, .8, .2, 1);

  --surface-canvas: #f5f7fb; --surface-panel: #fff; --surface-raised: #fff;
  --surface-quiet: #eef2f7; --surface-inset: #e8edf4; --surface-hover: #e8effb;
  --surface-active: #dbe7fb;
  --text-primary: #172033; --text-secondary: #3f4b61; --text-muted: #5e6a7e;
  --text-subtle: #66748b; --divider: #d5dce8; --divider-strong: #b9c5d8;
  --interactive: #2457c5; --interactive-hover: #1946ad; --interactive-active: #123a92;
  --interactive-subtle: #e7efff; --interactive-contrast: #fff;
  --focus-ring: #9a4406; --focus-offset: #fff;
  --status-success-fg: #166534; --status-success-bg: #e7f8ed; --status-success-border: #61b985;
  --status-progress-fg: #1d4ed8; --status-progress-bg: #e7efff; --status-progress-border: #6e94eb;
  --status-warning-fg: #8a4b08; --status-warning-bg: #fff3d8; --status-warning-border: #d69a45;
  --status-failure-fg: #a61b15; --status-failure-bg: #fde9e7; --status-failure-border: #dc827d;
  --status-danger-fg: #8f2019; --status-danger-bg: #fff0ee; --status-danger-border: #c85b54;
  --status-cancelled-fg: #8a4b08; --status-cancelled-bg: #fff1d6; --status-cancelled-border: #d69a45;
  --status-interrupted-fg: #6941c6; --status-interrupted-bg: #eee8ff; --status-interrupted-border: #a38be2;
  --status-neutral-fg: #4b5563; --status-neutral-bg: #eef2f7; --status-neutral-border: #aab7ca;
  --event-reasoning: #6941c6; --event-text: #2457c5; --event-tool: #19704a;
  --panel-peak-border: #b8c9e6; --panel-inset-border: #c6d1e1;

  /* Compatibility aliases keep existing markup readable during migration. */
  --bg: #f5f7fb; --surface: #fff; --surface-muted: #eef2f7; --text: #172033;
  --muted: #5e6a7e; --border: #d5dce8; --accent: #2457c5; --accent-contrast: #fff; --focus: #9a4406;
  --success: #166534; --success-bg: #e7f8ed; --failure: #a61b15; --failure-bg: #fde9e7;
  --cancelled: #8a4b08; --cancelled-bg: #fff1d6; --interrupted: #6941c6; --interrupted-bg: #eee8ff;
  --mono: var(--font-mono);
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --shadow-panel: 0 1px 2px rgb(0 0 0 / .28); --shadow-peak: 0 4px 14px rgb(0 0 0 / .35);
    --shadow-inset: inset 0 1px 2px rgb(0 0 0 / .3);
    --surface-canvas: #0e1420; --surface-panel: #172033; --surface-raised: #1c2a40;
    --surface-quiet: #222d40; --surface-inset: #0b121e; --surface-hover: #263b5a;
    --surface-active: #304a70;
    --text-primary: #eef3fb; --text-secondary: #d4deed; --text-muted: #aebbd0;
    --text-subtle: #97a8c0; --divider: #34435c; --divider-strong: #4a5d7a;
    --interactive: #9abaff; --interactive-hover: #c1d5ff; --interactive-active: #dbe6ff;
    --interactive-subtle: #243b63; --interactive-contrast: #0e1420;
    --focus-ring: #ffd166; --focus-offset: #0e1420;
    --status-success-fg: #7ee2a7; --status-success-bg: #123c2c; --status-success-border: #3f9b69;
    --status-progress-fg: #a8c4ff; --status-progress-bg: #1d3358; --status-progress-border: #6f98e5;
    --status-warning-fg: #ffd37d; --status-warning-bg: #493516; --status-warning-border: #c9933d;
    --status-failure-fg: #ff9b93; --status-failure-bg: #4a201f; --status-failure-border: #dc756d;
    --status-danger-fg: #ff8c7d; --status-danger-bg: #421f22; --status-danger-border: #d36c61;
    --status-cancelled-fg: #ffc46b; --status-cancelled-bg: #493516; --status-cancelled-border: #c9933d;
    --status-interrupted-fg: #c5aaff; --status-interrupted-bg: #30245b; --status-interrupted-border: #8e74d2;
    --status-neutral-fg: #c5d0e0; --status-neutral-bg: #253247; --status-neutral-border: #62748f;
    --event-reasoning: #c5aaff; --event-text: #a8c4ff; --event-tool: #7ee2a7;
    --panel-peak-border: #5574a8; --panel-inset-border: #40526e;
    --focus-offset: var(--surface-canvas);
    --bg: #0e1420; --surface: #172033; --surface-muted: #222d40; --text: #eef3fb;
    --muted: #aebbd0; --border: #34435c; --accent: #9abaff; --accent-contrast: #0e1420; --focus: #ffd166;
    --success: #7ee2a7; --success-bg: #123c2c; --failure: #ff9b93; --failure-bg: #4a201f;
    --cancelled: #ffc46b; --cancelled-bg: #493516; --interrupted: #c5aaff; --interrupted-bg: #30245b;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); line-height: 1.5; overflow-x: hidden; }
a { color: var(--accent); }
a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
.shell { max-width: 1240px; margin: 0 auto; padding: 1rem; }
/* The job page runs two live panels side by side; it needs the extra room. */
.shell-wide { max-width: 1760px; }
main, .dash-page, .job-page, #job-lanes, #repositories, .page-head, .lanes, .repo-defaults, .model-provider-picker { min-width: 0; }
header.site-header { display: flex; gap: 1rem; align-items: baseline; justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: .8rem; margin-bottom: 1.25rem; }
nav { display: flex; gap: .8rem; flex-wrap: wrap; }
.grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
.lanes { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); align-items: start; }
.card, article, section.panel { background: var(--surface); border: 1px solid var(--border); border-radius: .65rem; padding: 1rem; box-shadow: var(--shadow-panel); }
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

.metric span { display: block; font-size: .74rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.metric strong { display: block; font-size: 1.35rem; line-height: 1.25; font-variant-numeric: tabular-nums; }
.metric small { color: var(--muted); }
.health-summary { display: flex; align-items: center; gap: .65rem; flex-wrap: wrap; margin-bottom: .8rem; }
.page-summary { font-size: .9rem; }
.stale { border-color: var(--failure); color: var(--failure); }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: .55rem; border-bottom: 1px solid var(--border); vertical-align: top; overflow-wrap: anywhere; }
th { color: var(--muted); font-size: .85rem; text-transform: uppercase; letter-spacing: .04em; }
.table-scroll { min-width: 0; max-width: 100%; overflow-x: auto; overscroll-behavior-inline: contain; }
.responsive-table-wrap { position: relative; }
.responsive-table-wrap:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
.responsive-table caption { caption-side: top; text-align: left; padding: 0 0 .6rem; font-weight: 700; color: var(--text); }
.responsive-table code, .responsive-table a { overflow-wrap: anywhere; }
.responsive-table details { min-width: 0; }
.validation-output { max-height: 14rem; overflow: auto; white-space: pre-wrap; }
.table-empty { padding: 1rem .55rem; }
td.num { font-variant-numeric: tabular-nums; }
/* Let the command column absorb the slack; the rest are fixed-width facts, so
   a two-row table does not stretch four columns across the whole panel. */
.validation-table th:nth-child(2), .validation-table td:nth-child(2) { width: 7rem; }
.validation-table th:nth-child(3), .validation-table td:nth-child(3) { width: 8rem; }
.validation-table th:nth-child(4), .validation-table td:nth-child(4) { width: 30%; }
.validation-table summary { cursor: pointer; color: var(--muted); font-size: .85rem; }
@media (max-width: 720px) {
  .responsive-table thead { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  .responsive-table, .responsive-table tbody, .responsive-table tr, .responsive-table td { display: block; }
  .responsive-table tbody { display: grid; gap: .7rem; }
  .responsive-table tr { border: 1px solid var(--border); border-radius: .45rem; padding: .35rem .7rem; background: var(--surface-muted); }
  .responsive-table td { display: grid; grid-template-columns: minmax(7rem, 36%) minmax(0, 1fr); gap: .6rem;
    align-items: start; padding: .55rem 0; border-bottom: 1px solid var(--border); }
  .responsive-table td:last-child { border-bottom: 0; }
  .responsive-table td::before { content: attr(data-label); color: var(--muted); font-size: .74rem;
    font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
  .responsive-table td.table-empty { display: block; }
  .responsive-table td.table-empty::before { content: none; }
}
.exit { display: inline-block; min-width: 1.7rem; text-align: center; border-radius: .3rem;
  padding: .05rem .35rem; font-weight: 700; font-size: .82rem; font-variant-numeric: tabular-nums; }
.exit-ok { color: var(--success); background: var(--success-bg); }
.exit-bad { color: var(--failure); background: var(--failure-bg); }
pre, code { font-family: var(--mono); }
pre { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--surface-muted); border-radius: .4rem; padding: .75rem; }
button, input, select { font: inherit; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important;
    scroll-behavior: auto !important; transition-duration: .01ms !important; }
}
button { cursor: pointer; border: 1px solid var(--border); border-radius: .35rem; padding: .4rem .7rem; color: var(--text); background: var(--surface-muted); }
button.primary { background: var(--accent); color: var(--accent-contrast); border-color: var(--accent); }
button.danger { color: var(--failure); border-color: var(--failure); }
button:disabled { cursor: not-allowed; opacity: .55; }
input, select { color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: .35rem; padding: .4rem .5rem; }
input:disabled, select:disabled { cursor: not-allowed; opacity: .55; }
.repo-defaults { display: flex; flex-wrap: wrap; gap: .8rem; }
.model-provider-picker { display: grid; gap: .55rem; min-width: min(100%, 34rem); }
.model-provider-picker label { display: grid; grid-template-columns: 5.5rem minmax(0, 1fr); gap: .45rem; align-items: center; }
.model-provider-picker select, .model-provider-picker input { min-width: 0; width: 100%; }
.model-picker-meta, .model-picker-description, .model-picker-hint { grid-column: 2; }
.model-picker-meta { display: flex; align-items: center; gap: .35rem; flex-wrap: wrap; min-width: 0; }
.model-picker-meta strong { font-size: .88rem; }
.model-picker-description, .model-picker-hint { color: var(--muted); display: block; font-size: .8rem; overflow-wrap: anywhere; }
.model-picker-description { max-width: 42rem; }
.model-picker-id { color: var(--muted); font-size: .72rem; overflow-wrap: anywhere; }
.model-picker-badges { display: inline-flex; align-items: center; gap: .25rem; flex-wrap: wrap; }
.model-badge { display: inline-flex; align-items: center; border: 1px solid currentColor; border-radius: 999px; padding: .08rem .42rem; font-size: .66rem; font-weight: 800; letter-spacing: .04em; line-height: 1.35; }
.model-badge-recommended, .model-badge-current { color: var(--accent); background: color-mix(in srgb, var(--accent) 16%, var(--surface)); }
.model-badge-free { color: var(--success); background: var(--success-bg); }
.model-badge-pass { color: var(--interrupted); background: var(--interrupted-bg); }
.model-badge-new { color: var(--cancelled); background: var(--cancelled-bg); }
.model-badge-flagship { color: var(--failure); background: var(--failure-bg); }
.model-badge-default { color: var(--muted); background: var(--surface-muted); }
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
.action-feedback { min-height: 1.4rem; margin: .35rem 0 0; color: var(--muted); font-size: .82rem; }
.action-feedback:empty { display: none; }
.action-feedback.is-error { color: var(--failure); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.console-status { margin: 0 0 1rem; padding: .45rem .7rem; border: 1px solid var(--border);
  border-radius: .4rem; color: var(--muted); font-size: .85rem; }
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
.job-page .page-head { grid-area: head; }
.activity-panel { grid-area: activity; }
#job-log-region { grid-area: log; display: flex; min-width: 0; }
.job-aside { grid-area: aside; }
@media (min-width: 1080px) {
  .job-page { grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr);
    grid-template-areas: "head head" "activity log" "aside aside"; }
}
.page-head { background: var(--surface); border: 1px solid var(--border); border-radius: .65rem;
  padding: .9rem 1rem 1rem; box-shadow: 0 2px 8px #0000000d; }
.crumbs { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; font-size: .8rem; color: var(--muted); }
.job-title { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; margin: .4rem 0 0; }
.job-title h1 { margin: 0; font-size: 1.4rem; letter-spacing: -.01em; }
.job-pr { color: var(--muted); font-weight: 500; }
.job-id { font-size: .78rem; font-variant-numeric: tabular-nums; }
.job-actions { margin-left: auto; display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; font-size: .85rem; }
.job-links { display: flex; gap: 1.1rem; flex-wrap: wrap; margin: .6rem 0 0; font-size: .85rem; }
.stat-strip { display: grid; gap: .6rem; grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr)); margin-top: .9rem; }
.stat-strip .metric { background: var(--surface-muted); border: 1px solid var(--border); border-radius: .5rem; padding: .55rem .7rem; }
.stat-strip .metric strong { font-size: 1.2rem; }
.stat-strip .metric small { font-size: .74rem; }
.stat-strip .stale { border-color: var(--failure); }
.stat-strip .stale strong { color: var(--failure); }
.page-head .sr-status { min-height: 0; font-size: .82rem; margin: .6rem 0 0; }
.page-head .sr-status:empty { display: none; }
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

/* Dashboard -----------------------------------------------------------------
   Health, then the work, then the configuration. The lanes are the reason the
   page is open, so they get the full width above the repository cards. */
.dash-page { display: grid; gap: 1rem; }
.page-title { display: flex; align-items: center; gap: .7rem; flex-wrap: wrap; }
.page-title h1 { margin: 0; font-size: 1.4rem; letter-spacing: -.01em; }
.page-summary { font-size: .85rem; }
.lanes { align-content: start; }
.lane { display: flex; flex-direction: column; border-top: 3px solid var(--lane, var(--border)); }
.lane-running { --lane: var(--accent); }
.lane-queued, .lane-recent { --lane: var(--muted); }
section.lane > h2 { color: var(--lane, var(--muted)); border-bottom-color: var(--border); }
.lane-count { margin-left: auto; font-variant-numeric: tabular-nums; color: var(--muted);
  background: var(--surface-muted); border-radius: 999px; padding: .05rem .5rem; font-size: .78rem; }
.job-rows { list-style: none; margin: 0; padding: 0; display: grid; gap: .4rem; max-height: 30rem; overflow: auto; }
.job-row { border: 1px solid var(--border); border-radius: .45rem; background: var(--surface-muted); padding: .5rem .65rem; }
.job-row:hover { border-color: var(--lane, var(--accent)); }
.job-row-main { display: flex; align-items: center; gap: .5rem; text-decoration: none; color: inherit; }
.job-row-repo { font-weight: 700; font-size: .92rem; overflow-wrap: anywhere; }
.job-row-main:hover .job-row-repo { text-decoration: underline; }
.job-row-pr { color: var(--muted); font-weight: 500; }
.job-row-main > .status-pill { margin-left: auto; flex-shrink: 0; }
.job-row-meta { display: flex; align-items: baseline; gap: .5rem; flex-wrap: wrap; margin-top: .3rem;
  font-size: .78rem; color: var(--muted); }
.job-row-meta code { font-size: .74rem; background: var(--surface); border: 1px solid var(--border);
  border-radius: .25rem; padding: 0 .3rem; }
.job-row-elapsed { margin-left: auto; font-variant-numeric: tabular-nums; }
.lane-empty { border: 1px dashed var(--border); border-radius: .45rem; padding: 1.1rem; text-align: center;
  margin: 0; font-size: .85rem; }
/* Repository cards: state first, then the pickers, then what gets run. */
.repo-card { display: flex; flex-direction: column; gap: .6rem; }
.repo-head { display: flex; align-items: center; gap: .55rem; flex-wrap: wrap; }
.repo-head h3 { margin: 0; font-size: 1rem; overflow-wrap: anywhere; }
.repo-head button { margin-left: auto; }
.repo-chips { display: flex; gap: .35rem; flex-wrap: wrap; margin: 0; }
.repo-chips .chip code { font-size: .76rem; }
.repo-validation h4 { margin: 0 0 .35rem; font-size: .72rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: .06em; color: var(--muted); }
.cmd-list { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: .35rem; }
.cmd-list code { display: inline-block; background: var(--surface-muted); border: 1px solid var(--border);
  border-radius: .3rem; padding: .1rem .4rem; font-size: .76rem; }
.state { display: inline-flex; align-items: center; border-radius: 999px; padding: .12rem .55rem;
  font-size: .74rem; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
.state-on { color: var(--success); background: var(--success-bg); }
.state-off { color: var(--muted); background: var(--surface-muted); }
.catalog-note { color: var(--muted); margin: -.25rem 0 1rem; font-size: .82rem; }

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
.log-stream { max-height: 20rem; overflow: auto; border: 1px solid var(--border); border-radius: .45rem;
  background: var(--surface-muted); font-family: var(--mono); font-size: .82rem; }
.log-line { display: grid; grid-template-columns: 6.2rem 3.6rem 1fr; gap: .5rem; align-items: baseline;
  padding: .28rem .6rem; border: 0; border-bottom: 1px solid var(--border); border-radius: 0;
  background: transparent; box-shadow: none; }
.log-line:last-child { border-bottom: 0; }
.log-line:nth-child(even) { background: var(--surface-inset); }
.log-line:hover { background: var(--surface-hover); }
.log-time { color: var(--muted); white-space: nowrap; }
.log-level { text-transform: uppercase; font-size: .7rem; font-weight: 700; letter-spacing: .04em; color: var(--muted); }
.log-event { font-weight: 700; font-family: var(--font-sans); }
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
.activity-summary { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap;
  font-size: .85rem; margin: 0 0 .7rem; }
.follow-toggle { margin-left: auto; font-size: .82rem; color: var(--muted); white-space: nowrap; }
.activity-stat { font-weight: 700; color: var(--text); }
.activity-stream { list-style: none; margin: 0; padding: 0 0 0 1.15rem; display: grid; gap: .45rem;
  align-content: start; max-height: 24rem; overflow: auto; position: relative; }
/* The rail, painted as a background rather than an absolutely positioned
   pseudo-element: inside a scroll container an abspos rail is only as tall as
   one visible page and scrolls away, leaving every dot below it unconnected. */
.activity-stream { background-image: linear-gradient(var(--border), var(--border));
  background-repeat: no-repeat; background-position: .32rem 0; background-size: 2px 100%; }
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
.activity-block.is-open { border-left-color: var(--kind, var(--accent)); }
.activity-block.is-open::after { content: ""; position: absolute; left: -3px; top: 0; width: 3px; height: 40%;
  background: linear-gradient(180deg, transparent, var(--kind, var(--accent)), transparent);
  animation: activity-sheen 1.8s ease-in-out infinite; }
.activity-block.is-open .activity-dot { animation: activity-ping 1.4s ease-out infinite; }
/* Travels within the block: the sheen is 40% tall, so 0%..60% never escapes. */
@keyframes activity-sheen { 0% { top: 0; } 100% { top: 60%; } }
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
  height: min(46vh, 28rem); min-height: 14rem; overflow: hidden; resize: vertical; }
/* Nothing to scroll yet: an empty transcript should not hold open a screenful
   of blank card just because a running one would fill it. */
.activity-panel:not(:has(.activity-stream)) { height: auto; min-height: 0; resize: none; }
#job-log-region > .panel { flex: 1; min-width: 0; }
.activity-panel > .activity-stream, #log-viewer > .log-stream { flex: 1; min-height: 0; max-height: none; }

/* Token-driven visual system ------------------------------------------------
   The selectors below are the migration layer for current and sibling-owned
   console surfaces. Keep the hierarchy restrained: one operational peak,
   ordinary panels, quiet metadata, and inset evidence. */
html { font-family: var(--font-sans); }
body, button, input, select, textarea { font-family: var(--font-sans); }
body { background: var(--surface-canvas); color: var(--text-primary); font-size: var(--type-body); line-height: var(--line-body); }
body, main, section, article, p, h1, h2, h3, h4, ul, ol, dl, pre { overflow-wrap: anywhere; }
h1, h2, h3, h4 { color: var(--text-primary); line-height: var(--line-tight); font-weight: var(--weight-semibold); }
h1 { font-size: var(--type-page); letter-spacing: -.02em; }
h2 { font-size: var(--type-section); }
h3 { font-size: var(--type-body); }
h4, th, .metric span, .repo-validation h4, .kv dt { font-size: var(--type-caption); }
p { margin: 0 0 var(--space-4); }
small, .muted, .panel-note, .page-summary, .action-feedback { color: var(--text-muted); }
time, .job-id, .job-row-meta, td.num, .attempt-elapsed { font-variant-numeric: tabular-nums; }
code, pre, .log-stream, .job-id, .path, [data-path] { font-family: var(--font-mono); }
code, .path, [data-path] { overflow-wrap: anywhere; }
a { color: var(--interactive); text-underline-offset: .15em; transition: color var(--motion-fast) var(--ease-standard); }
a:hover { color: var(--interactive-hover); }
a:active { color: var(--interactive-active); }
:where(a, button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])):focus-visible {
  outline: var(--border-strong) solid var(--focus-ring); outline-offset: var(--space-1);
  box-shadow: 0 0 0 3px var(--focus-offset);
}
.shell { max-width: 1240px; margin: 0 auto; padding: var(--space-6) var(--space-5); }
.shell-wide { max-width: 1760px; }
main, .dash-page, .job-page, #job-lanes, #repositories, .page-head, .lanes, .repo-defaults,
.model-provider-picker, .job-aside, #commands-region, #audit-region { min-width: 0; }
header.site-header { align-items: center; gap: var(--space-5); padding-bottom: var(--space-4); margin-bottom: var(--space-6); border-bottom: var(--border-thin) solid var(--divider); }
header.site-header > strong { color: var(--text-secondary); font-size: var(--type-control); letter-spacing: .01em; }
header.site-header.presentation-quiet { padding-bottom: var(--space-4); border-bottom-color: var(--divider); }
nav { align-items: center; gap: var(--space-2); }
nav a, nav button { min-height: 2.5rem; display: inline-flex; align-items: center; justify-content: center; padding: var(--space-2) var(--space-3); border: var(--border-thin) solid transparent; border-radius: var(--radius-sm); font-size: var(--type-control); font-weight: var(--weight-medium); text-decoration: none; }
nav a:hover, nav button:hover { color: var(--interactive-hover); background: var(--surface-hover); border-color: var(--divider); }
nav a:active, nav button:active { color: var(--interactive-active); background: var(--surface-active); }
nav a[aria-current="page"] { color: var(--interactive); background: var(--interactive-subtle); border-color: var(--status-progress-border); font-weight: var(--weight-bold); box-shadow: inset 0 -2px 0 var(--interactive); }
nav form { margin: 0; }
.grid, .lanes, .job-aside { gap: var(--space-5); }
.dash-page, .job-page { gap: var(--space-6); }

.card, article, section.panel { background: var(--surface-panel); border: var(--border-thin) solid var(--divider); border-radius: var(--radius-lg); padding: var(--space-5); box-shadow: var(--shadow-panel); }
.presentation-peak, [data-presentation="peak"] { background: var(--surface-raised); border-color: var(--panel-peak-border); box-shadow: var(--shadow-peak); }
.presentation-panel, [data-presentation="panel"] { background: var(--surface-panel); border-color: var(--divider); box-shadow: var(--shadow-panel); }
.presentation-quiet, [data-presentation="quiet"] { background: transparent; border-color: transparent; box-shadow: var(--shadow-none); padding: var(--space-2) 0; }
.presentation-inset, [data-presentation="inset"] { background: var(--surface-inset); border-color: var(--panel-inset-border); box-shadow: var(--shadow-inset); }
.repo-card[data-presentation="quiet"] { background: var(--surface-quiet); border-color: var(--divider); padding: var(--space-4); }
.page-head { padding: var(--space-5) var(--space-6) var(--space-6); }
.page-head.presentation-peak { border-width: var(--border-thin); }
.page-title, .job-title { gap: var(--space-3); }
.page-title h1, .page-head h1, .job-title h1 { margin: 0; font-size: var(--type-page); line-height: var(--line-tight); }
.page-title h1, .job-title h1 { letter-spacing: -.02em; }
section.panel > h2 { gap: var(--space-2); margin: 0 0 var(--space-4); padding-bottom: var(--space-3); border-bottom: var(--border-thin) solid var(--divider); color: var(--text-secondary); font-size: var(--type-caption); font-weight: var(--weight-bold); letter-spacing: .08em; line-height: var(--line-tight); }
section.panel > h3 { margin: var(--space-5) 0 var(--space-2); color: var(--text-secondary); font-size: var(--type-caption); }
.panel-note { font-size: var(--type-meta); font-weight: var(--weight-regular); }
.panel-foot { margin: var(--space-5) 0 0; padding-top: var(--space-3); border-top: var(--border-thin) solid var(--divider); font-size: var(--type-control); }
.metric span, th, .kv dt, .repo-validation h4 { color: var(--text-muted); font-weight: var(--weight-bold); letter-spacing: .06em; text-transform: uppercase; }
.metric strong { color: var(--text-primary); line-height: var(--line-tight); }
.health-summary { gap: var(--space-3); margin-bottom: var(--space-5); }
.page-summary { font-size: var(--type-control); }
.stat-strip { gap: var(--space-3); margin-top: var(--space-5); }
.stat-strip .metric { background: var(--surface-quiet); border: var(--border-thin) solid var(--divider); border-radius: var(--radius-md); padding: var(--space-3) var(--space-4); }
.stale { border-color: var(--status-warning-border); color: var(--status-warning-fg); }
.stale strong { color: var(--status-warning-fg); }

table { color: var(--text-primary); }
th, td { padding: var(--space-3); border-bottom-color: var(--divider); }
th { font-size: var(--type-caption); }
.responsive-table-wrap:focus-visible { outline: var(--border-strong) solid var(--focus-ring); outline-offset: var(--space-1); box-shadow: 0 0 0 3px var(--focus-offset); }
.responsive-table caption { padding-bottom: var(--space-3); color: var(--text-primary); font-weight: var(--weight-semibold); }
.responsive-table tr { transition: background-color var(--motion-fast) var(--ease-standard); }
.responsive-table tbody tr:hover { background: var(--surface-hover); }
.validation-output { max-height: 14rem; padding: var(--space-4); background: var(--surface-inset); border: var(--border-thin) solid var(--panel-inset-border); border-radius: var(--radius-sm); }
.table-empty { padding: var(--space-5) var(--space-3); }
pre { background: var(--surface-inset); border: var(--border-thin) solid var(--panel-inset-border); border-radius: var(--radius-sm); padding: var(--space-4); }
.exit { min-width: 1.9rem; border: var(--border-thin) solid currentColor; border-radius: var(--radius-sm); padding: var(--space-1) var(--space-2); }
.exit-ok { color: var(--status-success-fg); background: var(--status-success-bg); }
.exit-bad { color: var(--status-failure-fg); background: var(--status-failure-bg); }

button, input, select { min-height: 2.5rem; font-size: var(--type-control); transition: color var(--motion-fast) var(--ease-standard), background-color var(--motion-fast) var(--ease-standard), border-color var(--motion-fast) var(--ease-standard), box-shadow var(--motion-fast) var(--ease-standard); }
button { cursor: pointer; border: var(--border-thin) solid var(--divider-strong); border-radius: var(--radius-sm); padding: var(--space-2) var(--space-4); color: var(--text-primary); background: var(--surface-quiet); }
button:hover { background: var(--surface-hover); border-color: var(--interactive); }
button:active { color: var(--interactive-active); background: var(--surface-active); }
button.primary { background: var(--interactive); color: var(--interactive-contrast); border-color: var(--interactive); }
button.primary:hover { background: var(--interactive-hover); border-color: var(--interactive-hover); }
button.primary:active { background: var(--interactive-active); border-color: var(--interactive-active); }
button.danger { color: var(--status-danger-fg); background: var(--status-danger-bg); border-color: var(--status-danger-border); }
button.danger:hover { color: var(--status-danger-fg); background: var(--status-danger-bg); border-color: var(--status-danger-fg); }
button:disabled, input:disabled, select:disabled { cursor: not-allowed; opacity: .55; }
button[aria-busy="true"], [data-picker-saving] button, [data-picker-saving] input, [data-picker-saving] select,
[data-visual-state="busy"], [data-state="busy"] { cursor: progress; background: var(--surface-quiet); border-color: var(--status-progress-border); }
input, select { color: var(--text-primary); background: var(--surface-panel); border: var(--border-thin) solid var(--divider-strong); border-radius: var(--radius-sm); padding: var(--space-2) var(--space-3); }
input:hover, select:hover { border-color: var(--interactive); background: var(--surface-hover); }
input[aria-invalid="true"], select[aria-invalid="true"] { border-color: var(--status-failure-border); }
label { gap: var(--space-2); }
.actions { gap: var(--space-3); }
.repo-defaults { gap: var(--space-4); }
.model-provider-picker { gap: var(--space-3); }
.model-provider-picker label { grid-template-columns: 6rem minmax(0, 1fr); gap: var(--space-2); }
.model-picker-meta { gap: var(--space-2); }
.model-picker-description, .model-picker-hint { font-size: var(--type-meta); }
.model-picker-id { color: var(--text-muted); font-size: var(--type-caption); }
.model-picker-badges { gap: var(--space-1); }
.model-badge { border-radius: var(--radius-pill); padding: var(--space-1) var(--space-2); font-size: var(--type-caption); font-weight: var(--weight-bold); line-height: var(--line-tight); }
.model-badge-recommended, .model-badge-current { color: var(--status-progress-fg); background: var(--status-progress-bg); border-color: var(--status-progress-border); }
.model-badge-free { color: var(--status-success-fg); background: var(--status-success-bg); border-color: var(--status-success-border); }
.model-badge-pass, .model-badge-validation { color: var(--status-interrupted-fg); background: var(--status-interrupted-bg); border-color: var(--status-interrupted-border); }
.model-badge-new, .model-badge-unavailable, .model-badge-mismatch { color: var(--status-warning-fg); background: var(--status-warning-bg); border-color: var(--status-warning-border); }
.model-badge-flagship { color: var(--status-neutral-fg); background: var(--status-neutral-bg); border-color: var(--status-neutral-border); }
.model-badge-default { color: var(--text-muted); background: var(--surface-quiet); border-color: var(--divider); }
.model-picker-mismatch { display: block; color: var(--status-warning-fg); font-size: var(--type-meta); }
.chip { gap: var(--space-1); background: var(--surface-quiet); border-color: var(--divider); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); color: var(--text-muted); font-size: var(--type-meta); }
.chip code { color: var(--text-primary); font-size: var(--type-meta); }

.status-pill { gap: var(--space-2); border: var(--border-thin) solid var(--status-neutral-border); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); color: var(--status-neutral-fg); background: var(--status-neutral-bg); font-size: var(--type-meta); font-weight: var(--weight-bold); line-height: var(--line-body); }
.status-pill::before { width: .55rem; height: .55rem; background: currentColor; }
.status-succeeded { color: var(--status-success-fg); background: var(--status-success-bg); border-color: var(--status-success-border); }
.status-failed { color: var(--status-failure-fg); background: var(--status-failure-bg); border-color: var(--status-failure-border); }
.status-cancelled { color: var(--status-cancelled-fg); background: var(--status-cancelled-bg); border-color: var(--status-cancelled-border); }
.status-interrupted { color: var(--status-interrupted-fg); background: var(--status-interrupted-bg); border-color: var(--status-interrupted-border); }
.status-queued, .status-preparing, .status-running, .status-validating, .status-publishing, .status-reporting { color: var(--status-progress-fg); background: var(--status-progress-bg); border-color: var(--status-progress-border); }
.status-failed::before, .status-interrupted::before { border-radius: 0; transform: rotate(45deg); }
.status-cancelled::before { border-radius: 0; }
.state { border: var(--border-thin) solid currentColor; border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); font-size: var(--type-caption); }
.state-on { color: var(--status-success-fg); background: var(--status-success-bg); border-color: var(--status-success-border); }
.state-off { color: var(--status-neutral-fg); background: var(--status-neutral-bg); border-color: var(--status-neutral-border); }

.presentation-peak .status-succeeded, .job-outcome-success { border-color: var(--status-success-border); }
.job-outcome-success { background: var(--status-success-bg); }
.job-outcome-success .job-title h1 { color: var(--status-success-fg); }
.job-row, .repo-card, .thread-comment, .attempt, .log-chip { border-color: var(--divider); }
.job-row { background: var(--surface-quiet); padding: var(--space-3) var(--space-4); transition: background-color var(--motion-fast) var(--ease-standard), border-color var(--motion-fast) var(--ease-standard), box-shadow var(--motion-fast) var(--ease-standard); }
.job-row:hover, .job-row:has(.job-row-main:focus-visible) { background: var(--surface-hover); border-color: var(--interactive); box-shadow: var(--shadow-panel); }
.job-row-main { gap: var(--space-2); }
.job-row-meta { gap: var(--space-2); margin-top: var(--space-2); color: var(--text-muted); font-size: var(--type-meta); }
.job-row-meta code, .cmd-list code { background: var(--surface-inset); border-color: var(--divider); border-radius: var(--radius-sm); padding: var(--space-1) var(--space-2); font-size: var(--type-caption); }
.job-row-pr, .job-pr { color: var(--text-muted); }
.lane { border-top: var(--border-thin) solid var(--divider); box-shadow: inset 0 var(--border-strong) 0 var(--lane, var(--divider)); }
.lane-running { --lane: var(--status-progress-border); }
.lane-queued, .lane-recent { --lane: var(--status-neutral-border); }
.lane-count { padding: var(--space-1) var(--space-2); color: var(--text-muted); background: var(--surface-quiet); border: var(--border-thin) solid var(--divider); }
.lane-empty { border-color: var(--divider); border-style: dashed; padding: var(--space-6); }
.repo-card { gap: var(--space-4); }
.repo-head { gap: var(--space-2); }
.repo-chips { gap: var(--space-2); }

.timeline li { gap: var(--space-2); border-left: var(--border-strong) solid var(--divider); padding: var(--space-2) 0 var(--space-3) var(--space-5); margin-left: var(--space-2); }
.timeline li::before { background: var(--divider-strong); box-shadow: 0 0 0 3px var(--surface-panel); }
.timeline time, .activity-time { color: var(--text-muted); font-family: var(--font-mono); font-size: var(--type-meta); }
.danger-zone { background: var(--status-danger-bg); border: var(--border-thin) solid var(--status-danger-border); box-shadow: var(--shadow-none); }
.danger-zone > h2 { color: var(--status-danger-fg); border-bottom-color: var(--status-danger-border); }
.danger-controls { margin-top: var(--space-4); }
.action-feedback { min-height: 1.4rem; margin: var(--space-2) 0 0; font-size: var(--type-meta); }
.action-feedback.is-error { color: var(--status-failure-fg); }
.action-feedback.is-success { color: var(--status-success-fg); }
.console-status { margin: 0 0 var(--space-5); padding: var(--space-3) var(--space-4); border: var(--border-thin) solid var(--divider); border-radius: var(--radius-md); color: var(--text-muted); font-size: var(--type-control); }
.console-status[data-connection-state="connected"] { color: var(--status-success-fg); background: var(--status-success-bg); border-color: var(--status-success-border); }
.console-status[data-connection-state="reconnecting"] { color: var(--status-warning-fg); background: var(--status-warning-bg); border-color: var(--status-warning-border); }
.console-status[data-connection-state="disconnected"] { color: var(--status-failure-fg); background: var(--status-failure-bg); border-color: var(--status-failure-border); }
.signin { max-width: 34rem; margin: 10vh auto; }
.signin form { display: grid; gap: var(--space-3); }
.signin form button { justify-self: start; margin-top: var(--space-2); }

.log-stream, .activity-stream, .review-scroll, .diff, .validation-output { background: var(--surface-inset); border-color: var(--panel-inset-border); }
.log-stream { border-radius: var(--radius-md); font-size: var(--type-meta); }
.log-line { gap: var(--space-2); padding: var(--space-2) var(--space-3); border-bottom-color: var(--divider); }
.log-line:nth-child(even) { background: var(--surface-quiet); }
.log-line:hover { background: var(--surface-hover); }
.log-event { font-family: var(--font-sans); font-weight: var(--weight-semibold); }
.log-chip { background: var(--surface-panel); border-color: var(--divider); border-radius: var(--radius-sm); padding: 0 var(--space-2); }
.log-warn .log-level { color: var(--status-warning-fg); }
.log-error .log-level { color: var(--status-failure-fg); }
.log-error, .log-error:nth-child(even), .log-error:hover { background: var(--status-failure-bg); }
.activity-stream { background-image: linear-gradient(var(--divider), var(--divider)); }
.activity-block { border: var(--border-thin) solid var(--divider); border-radius: var(--radius-md); padding: var(--space-3) var(--space-4); box-shadow: var(--shadow-none); }
.activity-reasoning { --kind: var(--event-reasoning); }
.activity-text { --kind: var(--event-text); }
.activity-tool { --kind: var(--event-tool); }
.activity-dot { background: var(--kind, var(--text-muted)); box-shadow: 0 0 0 3px var(--surface-inset); }
.activity-kind { border-color: var(--kind, var(--divider)); color: var(--kind, var(--text-muted)); background: var(--surface-panel); }
.activity-block.is-open { border-color: var(--status-progress-border); box-shadow: inset 0 0 0 var(--border-strong) var(--status-progress-border); }
.activity-block.is-open::after { left: var(--space-3); top: 0; width: calc(100% - var(--space-6)); height: var(--border-strong); background: var(--status-progress-border); animation: activity-sheen 1.8s ease-in-out infinite; }
.attempt { background: var(--surface-quiet); box-shadow: var(--shadow-none); padding: var(--space-4); }
.attempt-spec { gap: var(--space-2); margin: var(--space-3) 0; }
.attempt-spec .chip { background: var(--surface-panel); }
.attempt-failure { margin: var(--space-3) 0; padding: var(--space-3) var(--space-4); border: var(--border-thin) solid var(--status-failure-border); border-left-width: var(--border-thin); border-radius: var(--radius-sm); background: var(--status-failure-bg); color: var(--status-failure-fg); font-size: var(--type-control); }
.attempt-folds { gap: var(--space-4); margin-top: var(--space-4); }

.responsive-table tr, .responsive-table td, .responsive-table th, .kv > div { min-width: 0; }
.kv { gap: 0 var(--space-6); }
.kv > div { gap: var(--space-3); padding: var(--space-2) 0; border-bottom-color: var(--divider); }
.kv dd { color: var(--text-primary); font-size: var(--type-control); }
.review-split { gap: var(--space-6); margin-top: var(--space-3); }
.thread { gap: var(--space-3); }
.thread-comment { background: var(--surface-quiet); border-radius: var(--radius-md); padding: var(--space-3) var(--space-4); }
.thread-author { color: var(--interactive); margin-bottom: var(--space-2); }
.diff { padding: var(--space-2) 0; }
.diff .diff-add { background: var(--status-success-bg); color: var(--status-success-fg); }
.diff .diff-del { background: var(--surface-quiet); color: var(--text-secondary); text-decoration: line-through; text-decoration-thickness: 1px; }
.diff .diff-meta { color: var(--text-muted); }
.job-links { gap: var(--space-5); margin: var(--space-4) 0 0; font-size: var(--type-control); }
.job-actions { gap: var(--space-2); font-size: var(--type-control); }
.activity-panel, #job-log-region > .panel { height: min(46vh, 28rem); min-height: 14rem; }

/* Sibling-owned visual hooks: behavior and semantics stay with their owners. */
[data-visual-state="selected"], [aria-selected="true"], [data-state="selected"] { background: var(--interactive-subtle); border-color: var(--status-progress-border); }
[data-visual-state="error"], [data-state="error"] { border-color: var(--status-failure-border); }
[data-visual-state="success"], [data-state="success"] { border-color: var(--status-success-border); }
[data-visual-state="warning"], [data-state="warning"] { border-color: var(--status-warning-border); }
[data-visual-state="danger"], [data-state="danger"] { border-color: var(--status-danger-border); }
[data-visual-state="busy"], [data-state="busy"], [aria-busy="true"] { border-color: var(--status-progress-border); }
details > summary { cursor: pointer; color: var(--text-secondary); text-underline-offset: .15em; transition: color var(--motion-fast) var(--ease-standard), background-color var(--motion-fast) var(--ease-standard); }
details > summary:hover { color: var(--interactive-hover); }
details > summary:active { color: var(--interactive-active); background: var(--surface-active); }
details[open] > summary { color: var(--interactive); }

@media (max-width: 720px) {
  .shell { padding: var(--space-5) var(--space-4); }
  header.site-header { align-items: flex-start; flex-direction: column; }
  nav { width: 100%; }
  nav a, nav button { flex: 1 1 auto; }
  .responsive-table tr { border-color: var(--divider); border-radius: var(--radius-md); padding: var(--space-2) var(--space-3); background: var(--surface-quiet); }
  .responsive-table td { gap: var(--space-3); padding: var(--space-3) 0; border-bottom-color: var(--divider); }
  .responsive-table td::before { color: var(--text-muted); font-size: var(--type-caption); }
  .presentation-peak, [data-presentation="peak"], .presentation-panel, [data-presentation="panel"] { padding: var(--space-4); }
  .job-page, .dash-page { gap: var(--space-5); }
}
@media (max-width: 640px) {
  .job-actions { margin-left: 0; width: 100%; }
  .log-line { grid-template-columns: 1fr; gap: var(--space-1); }
  .log-chips { margin-left: 0; }
  .model-provider-picker label { grid-template-columns: 1fr; align-items: stretch; }
  .model-picker-meta, .model-picker-description, .model-picker-hint { grid-column: 1; }
}
@media (max-width: 420px) {
  .shell { padding-inline: var(--space-3); }
  h1, .page-title h1, .page-head h1, .job-title h1 { font-size: 1.5rem; }
  .page-head { padding: var(--space-4); }
  .actions, .job-links { align-items: stretch; flex-direction: column; }
  .actions > *, .job-links > * { max-width: 100%; }
  .stat-strip { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; transition-duration: .01ms !important; }
  .activity-block.is-open::after { animation: none; opacity: .8; }
  .activity-block.is-open .activity-dot, .live-badge::before { animation: none; }
}
`;

export const clientScript = `
(() => {
  let connectionState = 'initial';
  const setConnectionStatus = (state, message, shouldAnnounce = true) => {
    const node = document.querySelector('[data-connection-status]');
    const changed = connectionState !== state;
    connectionState = state;
    if (node && (node.textContent !== message || node.dataset.connectionState !== state)) {
      node.dataset.connectionState = state;
      node.textContent = message;
    }
    if (changed && shouldAnnounce && typeof announce === 'function') announce('connection', state, message, 'polite');
  };
  const relativeText = (value, now = Date.now()) => {
    if (!value) return 'never';
    const ms = now - Date.parse(value);
    if (!Number.isFinite(ms)) return 'unknown';
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return seconds + 's ago';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    return Math.floor(hours / 24) + 'd ago';
  };
  const elapsedText = (start, end, now = Date.now()) => {
    if (!start) return '—';
    const from = Date.parse(start);
    const to = end ? Date.parse(end) : now;
    if (!Number.isFinite(from) || !Number.isFinite(to)) return '—';
    const ms = Math.max(0, to - from);
    if (ms < 1000) return ms + 'ms';
    const seconds = ms / 1000;
    if (seconds < 60) return seconds.toFixed(1) + 's';
    return Math.floor(seconds / 60) + 'm ' + Math.round(seconds % 60) + 's';
  };
  const refreshTimes = () => document.querySelectorAll('[data-console-time]').forEach((node) => {
    const format = node.dataset.timeFormat;
    const instant = node.getAttribute('datetime');
    if (format === 'relative') node.textContent = relativeText(instant);
    if (format === 'elapsed') node.textContent = elapsedText(instant, node.dataset.timeEnd);
  });
  refreshTimes();
  setInterval(refreshTimes, 1000);
  const updateTableOverflow = (root = document) => root.querySelectorAll('[data-table-overflow]').forEach((node) => {
    const overflow = node.scrollWidth > node.clientWidth + 1;
    node.dataset.overflow = overflow ? 'true' : 'false';
    node.tabIndex = overflow ? 0 : -1;
  });
  updateTableOverflow();
  if (typeof window !== 'undefined') window.addEventListener('resize', () => updateTableOverflow());
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
  // Each catalog entry names the executor kinds it serves (the same mapping
  // the server-rendered pickers filter by), so a card only ever offers the
  // providers its repository's own agent can authenticate against.
  const providersFor = (root) => {
    const kind = root.dataset.agentKind || '';
    if (!kind) return modelCatalog || [];
    return (modelCatalog || []).filter((provider) => Array.isArray(provider.kinds) && provider.kinds.indexOf(kind) !== -1);
  };
  const providerFor = (root) => {
    const select = root.querySelector('[data-repo-provider-select]');
    const input = root.querySelector('[data-repo-provider-input]');
    return select && select.value === customProvider ? (input?.value || '').trim() : (select?.value || '').trim();
  };
  const savedProviderFor = (root) => root.dataset.savedProvider ?? '';
  const savedModelFor = (root) => root.dataset.savedModel ?? '';
  const savedEffortFor = (root) => root.dataset.savedEffort ?? '';
  const pickerBusy = (root) => {
    const active = document.activeElement;
    return Boolean(root.querySelector('[data-repo-picker][data-picker-saving]')) ||
      (active instanceof Element && Boolean(active.closest('[data-repo-picker]')));
  };
  const modelFor = (root) => {
    const select = root.querySelector('[data-repo-model-select]');
    const input = root.querySelector('[data-repo-model-input]');
    return select && !select.hidden ? select.value : (input?.value || '').trim();
  };
  const modelLabel = (model) => {
    return model.name || model.id;
  };
  const modelDescription = (model) => model.description || '';
  const providerLabel = (provider) => (provider.name || provider.id) + ' — ' + (provider.auth || 'provider credentials');
  const modelBadgeLabels = (model) => {
    const tier = model.tier === 'recommended' ? 'RECOMMENDED' : model.tier === 'free' ? 'FREE' : model.tier === 'subscribed' ? 'PASS' : '';
    return [...new Set([tier, ...(Array.isArray(model.tags) ? model.tags : [])].filter(Boolean))];
  };
  const modelBadgeClass = (label) => { const normalized = String(label).toLowerCase().replace(/[^a-z0-9]+/gu, '-'); return 'model-badge-' + (normalized || 'default'); };
  const renderModelBadges = (root, model) => {
    const badges = root.querySelector('[data-repo-model-badges]');
    if (!badges) return;
    badges.textContent = '';
    modelBadgeLabels(model).forEach((label) => {
      const badge = document.createElement('span'); badge.className = 'model-badge ' + modelBadgeClass(label); badge.textContent = label; badges.append(badge);
    });
  };
  const updateModelDescription = (root) => {
    const description = root.querySelector('[data-repo-model-description]');
    const name = root.querySelector('[data-repo-model-name]');
    const id = root.querySelector('[data-repo-model-id]');
    if (!description) return;
    const select = root.querySelector('[data-repo-model-select]');
    const option = select && !select.hidden ? select.selectedOptions[0] : null;
    const modelId = option?.value || modelFor(root);
    const modelName = option?.dataset.modelName || modelId || 'Choose a model';
    if (name) name.textContent = modelName;
    if (id) { id.textContent = modelId ? 'ID: ' + modelId : ''; id.hidden = !modelId; }
    renderModelBadges(root, {
      tier: option?.dataset.modelTier || undefined,
      tags: option?.dataset.modelTags ? option.dataset.modelTags.split('|').filter(Boolean) : [],
    });
    description.textContent = option?.dataset.modelDescription || (modelId ? 'Custom provider model.' : 'Choose a model.');
  };
  const syncPicker = (root, transientProvider) => {
    const providerSelect = root.querySelector('[data-repo-provider-select]');
    const providerInput = root.querySelector('[data-repo-provider-input]');
    const modelSelect = root.querySelector('[data-repo-model-select]');
    const modelInput = root.querySelector('[data-repo-model-input]');
    if (!providerSelect || !modelSelect || !modelInput) return;
    const savedProvider = savedProviderFor(root);
    const savedModel = savedModelFor(root);
    const isTransientProviderChange = transientProvider !== undefined;
    const providerId = isTransientProviderChange ? transientProvider : savedProvider;
    const staticProvider = [...modelSelect.options].some((option) => option.dataset.providerId === providerId);
    const catalogProvider = providersFor(root).find((entry) => entry.id === providerId);
    const mismatchOption = [...providerSelect.options].find((option) => option.value === providerId && option.dataset.providerMismatch !== undefined);
    const provider = catalogProvider ||
      (staticProvider ? { id: providerId, description: '' } : null);
    const hasCatalogModels = Boolean(provider);
    // An empty provider is a real selection for provider-optional agents, not
    // an unnamed custom one — keep the free-text provider input hidden then.
    const noProvider = providerId === '' && root.dataset.providerOptional !== undefined;
    providerInput.hidden = hasCatalogModels || noProvider || Boolean(mismatchOption);
    modelSelect.hidden = !hasCatalogModels;
    modelInput.hidden = hasCatalogModels;
    if (!hasCatalogModels) {
      modelInput.value = savedModel;
      updateModelDescription(root);
      return;
    }
    [...modelSelect.options].forEach((option) => {
      const visible = option.dataset.providerId === provider.id;
      option.hidden = !visible;
    });
    // HTMLOptGroupElement has no .options (only HTMLSelectElement does), so
    // reading it here threw and aborted the rest of syncPicker: the model
    // value, hint, and description below kept the previous provider's text
    // while the option list had already been re-filtered.
    modelSelect.querySelectorAll('optgroup').forEach((group) => {
      group.hidden = ![...group.querySelectorAll('option')].some((option) => !option.hidden);
    });
    const sameProvider = providerId === savedProvider;
    const requestedModel = sameProvider
      ? savedModel
      : (catalogProvider?.defaultModelId || [...modelSelect.options].find((option) => option.dataset.providerId === provider.id)?.value || '');
    let currentOption = [...modelSelect.options].find((option) => option.value === requestedModel && option.dataset.providerId === provider.id);
    if (!currentOption && sameProvider && savedModel) {
      currentOption = document.createElement('option');
      currentOption.value = savedModel;
      currentOption.textContent = savedModel;
      currentOption.dataset.providerId = provider.id;
      currentOption.dataset.modelName = savedModel;
      currentOption.dataset.modelTags = 'CURRENT';
      currentOption.dataset.modelDescription = 'Current repository model.';
      modelSelect.append(currentOption);
    }
    modelSelect.value = currentOption ? requestedModel : '';
    const hint = root.querySelector('[data-repo-hint]');
    if (hint) hint.textContent = mismatchOption
      ? 'Persisted provider is not supported by this repository agent; choose a supported provider to replace it.'
      : provider.description + ' All catalog models are selectable.';
    updateModelDescription(root);
  };
  const renderLivePicker = (root) => {
    const providers = providersFor(root);
    const providerSelect = root.querySelector('[data-repo-provider-select]');
    const providerInput = root.querySelector('[data-repo-provider-input]');
    const modelSelect = root.querySelector('[data-repo-model-select]');
    if (!providerSelect || !providerInput || !modelSelect) return;
    const currentProvider = savedProviderFor(root);
    const currentModel = savedModelFor(root);
    providerSelect.textContent = '';
    if (root.dataset.providerOptional !== undefined) {
      const none = document.createElement('option'); none.value = ''; none.textContent = 'None — provider is folded into the model id'; providerSelect.append(none);
    }
    const supported = providers.some((provider) => provider.id === currentProvider);
    const knownProviderForAnotherKind = (modelCatalog || []).some((provider) => provider.id === currentProvider);
    const providerMismatch = currentProvider && !supported && knownProviderForAnotherKind;
    if (providerMismatch) {
      const mismatch = document.createElement('option');
      mismatch.value = currentProvider;
      mismatch.textContent = 'Current provider: ' + currentProvider + ' (not supported by ' + (root.dataset.agentKind || 'this agent') + ')';
      mismatch.dataset.providerMismatch = 'true';
      providerSelect.append(mismatch);
    }
    providers.forEach((provider) => {
      const option = document.createElement('option'); option.value = provider.id; option.textContent = providerLabel(provider); providerSelect.append(option);
    });
    const custom = document.createElement('option'); custom.value = customProvider; custom.textContent = 'Custom provider'; providerSelect.append(custom);
    const known = supported || providerMismatch ||
      (root.dataset.providerOptional !== undefined && currentProvider === '');
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
        const option = document.createElement('option'); option.value = model.id; option.textContent = modelLabel(model); option.dataset.providerId = provider.id; option.dataset.modelName = model.name || model.id; option.dataset.modelTier = model.tier || ''; option.dataset.modelTags = Array.isArray(model.tags) ? model.tags.join('|') : ''; option.dataset.modelDescription = modelDescription(model); group.append(option);
      });
      modelSelect.append(group);
    });
    syncPicker(root);
  };
  const setPickerSelection = (root, provider, model, effort) => {
    root.dataset.savedProvider = provider;
    root.dataset.savedModel = model;
    root.dataset.savedEffort = effort;
    if (modelCatalog) renderLivePicker(root); else syncPicker(root);
  };
  const effortFor = (root) => root.querySelector('[data-repo-effort]')?.value || '';
  const timeoutFor = (root) => root.querySelector('[data-repo-timeout]')?.value.trim() || '';
  const savePicker = async (root, previousProvider, previousModel) => {
    const provider = providerFor(root); const model = modelFor(root); const effort = savedEffortFor(root); const id = root.dataset.repoId;
    const focused = document.activeElement;
    const controls = [...root.querySelectorAll('[data-repo-provider-select], [data-repo-provider-input], [data-repo-model-select], [data-repo-model-input]')];
    controls.forEach((control) => { control.disabled = true; });
    root.dataset.pickerSaving = 'true'; actionMessage(root, 'Saving model and provider…', false, 'settings:' + id + ':saving-model');
    try {
      const response = await fetch('/repos/' + id + '/model-provider', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider, model, effort }) });
      const payload = await response.json().catch(() => ({}));
      if (await routeSessionExpiry(response, payload)) return;
      if (!response.ok) throw new Error(payload.error || ('Request failed (' + response.status + ')'));
      root.dataset.savedProvider = payload.provider; root.dataset.savedModel = payload.model; delete root.dataset.providerMismatch; actionMessage(root, 'Model and provider updated', false, 'settings:' + id + ':saved-model');
    } catch (error) {
      setPickerSelection(root, previousProvider, previousModel, savedEffortFor(root));
      actionMessage(root, error instanceof Error ? safeActionError({ error: error.message }) : 'Update refused.', true, 'settings:' + id + ':model-error');
    } finally {
      delete root.dataset.pickerSaving; controls.forEach((control) => { control.disabled = false; });
      if (focused && typeof focused.focus === 'function' && root.contains(focused)) focused.focus({ preventScroll: true });
    }
  };
  const saveEffort = async (root, previousEffort) => {
    const input = root.querySelector('[data-repo-effort]'); const id = root.dataset.repoId;
    if (!input) return;
    const focused = document.activeElement === input;
    input.disabled = true; root.dataset.pickerSaving = 'true'; actionMessage(root, 'Saving reasoning effort…', false, 'settings:' + id + ':saving-effort');
    try {
      const response = await fetch('/repos/' + id + '/effort', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ effort: effortFor(root) }) });
      const payload = await response.json().catch(() => ({}));
      if (await routeSessionExpiry(response, payload)) return;
      if (!response.ok) throw new Error(payload.error || ('Request failed (' + response.status + ')'));
      root.dataset.savedEffort = payload.effort; actionMessage(root, 'Reasoning effort updated', false, 'settings:' + id + ':saved-effort');
    } catch (error) {
      root.dataset.savedEffort = previousEffort;
      input.value = previousEffort;
      actionMessage(root, error instanceof Error ? safeActionError({ error: error.message }) : 'Update refused.', true, 'settings:' + id + ':effort-error');
    } finally {
      delete root.dataset.pickerSaving; input.disabled = false;
      if (focused) input.focus({ preventScroll: true });
    }
  };
  const saveTimeout = async (root, previousTimeout) => {
    const input = root.querySelector('[data-repo-timeout]'); const id = root.dataset.repoId;
    if (!input) return;
    const focused = document.activeElement === input;
    input.disabled = true; actionMessage(root, 'Saving agent timeout…', false, 'settings:' + id + ':saving-timeout');
    const raw = input.value.trim(); const timeoutSeconds = raw === '' ? null : Number(raw);
    try {
      const response = await fetch('/repos/' + id + '/timeout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ timeoutSeconds }) });
      const payload = await response.json().catch(() => ({}));
      if (await routeSessionExpiry(response, payload)) return;
      if (!response.ok) throw new Error(payload.error || ('Request failed (' + response.status + ')'));
      root.dataset.savedTimeout = payload.timeoutSeconds === null ? '' : String(payload.timeoutSeconds); actionMessage(root, payload.timeoutSeconds === null ? 'Agent timeout disabled' : 'Agent timeout updated', false, 'settings:' + id + ':saved-timeout');
    } catch (error) {
      input.value = previousTimeout;
      actionMessage(root, error instanceof Error ? safeActionError({ error: error.message }) : 'Update refused.', true, 'settings:' + id + ':timeout-error');
    } finally {
      input.disabled = false;
      if (focused) input.focus({ preventScroll: true });
    }
  };
  const refreshModelCatalog = async () => {
    try {
      const response = await fetch('/model-catalog'); if (!response.ok) return;
      const payload = await response.json(); if (!Array.isArray(payload.providers)) return;
      modelCatalog = payload.providers;
      document.querySelectorAll('[data-repo-picker]').forEach((root) => { if (!pickerBusy(root)) renderLivePicker(root); });
    } catch { /* The server-rendered bundled catalog remains usable offline. */ }
  };
  const surfaceHooks = new Map();
  const announcementKeys = new Set();
  const escapeSelector = (value) => typeof CSS !== 'undefined' && CSS.escape
    ? CSS.escape(value)
    : String(value).replace(/[^a-zA-Z0-9_-]/gu, '\\$&');
  const isElement = (node) => Boolean(node && node.nodeType === 1);
  const directKey = (node) => isElement(node) ? (node.dataset.liveKey || '') : '';
  const keyedSelector = (key) => '[data-live-key="' + escapeSelector(key) + '"]';
  const describeNode = (node) => {
    const text = node?.textContent?.replace(/\\s+/gu, ' ').trim() || 'record';
    return text.slice(0, 80);
  };
  const announce = (channel, eventKey, message, priority = 'polite', target = null) => {
    const key = channel + '|' + eventKey + '|' + message;
    if (announcementKeys.has(key)) return false;
    announcementKeys.add(key);
    while (announcementKeys.size > 256) {
      const oldest = announcementKeys.values().next().value;
      if (!oldest) break;
      announcementKeys.delete(oldest);
    }
    const selector = channel === 'connection'
      ? '[data-connection-status]'
      : channel === 'action'
        ? '[data-action-announcement]'
        : '[data-operation-announcer]';
    const node = target || document.querySelector(selector);
    if (!node) return false;
    node.setAttribute('aria-live', priority);
    node.textContent = message;
    return true;
  };
  const semanticSnapshot = (root) => {
    const states = new Map();
    [root, ...root.querySelectorAll('[data-live-key]')].forEach((owner) => {
      const key = owner === root ? (root.id || directKey(root)) : directKey(owner);
      if (!key) return;
      const values = [...owner.querySelectorAll('[data-status-value]')]
        .filter((node) => {
          const nearest = node.closest('[data-live-key]');
          return owner === root ? !nearest || nearest === root : nearest === owner;
        })
        .map((node) => node.getAttribute('data-status-value') || '')
        .filter(Boolean);
      if (values.length) states.set(key, values.join('|'));
    });
    return states;
  };
  const announceSemanticChanges = (root, before) => {
    const after = semanticSnapshot(root);
    after.forEach((value, key) => {
      const previous = before.get(key);
      if (previous === value) return;
      const actionable = /failed|cancelled|interrupted|error|bad/iu.test(value);
      if (previous === undefined && !actionable) return;
      const owner = root.id === key ? root : root.querySelector(keyedSelector(key));
      const label = owner?.querySelector('h1, h2, h3, a')?.textContent?.replace(/\\s+/gu, ' ').trim()
        || 'An operational record';
      const status = value.split('|').join(', ');
      announce(
        'operational',
        'state:' + key + ':' + (previous || 'new') + '>' + value,
        label.slice(0, 80) + ' is now ' + status + '.',
        'polite',
      );
    });
  };
  const actionMessage = (source, message, error = false, eventKey = '') => {
    const scope = source?.closest ? source.closest('[data-action-scope]') : null;
    const node = scope?.querySelector(':scope > [data-action-feedback]') || scope?.querySelector('[data-action-feedback]');
    if (!node) return;
    node.classList.toggle('is-error', error);
    node.setAttribute('role', error ? 'alert' : 'status');
    node.setAttribute('aria-live', error ? 'assertive' : 'polite');
    node.textContent = message;
    announce('action', eventKey || ((scope.dataset.actionScope || 'action') + ':' + message), message, error ? 'assertive' : 'polite', node);
  };
  const safeActionError = (payload, fallback = 'Action refused. Try again.') => {
    const known = typeof payload?.error === 'string' ? payload.error : '';
    const messages = {
      'model-required': 'Choose a model before saving.',
      'provider-required': 'Choose a provider before saving.',
      'effort-required': 'Choose a reasoning effort before saving.',
      'effort-not-supported': 'That reasoning effort is not supported by this agent.',
      'timeout-invalid': 'Enter a valid timeout in seconds.',
      'explicit-reset-confirmation-required': 'Type RESET to confirm the workspace reset.',
      'workspace-reset-unavailable': 'Workspace reset is unavailable.',
      'retry-unavailable': 'Retry is unavailable for this job.',
      'cancel-unavailable': 'Cancel is unavailable for this job.',
    };
    return messages[known] || fallback;
  };
  const routeSessionExpiry = async (response, payload) => {
    if (response.status !== 401 || payload?.error !== 'session-expired') return false;
    document.querySelectorAll('[data-action-feedback]').forEach((node) => {
      node.textContent = '';
      node.classList.remove('is-error');
      node.setAttribute('role', 'status');
      node.setAttribute('aria-live', 'polite');
    });
    if (typeof window !== 'undefined' && window.location) window.location.assign('/auth?reason=expired');
    return true;
  };
  const registerSurface = (name, hook) => {
    surfaceHooks.set(name, hook);
    return () => surfaceHooks.delete(name);
  };
  const registerRepositoryState = (hook) => registerSurface('repository-settings', hook);
  const registerActionFeedback = (scope, hook) => registerSurface('action:' + scope, hook);
  const registerJobSafetySteps = (hook) => registerSurface('job-safety-rail', hook);
  const pathFrom = (ancestor, node) => {
    const path = [];
    let current = node;
    while (current && current !== ancestor) {
      const parent = current.parentNode;
      if (!parent) break;
      path.unshift(Array.prototype.indexOf.call(parent.childNodes, current));
      current = parent;
    }
    return current === ancestor ? path : [];
  };
  const nodeAtPath = (ancestor, path) => {
    let current = ancestor;
    for (const index of path || []) {
      current = current?.childNodes?.[index];
      if (!current) return null;
    }
    return current;
  };
  const keyedOwner = (root, node) => {
    let owner = isElement(node) && node.closest ? node.closest('[data-live-key]') : null;
    if (!owner || !root.contains(owner)) owner = root;
    return owner;
  };
  const nextKeyFor = (owner) => {
    if (!owner || owner === owner.parentNode) return '';
    let sibling = owner.nextElementSibling;
    while (sibling) {
      const key = directKey(sibling);
      if (key) return key;
      sibling = sibling.nextElementSibling;
    }
    return '';
  };
  const focusSnapshot = (root) => {
    const active = document.activeElement;
    if (!active || !root.contains(active)) return null;
    const owner = keyedOwner(root, active);
    const selector = active.id
      ? { kind: 'id', value: active.id }
      : active.name
        ? { kind: 'name', value: active.name }
        : null;
    return {
      ownerKey: owner === root ? '' : directKey(owner),
      ownerLabel: owner === root ? '' : describeNode(owner),
      nextKey: owner === root ? '' : nextKeyFor(owner),
      path: pathFrom(owner, active),
      selector,
      selectionStart: typeof active.selectionStart === 'number' ? active.selectionStart : null,
      selectionEnd: typeof active.selectionEnd === 'number' ? active.selectionEnd : null,
      selectionDirection: active.selectionDirection || 'none',
    };
  };
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
  const activityState = (root) => {
    const follow = root.querySelector('[data-activity-follow]');
    return follow ? { follow: follow.checked } : null;
  };
  const fieldSnapshot = (root) => [...root.querySelectorAll('input, select, textarea')].map((field) => {
    const owner = keyedOwner(root, field);
    return {
      ownerKey: owner === root ? '' : directKey(owner),
      path: pathFrom(owner, field),
      id: field.id || '',
      name: field.name || '',
      value: field.value,
      checked: typeof field.checked === 'boolean' ? field.checked : null,
      selectionStart: typeof field.selectionStart === 'number' ? field.selectionStart : null,
      selectionEnd: typeof field.selectionEnd === 'number' ? field.selectionEnd : null,
      selectionDirection: field.selectionDirection || 'none',
    };
  });
  const detailsSnapshot = (root) => [...root.querySelectorAll('details')].map((detail) => {
    const owner = keyedOwner(root, detail);
    return {
      ownerKey: owner === root ? '' : directKey(owner),
      path: pathFrom(owner, detail),
      key: detail.dataset.detailsKey || '',
      open: detail.open,
    };
  });
  const feedbackSnapshot = (root) => [...root.querySelectorAll('[data-action-feedback]')].map((node) => {
    const owner = keyedOwner(root, node);
    return {
      ownerKey: owner === root ? '' : directKey(owner),
      path: pathFrom(owner, node),
      text: node.textContent || '',
      role: node.getAttribute('role') || 'status',
      live: node.getAttribute('aria-live') || 'polite',
      error: node.classList.contains('is-error'),
    };
  });
  const remember = (root) => ({
    focus: focusSnapshot(root),
    // A dragged panel height lives in an inline style on an element the keyed
    // reconciler retains, but the value is carried explicitly for new nodes.
    sizes: Object.fromEntries([...root.querySelectorAll('[data-resizable]')].map((el) => [el.dataset.resizable, el.style.height])),
    activity: activityState(root),
    details: detailsSnapshot(root),
    feedback: feedbackSnapshot(root),
    inputs: fieldSnapshot(root),
    log: logState(root),
    scrolls: scrollState(root),
    surfaces: Object.fromEntries([...surfaceHooks.entries()].flatMap(([name, hook]) => {
      try { return [[name, hook.capture?.(root)]]; } catch { return []; }
    })),
  });
  const restoreField = (root, saved) => {
    const owner = saved.ownerKey ? root.querySelector(keyedSelector(saved.ownerKey)) : root;
    if (!owner) return null;
    let field = saved.id ? owner.querySelector('#' + escapeSelector(saved.id)) : null;
    if (!field && saved.name) field = owner.querySelector('[name="' + escapeSelector(saved.name) + '"]');
    if (!field) field = nodeAtPath(owner, saved.path);
    if (!field) return null;
    if (typeof saved.value === 'string' && 'value' in field) field.value = saved.value;
    if (typeof saved.checked === 'boolean' && 'checked' in field) field.checked = saved.checked;
    if (saved.selectionStart !== null && typeof field.setSelectionRange === 'function') {
      try { field.setSelectionRange(saved.selectionStart, saved.selectionEnd, saved.selectionDirection); } catch { /* field type has no selection */ }
    }
    return field;
  };
  const restore = (root, state) => {
    root.querySelectorAll('[data-resizable]').forEach((el) => {
      const saved = state.sizes && state.sizes[el.dataset.resizable];
      if (saved) el.style.height = saved;
    });
    state.details.forEach((saved) => {
      const owner = saved.ownerKey ? root.querySelector(keyedSelector(saved.ownerKey)) : root;
      if (!owner) return;
      const detail = saved.key
        ? owner.querySelector('[data-details-key="' + escapeSelector(saved.key) + '"]')
        : nodeAtPath(owner, saved.path);
      if (detail) detail.open = saved.open;
    });
    state.inputs.forEach((saved) => restoreField(root, saved));
    state.feedback.forEach((saved) => {
      const owner = saved.ownerKey ? root.querySelector(keyedSelector(saved.ownerKey)) : root;
      const node = owner ? nodeAtPath(owner, saved.path) : null;
      if (!node || !node.matches?.('[data-action-feedback]')) return;
      node.textContent = saved.text;
      node.setAttribute('role', saved.role);
      node.setAttribute('aria-live', saved.live);
      node.classList.toggle('is-error', saved.error);
    });
    root.querySelectorAll('[data-scroll-keep]').forEach((el) => {
      const saved = state.scrolls[el.dataset.scrollKeep];
      if (!saved) return;
      // The log panel has its own follow rule below; everything else simply
      // holds the operator's place, sticking to the bottom only if it was
      // already there.
      if (el.dataset.scrollKeep === 'log') return;
      if (el.dataset.scrollKeep === 'activity' && state.activity) {
        const follow = root.querySelector('[data-activity-follow]');
        if (follow) follow.checked = state.activity.follow;
        el.scrollTop = (state.activity.follow || saved.pinned) ? el.scrollHeight : saved.top;
        return;
      }
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
    Object.entries(state.surfaces || {}).forEach(([name, saved]) => {
      try { surfaceHooks.get(name)?.restore?.(root, saved); } catch { /* a surface may have gone away */ }
    });
    const focus = state.focus;
    if (!focus) return;
    const owner = focus.ownerKey ? root.querySelector(keyedSelector(focus.ownerKey)) : root;
    const focused = owner ? nodeAtPath(owner, focus.path) : null;
    if (focused && typeof focused.focus === 'function') {
      focused.focus({ preventScroll: true });
      if (focus.selectionStart !== null && typeof focused.setSelectionRange === 'function') {
        try { focused.setSelectionRange(focus.selectionStart, focus.selectionEnd, focus.selectionDirection); } catch { /* field type has no selection */ }
      }
      return;
    }
    if (focus.ownerKey) {
      const next = focus.nextKey ? root.querySelector(keyedSelector(focus.nextKey)) : null;
      const target = next?.querySelector('a, button, input, select, textarea, [tabindex]:not([tabindex="-1"])') || next;
      const fallback = root.querySelector('[data-focus-fallback]');
      if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
      else if (fallback && typeof fallback.focus === 'function') fallback.focus({ preventScroll: true });
      announce('operational', 'removed:' + focus.ownerKey, (focus.ownerLabel || 'The focused record') + ' was removed.', 'polite');
    }
  };
  const sameKind = (left, right) => left?.nodeType === right?.nodeType && (!isElement(left) || !isElement(right) || left.tagName === right.tagName);
  const syncAttributes = (current, incoming) => {
    [...current.attributes].forEach((attribute) => {
      if (!incoming.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
    });
    [...incoming.attributes].forEach((attribute) => {
      if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
    });
  };
  const reconcileChildren = (parent, incomingParent) => {
    const previous = [...parent.childNodes];
    const keyed = new Map();
    previous.forEach((node) => {
      const key = directKey(node);
      if (key) keyed.set(key, node);
    });
    const used = new Set();
    const incomingKeys = new Set();
    const desired = [...incomingParent.childNodes].map((incoming, index) => {
      const key = directKey(incoming);
      if (key && incomingKeys.has(key)) throw new Error('duplicate live key');
      if (key) incomingKeys.add(key);
      if (key && keyed.has(key) && used.has(keyed.get(key))) throw new Error('duplicate live key');
      let current = key ? keyed.get(key) : previous[index];
      if (current && (used.has(current) || !sameKind(current, incoming))) current = null;
      if (!current && !key) current = previous.find((node) => !used.has(node) && !directKey(node) && sameKind(node, incoming));
      if (current) {
        used.add(current);
        return reconcileNode(current, incoming);
      }
      return incoming.cloneNode(true);
    });
    desired.forEach((node, index) => {
      const at = parent.childNodes[index] || null;
      if (at !== node) parent.insertBefore(node, at);
    });
    previous.forEach((node) => { if (!used.has(node) && node.parentNode === parent) parent.removeChild(node); });
  };
  const reconcileNode = (current, incoming) => {
    if (!sameKind(current, incoming)) return incoming.cloneNode(true);
    if (!isElement(current)) {
      if (current.textContent !== incoming.textContent) current.textContent = incoming.textContent;
      return current;
    }
    syncAttributes(current, incoming);
    reconcileChildren(current, incoming);
    return current;
  };
  const reconcileFragment = (root, html) => {
    const state = remember(root);
    const semantic = semanticSnapshot(root);
    const template = document.createElement('template');
    template.innerHTML = String(html || '');
    try {
      reconcileChildren(root, template.content);
    } catch {
      root.replaceChildren(...[...template.content.childNodes].map((node) => node.cloneNode(true)));
    }
    restore(root, state);
    announceSemanticChanges(root, semantic);
    return root;
  };
  const swap = (fragments) => {
    Object.entries(fragments || {}).forEach(([id, html]) => {
      const root = document.getElementById(id); if (!root) return;
      const atBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 24;
      const busy = pickerBusy(root);
      reconcileFragment(root, html);
      if (!busy) root.querySelectorAll('[data-repo-picker]').forEach((picker) => modelCatalog ? renderLivePicker(picker) : syncPicker(picker));
      if (atBottom) root.scrollTop = root.scrollHeight;
      updateTableOverflow(root);
    });
    refreshTimes();
  };
  if (typeof window !== 'undefined') {
    window.gremlynConsole = {
      announce,
      registerSurface,
      registerRepositoryState,
      registerActionFeedback,
      registerJobSafetySteps,
      reconcileFragment,
      reconcile: (id, html) => {
        const root = document.getElementById(id);
        return root ? reconcileFragment(root, html) : null;
      },
      swap,
    };
  }
  const redirectToSignIn = (reason) => {
    if (typeof window !== 'undefined' && window.location) window.location.assign('/auth?reason=' + reason);
  };
  const probeSessionStatus = async () => {
    try {
      const response = await fetch('/session-status', { credentials: 'same-origin' });
      const payload = await response.json().catch(() => ({}));
      if (payload.status === 'expired' || payload.status === 'absent') {
        document.querySelectorAll('[data-action-feedback]').forEach((node) => { node.textContent = ''; });
        redirectToSignIn('expired');
        return false;
      }
      return payload.status === 'active';
    } catch { return false; }
  };
  const eventSource = document.querySelector('[data-stream]');
  if (eventSource && typeof window !== 'undefined' && window.EventSource) {
    const stream = new window.EventSource(eventSource.dataset.stream);
    const applyStreamEvent = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.kind === 'heartbeat') {
          return;
        }
        swap(payload.fragments || payload);
        setConnectionStatus('connected', 'Live updates connected.');
      } catch {
        announce('operational', 'stream-parse-error', 'A live update could not be applied.', 'polite');
      }
    };
    ['job-update', 'dashboard-update', 'commands-update', 'audit-update'].forEach((name) => stream.addEventListener(name, applyStreamEvent));
    stream.onopen = () => setConnectionStatus('connected', 'Live updates connected.');
    stream.onerror = async () => {
      setConnectionStatus('reconnecting', 'Live updates reconnecting.');
      const active = await probeSessionStatus();
      if (!active && stream.readyState === window.EventSource.CLOSED) setConnectionStatus('disconnected', 'Live updates disconnected.');
    };
  } else if (eventSource) {
    setConnectionStatus('disconnected', 'Live updates are unavailable in this browser.');
  }
  document.addEventListener('click', async (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-action]') : null; if (!button || button.disabled) return;
    const action = button.dataset.action; const url = button.dataset.url || window.location.pathname;
    if (action === 'reset' && !window.confirm('Reset this workspace?')) return;
    const focused = document.activeElement === button;
    button.disabled = true; actionMessage(button, 'Working…', false, 'action:' + action + ':working');
    try {
      const body = button.dataset.body ? JSON.parse(button.dataset.body) : undefined;
      const response = await fetch(url, { method: 'POST', ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
      const payload = await response.json().catch(() => ({}));
      if (await routeSessionExpiry(response, payload)) return;
      if (!response.ok) {
        actionMessage(button, safeActionError(payload), true, 'action:' + action + ':error');
        return;
      }
      actionMessage(button, payload.enabled === undefined ? 'Action completed.' : (payload.enabled ? 'Repository enabled.' : 'Repository disabled.'), false, 'action:' + action + ':success');
      if (payload.enabled !== undefined) { const label = button.parentElement.querySelector('[data-enabled]'); if (label) { label.textContent = payload.enabled ? 'enabled' : 'disabled'; label.className = 'state state-' + (payload.enabled ? 'on' : 'off'); } button.textContent = payload.enabled ? 'Disable' : 'Enable'; }
    } catch { actionMessage(button, 'Action failed. Try again.', true, 'action:' + action + ':error'); }
    finally {
      button.disabled = false;
      if (focused) button.focus({ preventScroll: true });
    }
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
    if (target instanceof HTMLInputElement && target.matches('[data-activity-follow]') && target.checked) {
      const stream = document.querySelector('[data-scroll-keep="activity"]');
      if (stream) stream.scrollTop = stream.scrollHeight;
      return;
    }
    if ((target instanceof HTMLSelectElement || target instanceof HTMLInputElement) && target.matches('[data-repo-provider-select], [data-repo-provider-input], [data-repo-model-select], [data-repo-model-input], [data-repo-effort]')) {
      const root = target.closest('[data-repo-picker]'); if (!root) return;
      const previousProvider = root.dataset.savedProvider ?? ''; const previousModel = root.dataset.savedModel ?? ''; const previousEffort = root.dataset.savedEffort ?? '';
      if (target.matches('[data-repo-provider-select]')) syncPicker(root, providerFor(root)); else updateModelDescription(root);
      if (target.matches('[data-repo-effort]')) await saveEffort(root, previousEffort); else await savePicker(root, previousProvider, previousModel);
    }
    if (target instanceof HTMLInputElement && target.matches('[data-repo-timeout]')) {
      const root = target.closest('[data-repo-picker]'); if (!root) return;
      root.dataset.pickerSaving = 'true';
      await saveTimeout(root, root.dataset.savedTimeout || '');
      delete root.dataset.pickerSaving;
    }
  });
  // The log arrives server-rendered and is refreshed by the stream swap above;
  // /jobs/:id/log remains available as a JSON endpoint for callers outside the UI.
  const initialStream = document.querySelector('[data-log-items]');
  if (initialStream) initialStream.scrollTop = initialStream.scrollHeight;
  const initialActivity = document.querySelector('[data-scroll-keep="activity"]');
  const initialFollow = document.querySelector('[data-activity-follow]');
  if (initialActivity && initialFollow?.checked) initialActivity.scrollTop = initialActivity.scrollHeight;
  document.querySelectorAll('[data-repo-picker]').forEach((root) => {
    if (root.dataset.savedProvider === undefined) root.dataset.savedProvider = providerFor(root);
    if (root.dataset.savedModel === undefined) root.dataset.savedModel = modelFor(root);
    if (root.dataset.savedEffort === undefined) root.dataset.savedEffort = effortFor(root);
    if (root.dataset.savedTimeout === undefined) root.dataset.savedTimeout = timeoutFor(root);
    syncPicker(root);
  });
  void refreshModelCatalog();
})();
`;

const hash = createHash("sha256")
  .update(stylesheet + clientScript)
  .digest("hex")
  .slice(0, 12);
export const assetHash = hash;
export const stylesheetPath = `/assets/app.${hash}.css`;
export const clientScriptPath = `/assets/app.${hash}.js`;
