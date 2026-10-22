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
.grid { grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); }
.lanes { grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); }
.attempt-grid { grid-template-columns: repeat(auto-fit, minmax(min(100%, 23rem), 1fr)); }

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
input[type="checkbox"], input[type="radio"] { width: 1.1rem; min-height: 1.1rem; padding: 0; accent-color: var(--interactive); }
button[aria-pressed="true"], [aria-expanded="true"] { color: var(--interactive); background: var(--interactive-subtle); border-color: var(--status-progress-border); }
button[aria-disabled="true"], [aria-disabled="true"] { cursor: not-allowed; opacity: .55; }
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

/* Semantic role matrix for current and sibling-owned projections. The
   companion text/state label remains authoritative; these rules only add a
   redundant foreground, surface, and boundary treatment. */
[data-visual-role="success"], .semantic-success, .safety-step-passed, [data-safety-state="passed"] { color: var(--status-success-fg); background: var(--status-success-bg); border-color: var(--status-success-border); }
[data-visual-role="progress"], .semantic-progress, .safety-step-active, [data-safety-state="active"] { color: var(--status-progress-fg); background: var(--status-progress-bg); border-color: var(--status-progress-border); }
[data-visual-role="warning"], .semantic-warning, .attention-marker, [data-safety-state="skipped"], [data-safety-state="not-applicable"] { color: var(--status-warning-fg); background: var(--status-warning-bg); border-color: var(--status-warning-border); }
[data-visual-role="cancelled"] { color: var(--status-cancelled-fg); background: var(--status-cancelled-bg); border-color: var(--status-cancelled-border); }
[data-visual-role="interrupted"] { color: var(--status-interrupted-fg); background: var(--status-interrupted-bg); border-color: var(--status-interrupted-border); }
[data-visual-role="failure"], .semantic-failure, .safety-step-failed, [data-safety-state="failed"] { color: var(--status-failure-fg); background: var(--status-failure-bg); border-color: var(--status-failure-border); }
[data-visual-role="danger"], .semantic-danger, .danger { color: var(--status-danger-fg); background: var(--status-danger-bg); border-color: var(--status-danger-border); }
[data-visual-role="neutral"], .semantic-neutral, .safety-step-pending, [data-safety-state="pending"] { color: var(--status-neutral-fg); background: var(--status-neutral-bg); border-color: var(--status-neutral-border); }
.safety-rail, .job-safety-rail { display: grid; gap: var(--space-4); margin: var(--space-5) 0; padding: var(--space-5); border: var(--border-thin) solid var(--panel-peak-border); border-radius: var(--radius-lg); background: var(--surface-raised); box-shadow: var(--shadow-peak); }
.safety-rail-list, .job-safety-rail ol { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
.safety-step, .job-safety-step { min-width: 0; display: grid; gap: var(--space-2); align-content: start; padding: var(--space-3); border: var(--border-thin) solid var(--divider); border-radius: var(--radius-md); background: var(--surface-quiet); }
.safety-step-name, .safety-step-state { font-size: var(--type-meta); font-weight: var(--weight-semibold); }
.safety-step-evidence, .safety-step-detail { color: var(--text-muted); font-size: var(--type-meta); }
.safety-step[aria-current="step"], .job-safety-step[aria-current="step"] { border-color: var(--status-progress-border); box-shadow: inset 0 0 0 var(--border-strong) var(--status-progress-border); }
.outcome-banner, .job-outcome-banner, .recovery-advice { display: grid; gap: var(--space-2); padding: var(--space-4); border: var(--border-thin) solid var(--divider); border-radius: var(--radius-md); background: var(--surface-panel); }
.outcome-success, .job-outcome-success .outcome-banner { color: var(--status-success-fg); background: var(--status-success-bg); border-color: var(--status-success-border); }
.outcome-failure, .job-outcome-failure .outcome-banner { color: var(--status-failure-fg); background: var(--status-failure-bg); border-color: var(--status-failure-border); }
.outcome-stopped, .job-outcome-stopped .outcome-banner { color: var(--status-cancelled-fg); background: var(--status-cancelled-bg); border-color: var(--status-cancelled-border); }
.recovery-recommendation, .recovery-kind { color: var(--status-warning-fg); font-weight: var(--weight-semibold); }
.attention-reason, [data-attention-reason] { display: inline-flex; gap: var(--space-2); align-items: center; color: var(--status-warning-fg); background: var(--status-warning-bg); border: var(--border-thin) solid var(--status-warning-border); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); font-size: var(--type-meta); font-weight: var(--weight-semibold); }
.event-category, [data-event-kind], [data-visual-role="event"] { color: var(--status-neutral-fg); background: var(--status-neutral-bg); border-color: var(--status-neutral-border); }
.event-category-reasoning, [data-event-kind="reasoning"] { color: var(--event-reasoning); border-color: var(--event-reasoning); }
.event-category-text, [data-event-kind="text"] { color: var(--event-text); border-color: var(--event-text); }
.event-category-tool, [data-event-kind="tool"] { color: var(--event-tool); border-color: var(--event-tool); }

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

/* OpenCode agent editor: the repository-local draft surfaced by Configure.
   Field errors stay beside the control and the focusable summary announces
   every refusal in the card that owns the draft. */
.agent-editor { display: grid; gap: var(--space-4); background: var(--surface-panel);
  border: var(--border-thin) solid var(--divider); border-radius: var(--radius-md); padding: var(--space-4); }
.agent-editor-head { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.agent-editor-head h4, .agent-editor-head h5 { margin: 0; }
.agent-editor-head .actions { margin-left: auto; }
.agent-card { display: grid; gap: var(--space-3); background: var(--surface-quiet);
  border: var(--border-thin) solid var(--divider); border-radius: var(--radius-md); padding: var(--space-4); }
.agent-card h5 { margin: 0; }
.agent-field { display: grid; gap: var(--space-1); }
.agent-field > label { font-size: var(--type-meta); font-weight: var(--weight-semibold); color: var(--text-secondary); }
.agent-field input[type="text"], .agent-field textarea { width: 100%; min-width: 0; }
.agent-model-field select, .agent-model-field input { width: 100%; min-width: 0; }
.agent-field textarea { min-height: 4rem; font-family: var(--font-mono); font-size: var(--type-meta); resize: vertical; }
.agent-field input[type="number"] { max-width: 10rem; }
.agent-permissions { display: flex; gap: var(--space-4); flex-wrap: wrap; align-items: center; }
.agent-permissions label { font-weight: var(--weight-regular); }
.agent-field-error { color: var(--status-failure-fg); font-size: var(--type-meta); }
.agent-error-summary, .agent-notice { margin: 0 0 var(--space-3); padding: var(--space-3) var(--space-4);
  border: var(--border-thin) solid var(--status-failure-border);
  border-radius: var(--radius-sm); background: var(--status-failure-bg); color: var(--status-failure-fg);
  font-size: var(--type-meta); }
.agent-error-summary ul { margin: var(--space-2) 0 0; padding-left: var(--space-5); }
.agent-notice { border-color: var(--status-warning-border); background: var(--status-warning-bg); color: var(--status-warning-fg); }
.agent-feedback { min-height: 1.4rem; font-size: var(--type-meta); color: var(--text-muted); }
.agent-feedback.is-error { color: var(--status-failure-fg); }
.agent-feedback.is-success { color: var(--status-success-fg); }
.agent-actions { display: flex; gap: var(--space-3); flex-wrap: wrap; align-items: center; }
.agent-review { display: grid; gap: var(--space-2); }
.agent-review-row { display: grid; grid-template-columns: minmax(7rem, 20%) minmax(0, 1fr); gap: var(--space-3);
  align-items: baseline; padding: var(--space-2) 0; border-bottom: var(--border-thin) solid var(--divider); }
.agent-review-row:last-child { border-bottom: 0; }
.agent-review-label { color: var(--text-muted); font-size: var(--type-caption); font-weight: var(--weight-bold);
  text-transform: uppercase; letter-spacing: .05em; }
.agent-review-copy { display: grid; gap: var(--space-2); }
.agent-chip-row { display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: baseline; }
.agent-saved-note { margin: 0; }

/* Run with agent: the repository-scoped primary-source draft. A deliberate
   native select plus Apply/Cancel, kept visually distinct from the model and
   executor pickers so an operator can tell what an apply will change. */
.repo-primary-source { display: grid; min-width: 0; gap: var(--space-3); background: var(--surface-quiet);
  border: var(--border-thin) solid var(--divider); border-radius: var(--radius-md); padding: var(--space-4); }
.repo-primary-source h4 { margin: 0; }
.opencode-selection-controls { display: flex; gap: var(--space-4); flex-wrap: wrap; align-items: end; }
.opencode-selection-controls label { display: grid; min-width: 0; width: min(14rem, 100%); gap: var(--space-1); font-size: var(--type-meta);
  font-weight: var(--weight-semibold); color: var(--text-secondary); }
.opencode-selection-controls select { min-width: 0; width: 100%; max-width: 100%; }
.opencode-selection-managed { display: inline-flex; min-width: 0; max-width: 100%; flex-wrap: wrap; gap: var(--space-2); align-items: center;
  color: var(--text-muted); font-size: var(--type-meta); }
.opencode-selection-description { color: var(--text-muted); font-size: var(--type-meta); }
.opencode-selection-saved { margin: 0; }
.opencode-selection-actions { display: flex; gap: var(--space-3); flex-wrap: wrap; align-items: center; }

/* Agent workflow: the one prominent per-repository summary (design D1). The
   status sentence, the new-jobs line and the historical launch line stay
   visible without opening any details; the amber inactive state uses the
   existing semantic warning tokens and is readable from text alone. */
.repo-opencode-workflow { display: grid; gap: var(--space-2); background: var(--surface-panel);
  border: var(--border-thin) solid var(--divider); border-radius: var(--radius-md); padding: var(--space-4); }
.repo-opencode-workflow h4 { margin: 0; }
.repo-opencode-workflow .workflow-status { margin: 0; color: var(--text-secondary); font-size: var(--type-control); }
.repo-opencode-workflow .workflow-status strong { text-transform: uppercase; letter-spacing: .04em; }
.repo-opencode-workflow .workflow-notice { margin: 0; color: var(--text-secondary); }
.repo-opencode-workflow .workflow-detail { margin: 0; color: var(--text-muted); font-size: var(--type-meta); overflow-wrap: anywhere; }
.repo-opencode-workflow .workflow-actions { display: flex; gap: var(--space-3); flex-wrap: wrap; align-items: center; }
.repo-opencode-workflow.is-inactive { border-color: var(--status-warning-border);
  background: var(--status-warning-bg); }
.repo-opencode-workflow.is-inactive .workflow-status strong { color: var(--status-warning-fg); }
.repo-opencode-workflow.is-inactive .workflow-status,
.repo-opencode-workflow.is-inactive .workflow-notice { color: var(--status-warning-fg); }
.agent-consequence { margin: var(--space-2) 0 0; font-size: var(--type-meta); color: var(--text-muted); }
/* Conditional controls must stay absent even when component rules use grid or
   flex display. The hidden attribute describes state, not just decoration. */
.repo-primary-source [hidden], .repo-primary-source .opencode-selection-controls [hidden],
.repo-opencode-workflow [hidden], .agent-editor [hidden] { display: none; }

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
.kv { gap: 0 var(--space-6); grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr)); }
.attempt .kv { grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr)); }
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
  .safety-rail-list, .job-safety-rail ol { grid-template-columns: 1fr; }
}
@media (max-width: 640px) {
  .job-actions { margin-left: 0; width: 100%; }
  .log-line { grid-template-columns: 1fr; gap: var(--space-1); }
  .log-chips { margin-left: 0; }
  .model-provider-picker label { grid-template-columns: 1fr; align-items: stretch; }
  .model-picker-meta, .model-picker-description, .model-picker-hint { grid-column: 1; }
}
@media (max-width: 420px) {
  .shell { padding-inline: var(--space-2); }
  h1, .page-title h1, .page-head h1, .job-title h1 { font-size: 1.5rem; }
  .page-head { padding: var(--space-4); }
  .actions, .job-links { align-items: stretch; flex-direction: column; }
  .actions > *, .job-links > * { max-width: 100%; }
  .stat-strip { grid-template-columns: 1fr; }
  .repo-card, .lane, .job-row { padding-inline: var(--space-2); }
  #repositories { padding: var(--space-2); }
  .repo-card[data-presentation="quiet"] { padding-inline: var(--space-2); }
  .repo-opencode-workflow, .repo-primary-source, .agent-editor, .agent-card { min-width: 0; padding: var(--space-2); }
  .repo-opencode-workflow .workflow-actions { grid-row: 3; }
  .workflow-actions > *, .opencode-selection-actions > *, .agent-actions > * { max-width: 100%; white-space: normal; }
  .agent-review-row { grid-template-columns: minmax(0, 1fr); }
  .job-row-main { flex-wrap: wrap; }
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
      scrollLeft: stream ? stream.scrollLeft : 0,
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
      if (values.length) states.set(key, [...new Set(values)].join('|'));
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
      const label = owner?.dataset.announcementLabel
        || owner?.querySelector('h1, h2, h3, a')?.textContent?.replace(/\\s+/gu, ' ').trim()
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
  // Resolve a descendant by selector, but also accept the owner itself: a
  // keyed attempt/invocation/session node can be the element the snapshot
  // points at, and querySelector never matches its own root.
  const selectWithin = (owner, selector) => {
    if (!owner) return null;
    if (typeof owner.matches === 'function' && owner.matches(selector)) return owner;
    return typeof owner.querySelector === 'function' ? owner.querySelector(selector) : null;
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
  // Scroll identity is qualified by the owning live key so repeated session
  // nodes in different attempts never share (or transfer) a position, and an
  // attempt switch cannot inherit the previous attempt's reading place.
  const scrollKeyFor = (root, el) => {
    const owner = keyedOwner(root, el);
    return (owner === root ? '' : directKey(owner)) + '::' + (el.dataset.scrollKeep || '');
  };
  const scrollState = (root) => {
    const state = {};
    root.querySelectorAll('[data-scroll-keep]').forEach((el) => {
      state[scrollKeyFor(root, el)] = {
        top: el.scrollTop,
        left: el.scrollLeft,
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
        ? selectWithin(owner, '[data-details-key="' + escapeSelector(saved.key) + '"]')
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
      const saved = state.scrolls[scrollKeyFor(root, el)];
      if (!saved) return;
      // The log panel has its own follow rule below; everything else simply
      // holds the operator's place, sticking to the bottom only if it was
      // already there. Restore the horizontal offset so a wide line stays in
      // view even when the node survives a sibling or reconnect update.
      if (el.dataset.scrollKeep === 'log') return;
      if (el.dataset.scrollKeep === 'activity' && state.activity) {
        const follow = root.querySelector('[data-activity-follow]');
        if (follow) follow.checked = state.activity.follow;
        el.scrollTop = (state.activity.follow || saved.pinned) ? el.scrollHeight : saved.top;
        if (typeof saved.left === 'number') el.scrollLeft = saved.left;
        return;
      }
      el.scrollTop = saved.pinned ? el.scrollHeight : saved.top;
      if (typeof saved.left === 'number') el.scrollLeft = saved.left;
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
      if (stream) {
        stream.scrollTop = (state.log.follow || state.log.pinned) ? stream.scrollHeight : state.log.scrollTop;
        if (typeof state.log.scrollLeft === 'number') stream.scrollLeft = state.log.scrollLeft;
      }
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
    // Prefer the stable id/name selector so a focused control survives sibling
    // insertion or a re-render that shifts its positional path; fall back to
    // the recorded path for controls without an id or name.
    const focusSelector = focus.selector
      ? (focus.selector.kind === 'name'
        ? '[name="' + escapeSelector(focus.selector.value) + '"]'
        : '#' + escapeSelector(focus.selector.value))
      : null;
    const focused = (focusSelector ? selectWithin(owner, focusSelector) : null)
      || (owner ? nodeAtPath(owner, focus.path) : null);
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
  // BEGIN_OPENCODE_AGENT_EDITOR
  /* OpenCode agent editor ---------------------------------------------------
     The repository-local draft for the managed primary and its ordered
     subagents (tasks 4.2-4.3). Clicking Configure fetches the authenticated
     full-profile route and mounts the editor inside the repository card. The
     draft is module-local state keyed by repository id: live region swaps
     re-render the persisted summary but never overwrite a draft in progress.
     Apply shows a review of names, models, and permissions; confirming posts
     one whole-profile compare-and-set save, and Cancel discards only the
     draft.  */
  const openCodePermissions = ['edit', 'shell', 'web', 'skill'];
  const openCodePermissionLabels = { edit: 'edit workspace', shell: 'run shell', web: 'browse web', skill: 'load skills' };
  const openCodePermissionPreset = (permissions) => {
    const list = Array.isArray(permissions) ? permissions : [];
    return list.length === 0 ? 'read-only' : list.map((permission) => openCodePermissionLabels[permission] || permission).join(', ');
  };
  const openCodeEscapeHtml = (value) => String(value == null ? '' : value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
  const openCodeDefaultAgent = (enabled) => ({
    id: '', description: '', instructions: '', model: '', stepLimit: '',
    enabled: enabled !== false, permissions: [],
  });
  const openCodeStepText = (value) => (value == null || value === '') ? '' : String(value);
  const openCodeDraftFromProfile = (profile) => {
    const primary = profile && profile.primary ? profile.primary : {};
    const children = profile && Array.isArray(profile.subagents) ? profile.subagents : [];
    return {
      primary: {
        id: typeof primary.id === 'string' ? primary.id : '',
        description: typeof primary.description === 'string' ? primary.description : '',
        instructions: typeof primary.instructions === 'string' ? primary.instructions : '',
        stepLimit: openCodeStepText(primary.stepLimit),
        permissions: Array.isArray(primary.permissions) ? primary.permissions.slice() : [],
      },
      subagents: children.map((child) => ({
        id: typeof child.id === 'string' ? child.id : '',
        description: typeof child.description === 'string' ? child.description : '',
        instructions: typeof child.instructions === 'string' ? child.instructions : '',
        model: typeof child.model === 'string' ? child.model : '',
        stepLimit: openCodeStepText(child.stepLimit),
        enabled: child.enabled !== false,
        permissions: Array.isArray(child.permissions) ? child.permissions.slice() : [],
      })),
    };
  };
  const openCodeAgentPart = (item) => {
    const part = { id: item.id, description: item.description, permissions: item.permissions.slice() };
    if (item.instructions) part.instructions = item.instructions;
    if (item.stepLimit !== '' && item.stepLimit != null) part.stepLimit = Number(item.stepLimit);
    return part;
  };
  const openCodeDraftToCandidate = (draft) => ({
    version: 1,
    primary: openCodeAgentPart(draft.primary),
    subagents: (draft.subagents || []).map((child) => {
      const part = openCodeAgentPart(child);
      part.enabled = child.enabled;
      if (child.model) part.model = child.model;
      return part;
    }),
  });
  const openCodeReviewRows = (draft, primaryModel) => {
    const model = primaryModel || 'the repository selected model';
    const rows = [{
      kind: 'primary', id: draft.primary.id || '(unnamed primary)',
      description: draft.primary.description, status: 'primary agent',
      model: model, permissions: openCodePermissionPreset(draft.primary.permissions),
      stepLimit: draft.primary.stepLimit === '' ? '' : String(draft.primary.stepLimit),
    }];
    (draft.subagents || []).forEach((child) => {
      rows.push({
        kind: 'subagent', id: child.id || '(unnamed subagent)',
        description: child.description,
        status: child.enabled ? 'callable' : 'disabled',
        model: child.model || 'inherits ' + model,
        permissions: openCodePermissionPreset(child.permissions),
        stepLimit: child.stepLimit === '' ? '' : String(child.stepLimit),
      });
    });
    return rows;
  };
  const openCodeFieldLocation = (path) => {
    const value = String(path || '');
    const primary = value.match(/^primary\\.(.+)$/u);
    if (primary) return { level: 'primary', field: primary[1] };
    const child = value.match(/^subagents\\[(\\d+)\\](?:\\.(.*))?$/u);
    if (child) return { level: 'subagent', index: Number(child[1]), field: child[2] || '' };
    return { level: 'profile', field: '' };
  };
  const openCodeErrorAt = (state, path) => {
    const issues = state.errors || [];
    const prefix = path + '[';
    for (let i = 0; i < issues.length; i += 1) {
      const issue = issues[i];
      const issuePath = issue && issue.path ? String(issue.path) : '';
      if (issuePath === path || issuePath.indexOf(prefix) === 0) return issue.message;
    }
    return '';
  };
  const openCodeEditors = new Map();
  const openCodeIdBase = (repoId, agentKey, index) =>
    'agents-' + String(repoId) + '-' + agentKey + (index === null || index === undefined ? '' : '-' + String(index));
  const openCodeFieldHtml = (repoId, state, agentKey, index, path, kind, label, value, placeholder) => {
    const id = openCodeIdBase(repoId, agentKey, index) + '-' + String(path.split('.').pop() || 'field');
    const error = openCodeErrorAt(state, path);
    const invalid = error ? ' aria-invalid="true"' : '';
    const describedBy = error ? ' aria-describedby="' + id + '-error"' : '';
    const placeholderAttr = placeholder ? ' placeholder="' + openCodeEscapeHtml(placeholder) + '"' : '';
    const control = kind === 'textarea'
      ? '<textarea id="' + id + '" data-agent-field="' + path + '"' + invalid + describedBy + placeholderAttr + '>' + openCodeEscapeHtml(value) + '</textarea>'
      : '<input type="' + (kind || 'text') + '" id="' + id + '" data-agent-field="' + path + '"' + invalid + describedBy + placeholderAttr + ' value="' + openCodeEscapeHtml(value) + '"' + (kind === 'number' ? ' min="1" step="1" inputmode="numeric"' : '') + '>';
    const errorSlot = error ? '<small class="agent-field-error" id="' + id + '-error">' + openCodeEscapeHtml(error) + '</small>' : '';
    return '<div class="agent-field"><label for="' + id + '">' + openCodeEscapeHtml(label) + '</label>' + control + errorSlot + '</div>';
  };
  const openCodePermissionCheckboxes = (repoId, state, agentKey, index, path, permissions, enabled) => {
    const id = openCodeIdBase(repoId, agentKey, index) + '-permissions';
    const error = openCodeErrorAt(state, path);
    const boxes = openCodePermissions.map((permission) => {
      const checked = permissions.indexOf(permission) !== -1;
      return '<label><input type="checkbox" data-agent-checkbox="' + path + '.' + permission + '"' + (checked ? ' checked' : '') + (enabled === false ? ' disabled' : '') + '> ' + openCodeEscapeHtml(openCodePermissionLabels[permission] || permission) + '</label>';
    }).join('');
    const errorSlot = error ? '<small class="agent-field-error" id="' + id + '-error">' + openCodeEscapeHtml(error) + '</small>' : '';
    return '<fieldset class="agent-field" id="' + id + '"><legend>' + (enabled === false ? 'Tools (the agent is disabled)' : 'Tools') + '</legend><span class="agent-permissions">' + boxes + '</span>' + errorSlot + '</fieldset>';
  };
  const openCodeModelProviders = (state) => {
    const providers = state && Array.isArray(state.modelProviders) ? state.modelProviders : [];
    if (providers.length) return providers;
    // Reuse the OpenCode choices already rendered for this repository's model
    // picker. They remain in the DOM even when that picker is hidden for a
    // custom repository provider.
    const card = state && state.container && typeof state.container.closest === 'function'
      ? state.container.closest('[data-live-key^="repository-"]') : null;
    const select = card && typeof card.querySelector === 'function'
      ? card.querySelector('[data-repo-model-select]') : null;
    if (!select || typeof select.querySelectorAll !== 'function') return [];
    return [...select.querySelectorAll('optgroup')].map((group) => ({
      id: group.label || 'OpenCode models',
      name: group.label || 'OpenCode models',
      models: [...group.querySelectorAll('option')].map((option) => ({
        id: option.value,
        name: option.dataset.modelName || option.textContent || option.value,
      })),
    }));
  };
  const openCodeModelPickerHtml = (repoId, state, index, model) => {
    const path = 'subagents[' + String(index) + '].model';
    const id = openCodeIdBase(repoId, 'sub', index) + '-model';
    const customId = id + '-custom';
    const providers = openCodeModelProviders(state);
    const knownModel = providers.some((provider) =>
      Array.isArray(provider.models) && provider.models.some((entry) => entry.id === model));
    const custom = Boolean(model) && !knownModel;
    const modelOptions = providers.map((provider) => {
      const options = (Array.isArray(provider.models) ? provider.models : []).map((entry) =>
        '<option value="' + openCodeEscapeHtml(entry.id) + '"' + (entry.id === model ? ' selected' : '') + '>' +
        openCodeEscapeHtml(entry.name || entry.id) + '</option>').join('');
      return options
        ? '<optgroup label="' + openCodeEscapeHtml(provider.name || provider.id) + '">' + options + '</optgroup>'
        : '';
    }).join('');
    const error = openCodeErrorAt(state, path);
    const invalid = error ? ' aria-invalid="true"' : '';
    const describedBy = error ? ' aria-describedby="' + id + '-error"' : '';
    const errorSlot = error ? '<small class="agent-field-error" id="' + id + '-error">' + openCodeEscapeHtml(error) + '</small>' : '';
    return '<div class="agent-field agent-model-field">' +
      '<label for="' + id + '">Model override</label>' +
      '<select id="' + id + '" data-agent-model="' + path + '"' + invalid + describedBy + '>' +
      '<option value=""' + (!model ? ' selected' : '') + '>Inherit repository model</option>' +
      modelOptions +
      '<option value="__custom__"' + (custom ? ' selected' : '') + '>Custom model ID…</option>' +
      '</select>' +
      '<label for="' + customId + '" data-agent-custom-label="' + path + '"' + (custom ? '' : ' hidden') + '>Custom model ID</label>' +
      '<input type="text" id="' + customId + '" data-agent-field="' + path + '" value="' + openCodeEscapeHtml(custom ? model : '') + '" placeholder="provider/model[#variant]"' + invalid + describedBy + (custom ? '' : ' hidden') + '>' +
      '<small class="muted">Leave inherited, choose a catalog model, or enter a custom provider/model id.</small>' + errorSlot +
      '</div>';
  };
  const openCodeSubagentHtml = (repoId, state, index, child) => {
    const prefix = 'subagents[' + String(index) + ']';
    return '<article class="agent-card agent-subagent" data-live-key="agent-sub-' + String(index) + '">' +
      '<div class="agent-editor-head"><h5>Subagent ' + String(index + 1) + '</h5>' +
      '<span class="chip">' + (child.enabled ? 'callable' : 'disabled') + '</span>' +
      '<span class="actions"><button type="button" class="danger" data-agent-action="remove" data-agent-index="' + String(index) + '">Remove</button></span></div>' +
      openCodeFieldHtml(repoId, state, 'sub', index, prefix + '.id', 'text', 'Agent id', child.id, 'reviewer') +
      openCodeFieldHtml(repoId, state, 'sub', index, prefix + '.description', 'text', 'Purpose', child.description, 'What this child does') +
      openCodeFieldHtml(repoId, state, 'sub', index, prefix + '.instructions', 'textarea', 'Instructions', child.instructions, 'Optional private instructions for this child') +
      openCodeModelPickerHtml(repoId, state, index, child.model) +
      openCodeFieldHtml(repoId, state, 'sub', index, prefix + '.stepLimit', 'number', 'Step limit', child.stepLimit, null) +
      '<label class="agent-field agent-enable"><input type="checkbox" data-agent-checkbox="' + prefix + '.enabled"' + (child.enabled ? ' checked' : '') + '> Callable by the primary</label>' +
      openCodePermissionCheckboxes(repoId, state, 'sub', index, prefix + '.permissions', child.permissions, child.enabled) +
      '</article>';
  };
  const openCodePrimaryHtml = (repoId, state) => {
    const prefix = 'primary';
    return '<article class="agent-card"><div class="agent-editor-head"><h5>Primary agent</h5><span class="chip">runs the repository selected model</span></div>' +
      openCodeFieldHtml(repoId, state, 'primary', null, prefix + '.id', 'text', 'Agent id', state.draft.primary.id, 'primary') +
      openCodeFieldHtml(repoId, state, 'primary', null, prefix + '.description', 'textarea', 'Purpose', state.draft.primary.description, 'What the primary does') +
      openCodeFieldHtml(repoId, state, 'primary', null, prefix + '.instructions', 'textarea', 'Instructions', state.draft.primary.instructions, 'Optional private instructions') +
      openCodeFieldHtml(repoId, state, 'primary', null, prefix + '.stepLimit', 'number', 'Step limit', state.draft.primary.stepLimit, null) +
      openCodePermissionCheckboxes(repoId, state, 'primary', null, prefix + '.permissions', state.draft.primary.permissions, true) +
      '</article>';
  };
  const openCodeErrorsSummary = (state) => {
    const issues = state.errors || [];
    if (issues.length === 0) return '';
    return '<div class="agent-error-summary" data-agent-summary tabindex="-1" role="alert"><strong>The agent team was not saved.</strong><ul>' +
      issues.map((issue) => '<li><code>' + openCodeEscapeHtml(issue && issue.path ? issue.path : 'agent team') + '</code>: ' + openCodeEscapeHtml(issue && issue.message ? issue.message : 'invalid value') + '</li>').join('') +
      '</ul></div>';
  };
  const openCodeNoticeHtml = (state) =>
    state.notice ? '<div class="agent-notice" data-agent-notice tabindex="-1" role="alert">' + openCodeEscapeHtml(state.notice) + '</div>' : '';
  const openCodeReviewHtml = (repoId, state) => {
    const primaryModel = openCodePrimaryModelOf(state.container, state.repoModel);
    const rows = openCodeReviewRows(state.draft, primaryModel).map((row) => {
      const chips = '<span class="agent-chip-row"><span class="chip">' + openCodeEscapeHtml(row.status) + '</span><span class="chip">model: ' + openCodeEscapeHtml(row.model) + '</span><span class="chip">tools: ' + openCodeEscapeHtml(row.permissions) + '</span>' + (row.stepLimit === '' ? '' : '<span class="chip">step limit ' + openCodeEscapeHtml(row.stepLimit) + '</span>') + '</span>';
      const description = row.description
        ? '<small class="muted">' + openCodeEscapeHtml(row.description) + '</small>'
        : '';
      return '<div class="agent-review-row"><span class="agent-review-label"><code>' + openCodeEscapeHtml(row.id) + '</code></span><div class="agent-review-copy">' + chips + description + '</div></div>';
    }).join('');
    return '<section class="agent-review" aria-label="Review the OpenCode agent team">' +
      '<h4 class="sr-only" data-agent-review-heading tabindex="-1">Review the OpenCode agent team</h4>' +
      '<p class="muted">The primary runs the repository selected model; children inherit it unless they carry an explicit override. Only enabled children are callable. Applied profiles govern jobs created after the save; existing jobs keep the team recorded when they were created.</p>' +
      rows + '</section>';
  };
  // END_OPENCODE_AGENT_EDITOR
  const openCodePrimaryModelOf = (container, fallback) => {
    const card = container && typeof container.closest === 'function'
      ? container.closest('[data-live-key^="repository-"]') : null;
    const picker = card && typeof card.querySelector === 'function'
      ? card.querySelector('[data-repo-picker]') : null;
    const model = picker && picker.dataset && picker.dataset.savedModel ? picker.dataset.savedModel : '';
    return model || fallback || '';
  };
  const openCodeWorkflowNodeOf = (container) => {
    const card = container && typeof container.closest === 'function'
      ? container.closest('[data-live-key^="repository-"]') : null;
    return card && typeof card.querySelector === 'function'
      ? card.querySelector('[data-opencode-workflow]') : null;
  };
  const openCodeWorkflowStateOf = (container) => {
    const workflow = openCodeWorkflowNodeOf(container);
    const state = workflow && workflow.dataset ? workflow.dataset.teamState : null;
    return state || '';
  };
  const openCodeWorkflowSelectionRevisionOf = (container) => {
    const workflow = openCodeWorkflowNodeOf(container);
    const raw = workflow && workflow.dataset ? workflow.dataset.selectionRevision : '';
    return raw === undefined || raw === '' ? null : Number(raw);
  };
  const openCodeCanRecover = (response, payload) => response.status === 422
    && payload.error === 'opencode-profile-corrupt' && payload.recovery === true
    && Number.isInteger(payload.revision) && payload.revision >= 0
    && Number.isInteger(payload.selectionRevision) && payload.selectionRevision >= 0
    && payload.selection && ['default', 'native', 'managed'].includes(payload.selection.source)
    && Boolean(payload.defaultProfile && payload.defaultProfile.primary);
  const openCodeEditorHtml = (repoId, state) => {
    const recoveryWarning = state.recovering
      ? '<p class="agent-notice" role="alert">The saved team is corrupt and cannot be read. This replacement draft starts from the default workflow. Nothing changes until you review and confirm replacement. Replacing discards the corrupt definition; existing jobs and retries keep their recorded team.</p>'
      : '';
    const revisionNote = state.revision > 0
      ? '<span class="chip">draft from revision ' + String(state.revision) + '</span>'
      : '<span class="chip">no saved profile</span>';
    const feedback = '<p class="agent-feedback" data-agent-feedback role="status" aria-live="polite"></p>';
    const resetButton = state.defaultProfile
      ? '<button type="button" data-agent-action="reset">Reset to default workflow</button>'
      : '';
    if (state.mode === 'review') {
      // The review names the chosen operation and what it does to new jobs
      // (save-only keeps the current source; save-and-activate commits this
      // reviewed profile as managed). An active team only offers save, and its
      // consequence is spelled out because saving changes what new jobs capture.
      const consequence = state.recovering && state.activeSaved
        ? 'Replacing repairs the selected managed team. Newly created jobs use the replacement revision; existing jobs and retries keep their recorded team.'
        : state.activeSaved
        ? 'Saving updates the active team this repository already uses. Newly created managed jobs capture the new revision, and existing jobs and retries keep the team recorded when they were created.'
        : state.recovering
          ? 'Replace team overwrites the corrupt definition without changing the selected source; the replacement stays inactive. Replace and activate overwrites it and selects this reviewed team for new jobs.'
          : 'Save team persists the reviewed profile without changing what new jobs use, so the team stays inactive. Save and activate commits this same profile and makes it control new managed jobs.';
      const busy = state.busy ? ' disabled' : '';
      const locked = state.busy || state.needReload === true;
      // A stale-baseline conflict keeps the draft and the operation intent and
      // disables both submit paths until the operator explicitly reloads
      // baselines, so a submission never auto-retries the stale pair.
      const submitDisabled = locked ? ' disabled' : '';
      const saveLabel = state.busy ? 'Working…' : state.recovering ? 'Replace team' : 'Save team';
      const activateButton = state.activeSaved
        ? ''
        : '<button type="button" class="primary" data-agent-action="save-and-activate"' + submitDisabled + '>' + (state.busy ? 'Working…' : state.recovering ? 'Replace and activate' : 'Save and activate') + '</button>';
      // Reload baselines fetches the newer stored state (coherent GET) and
      // advances only the CAS baselines, never replacing the draft.
      const reloadButton = state.needReload
        ? '<button type="button" data-agent-action="reload-baselines"' + busy + '>Reload baselines</button>'
        : '';
      return '<div class="agent-editor" data-agent-editor data-repo-id="' + String(repoId) + '">' +
        '<div class="agent-editor-head"><h4>Review OpenCode agents</h4>' + revisionNote +
        '<span class="actions"><button type="button" data-agent-action="back"' + busy + '>Keep editing</button><button type="button" class="danger" data-agent-action="cancel"' + busy + '>Cancel</button></span></div>' +
        recoveryWarning + (openCodeErrorsSummary(state) || openCodeNoticeHtml(state)) + feedback +
        openCodeReviewHtml(repoId, state) +
        '<div class="agent-actions"><button type="button" data-agent-action="save"' + submitDisabled + '>' + saveLabel + '</button>' + activateButton + reloadButton + '</div>' +
        '<p class="agent-consequence muted">' + openCodeEscapeHtml(consequence) + '</p></div>';
    }
    // A busy save/reload cannot be interrupted mid-flight: discarding the
    // draft through Cancel, or another Review-and-apply, would orphan the
    // in-flight operation, so those controls stay disabled until it settles.
    const editingLocked = state.busy ? ' disabled' : '';
    const children = state.draft.subagents.length === 0
      ? '<p class="muted">No subagents yet. Add one to let the primary delegate a focused task.</p>'
      : state.draft.subagents.map((child, index) => openCodeSubagentHtml(repoId, state, index, child)).join('');
    return '<div class="agent-editor" data-agent-editor data-repo-id="' + String(repoId) + '">' +
      '<div class="agent-editor-head"><h4>Configure OpenCode agents</h4>' + revisionNote +
      '<span class="actions">' + resetButton + '<button type="button" class="danger" data-agent-action="cancel"' + editingLocked + '>Cancel</button></span></div>' +
      '<p class="muted">Reset loads the shared starter workflow into this draft; nothing changes until you review and save. The primary runs the repository selected model; children inherit it unless they carry an explicit provider/model override. Children default to read-only; external-directory access and nested delegation are always denied. Changes apply to jobs created after the save.</p>' +
      recoveryWarning + (openCodeErrorsSummary(state) || openCodeNoticeHtml(state)) + feedback +
      openCodePrimaryHtml(repoId, state) +
      '<section class="agent-card"><div class="agent-editor-head"><h5>Subagents</h5><span class="actions"><button type="button" data-agent-action="add"' + editingLocked + '>Add subagent</button></span></div>' +
      children + '</section>' +
      '<div class="agent-actions"><button type="button" class="primary" data-agent-action="apply"' + editingLocked + '>Review and apply</button><button type="button" data-agent-action="cancel"' + editingLocked + '>Cancel</button></div></div>';
  };
  const openCodeFocusSummary = (container) => {
    if (!container || typeof container.querySelector !== 'function') return;
    const summary = container.querySelector('[data-agent-summary]') || container.querySelector('[data-agent-notice]');
    if (summary && typeof summary.focus === 'function') summary.focus({ preventScroll: true });
  };
  const openCodeRenderEditor = (container, repoId) => {
    const state = openCodeEditors.get(repoId);
    if (!state || !container) return;
    state.container = container;
    if (typeof container.querySelector === 'function' && !container.querySelector('[data-agent-editor]')) {
      state.summaryHtml = container.innerHTML;
    }
    container.innerHTML = openCodeEditorHtml(repoId, state);
  };
  const openCodeMountEditor = async (container, repoId) => {
    const previousHtml = container.innerHTML;
    container.innerHTML = '<p class="muted">Opening the agent editor…</p>';
    try {
      const response = await fetch('/repos/' + String(repoId) + '/opencode-profile');
      const payload = await response.json().catch(() => ({}));
      if (openCodeSessionExpiry(response, payload)) return;
      const recovering = openCodeCanRecover(response, payload);
      if (!response.ok && !recovering) {
        container.innerHTML = '<p class="agent-notice" role="alert">The saved agent profile could not be opened (status ' + String(response.status) + ').</p>';
        return;
      }
      const mounted = typeof document !== 'undefined' && typeof document.querySelector === 'function'
        ? document.querySelector('[data-opencode-agents][data-repo-id="' + String(repoId) + '"]') : container;
      if (!mounted) return;
      const model = openCodePrimaryModelOf(mounted, '');
      // The editor GET carries safe selection context: the retained source,
      // both revision counters and whether the saved team already controls new
      // jobs. The selection baseline freezes at review time so save-and-activate
      // submits exactly the pair the operator saw.
      const workflowSelectionRevision = openCodeWorkflowSelectionRevisionOf(mounted);
      const selectionRevision = typeof payload.selectionRevision === 'number'
        ? payload.selectionRevision
        : (workflowSelectionRevision === null ? 0 : workflowSelectionRevision);
      // The editor GET's active flag is authoritative. Only a response that
      // predates the field may fall back to the rendered workflow state, so a
      // stale active-managed fragment can never override an explicit false.
      const activeSaved = recovering ? payload.selection.source === 'managed' : typeof payload.active === 'boolean'
        ? payload.active
        : openCodeWorkflowStateOf(mounted) === 'active-managed';
      const state = {
        mode: 'editing',
        revision: typeof payload.revision === 'number' ? payload.revision : 0,
        draft: openCodeDraftFromProfile(payload.profile || payload.defaultProfile),
        defaultProfile: payload.defaultProfile || null,
        modelProviders: [],
        errors: [],
        notice: null,
        busy: false,
        summaryHtml: mounted === container ? previousHtml : mounted.innerHTML,
        repoModel: model,
        operation: 'save',
        baseSelectionRevision: selectionRevision,
        selectionRevision,
        activeSaved,
        recovering,
        container: mounted,
      };
      state.modelProviders = openCodeModelProviders(state);
      openCodeEditors.set(repoId, state);
      openCodeRenderEditor(mounted, repoId);
    } catch {
      container.innerHTML = '<p class="agent-notice" role="alert">The saved agent profile could not be opened.</p>';
    }
  };
  const openCodeCancel = (repoId) => {
    const state = openCodeEditors.get(repoId);
    if (!state || state.busy) return;
    const container = state.container;
    const summaryHtml = state.summaryHtml || '';
    openCodeEditors.delete(repoId);
    if (container) {
      container.innerHTML = summaryHtml || '<p class="muted">Agent team editor closed.</p>';
      const configure = typeof container.querySelector === 'function' ? container.querySelector('[data-repo-agents-configure]') : null;
      if (configure && typeof configure.focus === 'function') configure.focus({ preventScroll: true });
    }
  };
  const openCodeSetFeedback = (container, message, error) => {
    const node = container && typeof container.querySelector === 'function' ? container.querySelector('[data-agent-feedback]') : null;
    if (!node) return;
    node.textContent = message;
    node.classList.toggle('is-error', Boolean(error));
    node.classList.toggle('is-success', !error);
    node.setAttribute('role', error ? 'alert' : 'status');
    node.setAttribute('aria-live', error ? 'assertive' : 'polite');
  };
  const openCodeErrorMessage = (payload) => {
    const messages = {
      'invalid-request': 'The submitted agent team was malformed; nothing was saved.',
      'repository-not-found': 'This repository is no longer available.',
      'not-opencode': 'This repository does not run the OpenCode executor, so its agent team cannot be saved here.',
      'conflict': 'The stored agent team changed in another session; the draft was kept.',
    };
    return messages[payload && payload.error] || 'The agent team was not accepted. Try again.';
  };
  const openCodeSessionExpiry = (response, payload) => {
    if (response.status !== 401 || (payload && payload.error) !== 'session-expired') return false;
    if (typeof window !== 'undefined' && window.location) window.location.assign('/auth?reason=expired');
    return true;
  };
  const openCodeSave = async (repoId, operation) => {
    const state = openCodeEditors.get(repoId);
    if (!state || state.busy) return;
    if (state.needReload === true) {
      // The stale-baseline conflict is still unresolved: submissions stay
      // disabled until the operator explicitly reloads baselines and re-reviews.
      state.notice = 'Conflict unresolved. Reload baselines to review the newer stored state before saving again.';
      state.errors = [];
      openCodeRenderEditor(state.container, repoId);
      openCodeFocusSummary(state.container);
      return;
    }
    const mode = operation === 'save-and-activate' ? 'save-and-activate' : 'save';
    const currentContainer = () => state.container;
    const candidate = openCodeDraftToCandidate(state.draft);
    state.busy = true;
    state.errors = [];
    state.notice = null;
    state.operation = mode;
    openCodeRenderEditor(currentContainer(), repoId);
    openCodeSetFeedback(currentContainer(), mode === 'save-and-activate' ? 'Saving and activating the agent team…' : 'Saving the agent team…', false);
    try {
      // Save-only validates and persists the reviewed candidate without
      // touching the primary source. Save-and-activate commits the candidate
      // and managed source as one checked operation ('profile' carries the
      // reviewed candidate; both baseline revisions are submitted).
      const endpoint = mode === 'save-and-activate'
        ? '/repos/' + String(repoId) + '/opencode-team-activation'
        : '/repos/' + String(repoId) + '/opencode-profile';
      const body = mode === 'save-and-activate'
        ? {
            mode: 'save-and-activate',
            expectedProfileRevision: state.revision,
            expectedSelectionRevision: state.baseSelectionRevision,
            profile: candidate,
          }
        : { expectedRevision: state.revision, candidate };
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      // Render settled refusals with usable recovery controls; clearing only
      // in finally left Reload baselines disabled until another SSE arrived.
      state.busy = false;
      if (openCodeSessionExpiry(response, payload)) return;
      if (!response.ok) {
        if (response.status === 400 && payload.error === 'validation' && Array.isArray(payload.issues)) {
          state.errors = payload.issues;
          state.mode = 'editing';
          openCodeRenderEditor(currentContainer(), repoId);
          openCodeFocusSummary(currentContainer());
          return;
        }
        if (response.status === 409) {
          const current = mode === 'save-and-activate'
            ? 'profile revision ' + String(payload.currentProfileRevision ?? '?') + ' and selection revision ' + String(payload.currentRevision ?? payload.currentSelectionRevision ?? '?')
            : 'revision ' + String(payload.currentRevision ?? '?');
          const newer = mode === 'save-and-activate'
            ? 'The stored team or primary source changed in another session (now ' + current + '). Nothing was saved. Your draft, its operation intent and your reviewed baselines were kept. Reload baselines to re-review the newer stored state before submitting again.'
            : 'The stored agent team changed in another session (now ' + current + '). Your draft was kept; saving again would overwrite that newer team. Reload baselines to review the newer stored state, or cancel this draft.';
          state.notice = newer;
          state.needReload = true;
          state.errors = [];
          openCodeRenderEditor(currentContainer(), repoId);
          openCodeFocusSummary(currentContainer());
          return;
        }
        if (mode === 'save-and-activate' && response.status === 422) {
          state.notice = 'The stored team cannot be read; open the editor to repair it. Nothing was saved.';
          state.errors = [];
          openCodeRenderEditor(currentContainer(), repoId);
          openCodeFocusSummary(currentContainer());
          return;
        }
        state.errors = [{ path: '', message: openCodeErrorMessage(payload) }];
        openCodeRenderEditor(currentContainer(), repoId);
        openCodeFocusSummary(currentContainer());
        return;
      }
      openCodeEditors.delete(repoId);
      const mounted = currentContainer();
      if (!mounted) return;
      const savedRevision = typeof payload.profileRevision === 'number' ? String(payload.profileRevision)
        : typeof payload.revision === 'number' ? String(payload.revision)
          : String(state.revision + 1);
      // The backend captures the resulting state in the same transaction; its
      // 'active' boolean is authoritative. Never OR in a cached mount-time state
      // (the source may have switched away while the operator edited).
      const activeNow = payload.active === true;
      const refreshFailed = payload.refreshError === 'notification-failed' || payload.notification === 'failed';
      const refreshNote = refreshFailed
        ? ' The change is committed, but the live settings refresh failed; reload the dashboard to confirm.'
        : '';
      if (mode === 'save-and-activate') {
        mounted.innerHTML = activeNow
          ? '<p class="agent-saved-note" tabindex="-1" role="status">Team active for new jobs as revision ' + savedRevision + '. Existing jobs and retries keep their recorded selection.' + refreshNote + '</p>'
          : '<p class="agent-saved-note" tabindex="-1" role="status">The team was saved as revision ' + savedRevision + ', but it is not currently selected for new jobs (the source changed alongside this operation). Existing jobs and retries keep their recorded selection.' + refreshNote + '</p>';
      } else {
        mounted.innerHTML = activeNow
          ? '<p class="agent-saved-note" tabindex="-1" role="status">Agent team saved as revision ' + savedRevision + '. Active team updated for new jobs — existing jobs and retries keep their recorded selection.' + refreshNote + '</p>'
          : '<p class="agent-saved-note" tabindex="-1" role="status">Agent team saved as revision ' + savedRevision + '. It remains inactive; activate it from the workflow summary to control new jobs.' + refreshNote + '</p>';
      }
      // The in-place note can be replaced by the next SSE fragment; also issue
      // durable scoped feedback so the reconciler keeps the meaningful outcome
      // and can restore focus through the card's own feedback node.
      if (typeof actionMessage === 'function') {
        const outcome = mode === 'save-and-activate'
          ? (activeNow ? 'Team active for new jobs. Existing jobs and retries keep their recorded selection.' : 'The team was saved but is not currently selected for new jobs.')
          : (activeNow ? 'Active team updated for new jobs.' : 'Team saved. It remains inactive.');
        actionMessage(mounted, outcome + refreshNote.trim(), false, 'opencode:' + String(repoId) + ':' + (mode === 'save-and-activate' ? 'activate' : 'save') + (activeNow ? ':active' : ':inactive'));
      }
      openCodeFocusSuccess(mounted, activeNow);
    } catch {
      state.busy = false;
      state.errors = [{ path: '', message: 'The agent team could not be saved. Try again.' }];
      openCodeRenderEditor(currentContainer(), repoId);
      openCodeFocusSummary(currentContainer());
    } finally {
      state.busy = false;
    }
  };
  const openCodeFocusSuccess = (mounted, activeNow) => {
    if (!mounted || typeof mounted.querySelector !== 'function') return;
    const card = typeof mounted.closest === 'function'
      ? mounted.closest('[data-live-key^="repository-"]') : null;
    if (!activeNow) {
      // Inactive outcome: "Activate this team" stays in the workflow summary
      // and survives later SSE swaps, so it is the stable keyboard target.
      const activate = card && typeof card.querySelector === 'function'
        ? card.querySelector('[data-opencode-activate]') : null;
      if (activate && typeof activate.focus === 'function') {
        activate.focus({ preventScroll: true });
        return;
      }
    } else {
      // Active outcome: the "Edit active team" / configure action (or the
      // Change agent link) is server-rendered, so a following SSE fragment
      // cannot drop focus to the body the way the injected note would.
      const configure = card && typeof card.querySelector === 'function'
        ? card.querySelector('[data-repo-agents-configure]') : null;
      if (configure && typeof configure.focus === 'function') {
        configure.focus({ preventScroll: true });
        return;
      }
      const change = card && typeof card.querySelector === 'function'
        ? card.querySelector('[data-opencode-change-agent]') : null;
      if (change && typeof change.focus === 'function') {
        change.focus({ preventScroll: true });
        return;
      }
    }
    const note = mounted.querySelector('[data-opencode-agents] .agent-saved-note') || mounted.querySelector('.agent-saved-note');
    if (note && typeof note.focus === 'function') note.focus({ preventScroll: true });
  };
  const openCodeReloadBaselines = async (repoId) => {
    const state = openCodeEditors.get(repoId);
    if (!state || state.busy) return;
    const mountedAt = () => state.container;
    state.busy = true;
    state.errors = [];
    openCodeSetFeedback(mountedAt(), 'Reloading stored revisions…', false);
    try {
      const response = await fetch('/repos/' + String(repoId) + '/opencode-profile', {
        headers: { 'content-type': 'application/json' },
      });
      const payload = await response.json().catch(() => ({}));
      if (openCodeSessionExpiry(response, payload)) return;
      const recovering = openCodeCanRecover(response, payload);
      if (!response.ok && !recovering) {
        state.busy = false;
        state.notice = 'The stored team could not be reloaded (status ' + String(response.status) + '). Your draft and its operation intent were kept; the conflict still requires review.';
        openCodeRenderEditor(mountedAt(), repoId);
        openCodeFocusSummary(mountedAt());
        return;
      }
      const profileRevision = typeof payload.revision === 'number' ? payload.revision : state.revision;
      const selectionRevision = typeof payload.selectionRevision === 'number' ? payload.selectionRevision : state.baseSelectionRevision;
      const primaryId = payload.profile && payload.profile.primary ? String(payload.profile.primary.id || '?') : '?';
      // The stored baselines advance to the newer committed revisions; the
      // unsaved draft fields and the operation intent are deliberately kept so
      // the operator re-reviews the same changes against the newer stored team.
      state.revision = profileRevision;
      state.baseSelectionRevision = selectionRevision;
      state.selectionRevision = selectionRevision;
      state.recovering = recovering;
      state.activeSaved = recovering ? payload.selection.source === 'managed' : payload.active === true;
      state.notice = 'Baselines reloaded from the stored team (profile revision ' + String(profileRevision) + ', selection revision ' + String(selectionRevision) + ', primary ' + primaryId + '). Your unsaved draft is intact; review it against the newer stored team, then save or activate deliberately.';
      state.needReload = false;
      state.busy = false;
      openCodeSetFeedback(mountedAt(), 'Baselines reloaded. Review the stored team against your draft before saving.', false);
      openCodeRenderEditor(mountedAt(), repoId);
      openCodeFocusSummary(mountedAt());
    } catch {
      state.busy = false;
      state.notice = 'The stored team could not be reloaded. Your draft and its operation intent were kept; the conflict still requires review.';
      openCodeRenderEditor(mountedAt(), repoId);
      openCodeFocusSummary(mountedAt());
    }
  };
  const openCodeApply = (repoId) => {
    const state = openCodeEditors.get(repoId);
    if (!state || state.busy) return;
    state.errors = [];
    state.notice = null;
    state.mode = 'review';
    openCodeRenderEditor(state.container, repoId);
    const heading = state.container && typeof state.container.querySelector === 'function' ? state.container.querySelector('[data-agent-review-heading]') : null;
    if (heading && typeof heading.focus === 'function') heading.focus({ preventScroll: true });
  };
  const openCodeBack = (repoId) => {
    const state = openCodeEditors.get(repoId);
    if (!state || state.busy) return;
    state.notice = null;
    state.mode = 'editing';
    openCodeRenderEditor(state.container, repoId);
  };
  const openCodeResetToDefault = (repoId) => {
    const state = openCodeEditors.get(repoId);
    if (!state || state.busy || !state.defaultProfile) return;
    if (typeof window !== 'undefined' && typeof window.confirm === 'function' &&
        !window.confirm('Replace this draft with the default workflow? Unsaved draft changes will be lost.')) return;
    state.draft = openCodeDraftFromProfile(state.defaultProfile);
    state.errors = [];
    state.notice = null;
    state.mode = 'editing';
    openCodeRenderEditor(state.container, repoId);
    openCodeSetFeedback(state.container, 'Default workflow loaded into this draft. Review and apply to save it.', false);
    const reset = state.container && typeof state.container.querySelector === 'function'
      ? state.container.querySelector('[data-agent-action="reset"]') : null;
    if (reset && typeof reset.focus === 'function') reset.focus({ preventScroll: true });
  };
  const openCodeHandleModelSelection = (repoId, path, value, select) => {
    const state = openCodeEditors.get(repoId);
    const location = openCodeFieldLocation(path);
    if (!state || location.level !== 'subagent' || location.field !== 'model') return;
    const child = state.draft.subagents[location.index];
    if (!child) return;
    if (value !== '__custom__') {
      child.model = value;
    } else {
      const currentIsCatalogModel = openCodeModelProviders(state).some((provider) =>
        Array.isArray(provider.models) && provider.models.some((model) => model.id === child.model));
      if (currentIsCatalogModel) child.model = '';
    }
    const editor = select && typeof select.closest === 'function' ? select.closest('[data-agent-editor]') : state.container;
    const customInput = editor && typeof editor.querySelectorAll === 'function'
      ? [...editor.querySelectorAll('[data-agent-field]')].find((field) => field.dataset.agentField === path) : null;
    const customLabel = editor && typeof editor.querySelectorAll === 'function'
      ? [...editor.querySelectorAll('[data-agent-custom-label]')].find((field) => field.dataset.agentCustomLabel === path) : null;
    const showCustom = value === '__custom__';
    if (customInput) {
      customInput.value = child.model || '';
      customInput.hidden = !showCustom;
    }
    if (customLabel) customLabel.hidden = !showCustom;
    if (showCustom && customInput && typeof customInput.focus === 'function') customInput.focus({ preventScroll: true });
  };
  const openCodeAddSubagent = (repoId) => {
    const state = openCodeEditors.get(repoId);
    if (!state) return;
    state.notice = null;
    state.mode = 'editing';
    state.draft.subagents.push(openCodeDefaultAgent(true));
    openCodeRenderEditor(state.container, repoId);
  };
  const openCodeRemoveSubagent = (repoId, index) => {
    const state = openCodeEditors.get(repoId);
    if (!state || !Number.isInteger(index)) return;
    if (!state.draft.subagents[index]) return;
    state.notice = null;
    state.mode = 'editing';
    state.draft.subagents.splice(index, 1);
    openCodeRenderEditor(state.container, repoId);
  };
  const openCodeHandleEditorInput = (repoId, path, value) => {
    const state = openCodeEditors.get(repoId);
    if (!state) return;
    const location = openCodeFieldLocation(path);
    if (location.level === 'primary' && location.field) {
      state.draft.primary[location.field] = value;
    } else if (location.level === 'subagent' && location.field) {
      const child = state.draft.subagents[location.index];
      if (child) child[location.field] = value;
    }
  };
  const openCodeHandleEditorChange = (repoId, path, checked) => {
    const state = openCodeEditors.get(repoId);
    if (!state) return;
    const permission = path.match(/^(primary|subagents\\[\\d+\\])\\.permissions\\.([a-z]+)$/u);
    if (permission) {
      const agentPath = permission[1];
      const name = permission[2];
      const agent = agentPath === 'primary'
        ? state.draft.primary
        : state.draft.subagents[Number((agentPath.match(/\\d+/u) || [])[0])];
      if (!agent) return;
      const index = agent.permissions.indexOf(name);
      if (checked && index === -1) agent.permissions.push(name);
      if (!checked && index !== -1) agent.permissions.splice(index, 1);
      agent.permissions.sort((left, right) => openCodePermissions.indexOf(left) - openCodePermissions.indexOf(right));
      return;
    }
    const enabled = path.match(/^subagents\\[(\\d+)\\]\\.enabled$/u);
    if (enabled) {
      const child = state.draft.subagents[Number(enabled[1])];
      if (child) child.enabled = checked;
    }
  };
  const captureOpenCodeEditors = () => [...openCodeEditors.entries()].map(([repoId, state]) => ({
    repoId,
    mode: state.mode,
    revision: state.revision,
    draft: state.draft,
    defaultProfile: state.defaultProfile,
    modelProviders: state.modelProviders,
    errors: state.errors.slice(),
    notice: state.notice,
    busy: state.busy,
    repoModel: state.repoModel,
    operation: state.operation,
    baseSelectionRevision: state.baseSelectionRevision,
    selectionRevision: state.selectionRevision,
    activeSaved: state.activeSaved,
    recovering: state.recovering === true,
    needReload: state.needReload === true,
  }));
  const openCodeRepositoriesRoot = (root) => {
    if (!root || typeof root.querySelector !== 'function') return false;
    // A fragment that names the repositories panel or lists repository cards is
    // authoritative for whether a repository still exists here. Health, job
    // lanes, activity and ticker fragments never render repo cards, so a
    // missing agents container there is not evidence that a draft's surface is
    // gone.
    return root.id === 'repositories'
      || Boolean(root.querySelector('[data-live-key^="repository-"]'));
  };
  const restoreOpenCodeEditors = (root, saved) => {
    if (!root || !Array.isArray(saved)) return;
    saved.forEach((entry) => {
      if (!entry || !Number.isInteger(entry.repoId)) return;
      const container = typeof root.querySelector === 'function'
        ? root.querySelector('[data-opencode-agents][data-repo-id="' + String(entry.repoId) + '"]') : null;
      if (!container) {
        // An unrelated partial region reconciling alone does not prove this
        // repository disappeared; retaining the draft is safe because any
        // later authoritative repositories fragment still re-checks it. Only
        // that authoritative root may release the entry, and only for the repo
        // whose surface/container is really gone. Other repos stay untouched.
        if (openCodeRepositoriesRoot(root)) openCodeEditors.delete(entry.repoId);
        return;
      }
      // Preserve object identity so in-flight save/reload closures keep
      // mutating the entry that the map owns: updating this same object
      // redirects their response mutations to the freshly mounted container
      // and keeps busy flags coherent instead of leaving a detached copy.
      const prior = openCodeEditors.get(entry.repoId);
      const state = prior || {};
      Object.assign(state, {
        mode: entry.mode,
        revision: entry.revision,
        draft: entry.draft,
        defaultProfile: entry.defaultProfile || null,
        modelProviders: entry.modelProviders || [],
        errors: entry.errors || [],
        notice: entry.notice,
        busy: entry.busy,
        repoModel: entry.repoModel || '',
        // The operation intent and both frozen baselines survive a live swap;
        // an SSE refresh never silently rebinds a reviewed draft.
        operation: entry.operation || 'save',
        baseSelectionRevision: typeof entry.baseSelectionRevision === 'number'
          ? entry.baseSelectionRevision
          : (typeof entry.selectionRevision === 'number' ? entry.selectionRevision : 0),
        selectionRevision: typeof entry.selectionRevision === 'number'
          ? entry.selectionRevision
          : (typeof entry.baseSelectionRevision === 'number' ? entry.baseSelectionRevision : 0),
        activeSaved: entry.activeSaved === true,
        recovering: entry.recovering === true,
        needReload: entry.needReload === true,
        summaryHtml: container.innerHTML,
        container,
      });
      openCodeEditors.set(entry.repoId, state);
      openCodeRenderEditor(container, entry.repoId);
    });
  };
  registerSurface('opencode-editors', {
    capture: () => captureOpenCodeEditors(),
    restore: (root, saved) => restoreOpenCodeEditors(root, saved),
  });
  document.addEventListener('click', (event) => {
    const configure = event && event.target && typeof event.target.closest === 'function' ? event.target.closest('[data-repo-agents-configure]') : null;
    if (!configure) return;
    event.preventDefault();
    const repoId = Number(configure.dataset && configure.dataset.repoId);
    const container = typeof configure.closest === 'function' ? configure.closest('[data-opencode-agents]') : null;
    // The Run with agent control renders its "Edit managed team" link outside
    // the agents summary; resolve that repo's agents container by id so both
    // entry points open the same editor.
    const fallback = !container && Number.isInteger(repoId) && typeof document.querySelector === 'function'
      ? document.querySelector('[data-opencode-agents][data-repo-id="' + String(repoId) + '"]')
      : null;
    const target = container || fallback;
    if (!Number.isInteger(repoId) || !target) return;
    void openCodeMountEditor(target, repoId);
  });
  document.addEventListener('click', (event) => {
    const button = event && event.target && typeof event.target.closest === 'function' ? event.target.closest('[data-agent-action]') : null;
    if (!button || !button.dataset) return;
    const editor = typeof button.closest === 'function' ? button.closest('[data-agent-editor]') : null;
    if (!editor || !editor.dataset) return;
    const repoId = Number(editor.dataset.repoId);
    if (!Number.isInteger(repoId)) return;
    const action = button.dataset.agentAction;
    if (action === 'add') { openCodeAddSubagent(repoId); return; }
    if (action === 'remove') { openCodeRemoveSubagent(repoId, Number(button.dataset.agentIndex)); return; }
    if (action === 'reset') { openCodeResetToDefault(repoId); return; }
    if (action === 'apply') { openCodeApply(repoId); return; }
    if (action === 'back') { openCodeBack(repoId); return; }
    if (action === 'save') { void openCodeSave(repoId, 'save'); return; }
    if (action === 'save-and-activate') { void openCodeSave(repoId, 'save-and-activate'); return; }
    if (action === 'reload-baselines') { void openCodeReloadBaselines(repoId); return; }
    if (action === 'cancel') { openCodeCancel(repoId); return; }
  });
  document.addEventListener('input', (event) => {
    const field = event && event.target && typeof event.target.closest === 'function' ? event.target.closest('[data-agent-field]') : null;
    if (!field || !field.dataset) return;
    const editor = typeof field.closest === 'function' ? field.closest('[data-agent-editor]') : null;
    if (!editor || !editor.dataset) return;
    const repoId = Number(editor.dataset.repoId);
    if (!Number.isInteger(repoId) || !field.dataset.agentField) return;
    openCodeHandleEditorInput(repoId, field.dataset.agentField, typeof field.value === 'string' ? field.value : '');
  });
  document.addEventListener('change', (event) => {
    const model = event && event.target && typeof event.target.closest === 'function' ? event.target.closest('[data-agent-model]') : null;
    if (model && model.dataset) {
      const editor = typeof model.closest === 'function' ? model.closest('[data-agent-editor]') : null;
      const repoId = Number(editor && editor.dataset ? editor.dataset.repoId : NaN);
      if (Number.isInteger(repoId) && model.dataset.agentModel) {
        openCodeHandleModelSelection(repoId, model.dataset.agentModel, model.value || '', model);
      }
      return;
    }
    const field = event && event.target && typeof event.target.closest === 'function' ? event.target.closest('[data-agent-checkbox]') : null;
    if (!field || !field.dataset) return;
    const editor = typeof field.closest === 'function' ? field.closest('[data-agent-editor]') : null;
    if (!editor || !editor.dataset) return;
    const repoId = Number(editor.dataset.repoId);
    if (!Number.isInteger(repoId) || !field.dataset.agentCheckbox) return;
    openCodeHandleEditorChange(repoId, field.dataset.agentCheckbox, Boolean(field.checked));
  });
  if (typeof window !== 'undefined' && window && window.gremlynConsole) {
    window.gremlynConsole.agentEditor = {
      draftFromProfile: openCodeDraftFromProfile,
      draftToCandidate: openCodeDraftToCandidate,
      reviewRows: openCodeReviewRows,
      editorHtml: openCodeEditorHtml,
      fieldLocation: openCodeFieldLocation,
      editors: openCodeEditors,
      mount: openCodeMountEditor,
      render: openCodeRenderEditor,
      save: openCodeSave,
      cancel: openCodeCancel,
      apply: openCodeApply,
      addSubagent: openCodeAddSubagent,
      removeSubagent: openCodeRemoveSubagent,
      resetToDefault: openCodeResetToDefault,
      handleInput: openCodeHandleEditorInput,
      handleChange: openCodeHandleEditorChange,
      reloadBaselines: openCodeReloadBaselines,
      workflowStateOf: openCodeWorkflowStateOf,
      workflowSelectionRevisionOf: openCodeWorkflowSelectionRevisionOf,
      capture: captureOpenCodeEditors,
      restore: restoreOpenCodeEditors,
    };
  }
  // END_OPENCODE_AGENT_EDITOR
  // BEGIN_OPENCODE_SELECTION
  /* Run with agent: repository-scoped primary-source draft (tasks 5.3-5.4).
     The server renders the authoritative saved source; the client fills the
     existing-agent choices from the authenticated discovery route and keeps a
     keyed draft (per repository) across live region swaps. Apply posts one
     compare-and-set update, Cancel discards only the draft, and a stale apply
     is refused with scoped feedback instead of overwriting either side. */
  const selectionEscape = (value) => String(value == null ? '' : value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
  const selectionEditors = new Map();
  const selectionSourceLabels = { default: 'OpenCode default', native: 'Existing OpenCode agent', managed: 'Gremlyn-managed team' };
  const selectionStateFrom = (container) => {
    const dataset = container && container.dataset ? container.dataset : {};
    const rawProfileRevision = dataset.profileRevision;
    const profileRevision = rawProfileRevision === undefined || rawProfileRevision === '' ? null : Number(rawProfileRevision);
    const revision = Number(dataset.selectionRevision || 0);
    return {
      repoId: Number(dataset.repoId),
      savedSource: dataset.savedSource || 'default',
      savedNativeId: dataset.savedNativeId || '',
      savedRevision: revision,
      savedProfileRevision: profileRevision,
      baseRevision: revision,
      // The profile revision a managed activation draft was started against.
      // Frozen while the draft is dirty so a live update cannot silently bind
      // a newer team than the operator saw when they chose managed.
      baseProfileRevision: profileRevision,
      source: dataset.savedSource || 'default',
      nativeId: dataset.savedNativeId || '',
      agents: null,
      discovering: false,
      unavailable: false,
      conflict: false,
      feedback: '',
      feedbackError: false,
      busy: false,
      keepApplyFocusable: false,
      container,
    };
  };
  const selectionDirty = (state) => {
    if (state.source !== state.savedSource) return true;
    return state.source === 'native' && state.nativeId !== state.savedNativeId;
  };
  const selectionIngestAgents = (state, agents) => {
    state.agents = Array.isArray(agents) ? agents : [];
    state.unavailable = Boolean(state.savedNativeId) && !state.agents.some((agent) => agent.id === state.savedNativeId);
    return state;
  };
  const selectionNativeOptionsHtml = (state) => {
    const options = [];
    const agents = state.agents;
    if (!Array.isArray(agents)) {
      options.push(state.savedNativeId
        ? '<option value="' + selectionEscape(state.savedNativeId) + '" selected>' + selectionEscape(state.savedNativeId) + ' (saved — refresh to verify)</option>'
        : '<option value="" selected>Select an existing agent…</option>');
      return options.join('');
    }
    // A deliberate, selected placeholder keeps the browser from auto-selecting
    // the first discovered agent. An unchanged select fires no change event, so
    // without this the control could show one agent while the draft stayed
    // empty and Apply stayed disabled.
    const hasChoice = Boolean(state.nativeId);
    options.push('<option value=""' + (hasChoice ? '' : ' selected') + '>Select an existing agent…</option>');
    if (state.savedNativeId && !agents.some((agent) => agent.id === state.savedNativeId)) {
      const savedSelected = state.nativeId === state.savedNativeId ? ' selected' : '';
      options.push('<option value="' + selectionEscape(state.savedNativeId) + '"' + savedSelected + ' data-native-unavailable>' + selectionEscape(state.savedNativeId) + ' (unavailable)</option>');
    }
    agents.forEach((agent) => {
      const label = (agent.name ? agent.name + ' (' + agent.id + ')' : agent.id) + (agent.origin && agent.origin !== 'unknown' ? ' — ' + agent.origin : '');
      options.push('<option value="' + selectionEscape(agent.id) + '"' + (agent.id === state.nativeId ? ' selected' : '') + '>' + selectionEscape(label) + '</option>');
    });
    if (agents.length === 0 && !state.savedNativeId) {
      options.push('<option value="" disabled>No eligible agents found</option>');
    }
    return options.join('');
  };
  const selectionNativeDescription = (state) => {
    if (!Array.isArray(state.agents)) {
      return state.savedNativeId ? 'Saved existing agent; refresh to load its description.' : '';
    }
    const agent = state.agents.find((entry) => entry.id === state.nativeId);
    if (agent) {
      const parts = [];
      if (agent.description) parts.push(agent.description);
      if (agent.name && agent.name !== agent.id) parts.push('Name: ' + agent.name);
      parts.push('Origin: ' + (agent.origin || 'unknown'));
      return parts.join(' · ');
    }
    if (state.savedNativeId && state.unavailable) {
      return 'This saved agent is not offered by the current discovery.';
    }
    return '';
  };
  const selectionSavedSentence = (state) => {
    const label = selectionSourceLabels[state.savedSource] || state.savedSource;
    let text = state.savedSource === 'native' && state.savedNativeId
      ? 'Saved: ' + label.toLowerCase() + ' ' + state.savedNativeId + '.'
      : state.savedSource === 'managed' && state.savedProfileRevision !== null
        ? 'Saved: ' + label.toLowerCase() + ' revision ' + String(state.savedProfileRevision) + '.'
        : 'Saved: ' + label + '.';
    if (selectionDirty(state)) text += ' Unsaved draft.';
    if (state.unavailable) text += ' The saved existing agent is not in the latest discovery.';
    return text;
  };
  const selectionCandidate = (state) => {
    const selection = state.source === 'native'
      ? { source: 'native', agentId: state.nativeId }
      : { source: state.source };
    const body = { expectedRevision: state.baseRevision, selection };
    if (state.source === 'managed' && state.baseProfileRevision !== null) {
      body.expectedProfileRevision = state.baseProfileRevision;
    }
    return body;
  };
  const selectionApplyDisabled = (state) => {
    if (state.busy) return true;
    if (state.conflict === true) return true;
    if (state.source === 'native' && !state.nativeId) return true;
    return !selectionDirty(state);
  };
  const selectionRender = (container, state) => {
    if (!container || !state || typeof container.querySelector !== 'function') return;
    const sourceSelect = container.querySelector('[data-opencode-source-select]');
    const nativeSelect = container.querySelector('[data-opencode-native-select]');
    const nativeField = container.querySelector('[data-opencode-native-field]');
    const status = container.querySelector('[data-opencode-selection-status]');
    const feedback = container.querySelector('[data-opencode-selection-feedback]');
    const applyButton = container.querySelector('[data-opencode-source-action="apply"]');
    const cancelButton = container.querySelector('[data-opencode-source-action="cancel"]');
    const refreshButton = container.querySelector('[data-opencode-source-action="refresh"]');
    if (sourceSelect) {
      sourceSelect.value = state.source;
      sourceSelect.disabled = state.busy;
    }
    if (nativeField) nativeField.hidden = state.source !== 'native';
    if (nativeSelect) {
      nativeSelect.innerHTML = selectionNativeOptionsHtml(state);
      // Always pin the value, including the empty placeholder, so a rebuilt
      // option list never leaves the browser's automatic first choice showing
      // while the draft holds no selection.
      nativeSelect.value = state.nativeId || '';
      nativeSelect.disabled = state.busy;
    }
    const nativeDescription = container.querySelector('[data-opencode-native-description]');
    if (nativeDescription) {
      nativeDescription.hidden = state.source !== 'native';
      nativeDescription.textContent = selectionNativeDescription(state);
    }
    if (status) status.textContent = selectionSavedSentence(state);
    if (feedback) {
      feedback.textContent = state.feedback || '';
      feedback.classList.toggle('is-error', Boolean(state.feedbackError));
      feedback.setAttribute('role', state.feedbackError ? 'alert' : 'status');
      feedback.setAttribute('aria-live', state.feedbackError ? 'assertive' : 'polite');
    }
    if (applyButton) {
      const disabled = selectionApplyDisabled(state);
      // Keep the action focusable if a just-completed keyboard activation still
      // owns focus. aria-disabled communicates that there is no new draft while
      // preserving the operator's keyboard position after the async save.
      const retainFocus =
        state.busy ||
        document.activeElement === applyButton ||
        state.keepApplyFocusable === true;
      applyButton.disabled = disabled && !retainFocus;
      if (disabled) applyButton.setAttribute('aria-disabled', 'true');
      else applyButton.removeAttribute('aria-disabled');
    }
    if (cancelButton) cancelButton.disabled = !selectionDirty(state) || state.busy;
    if (refreshButton) refreshButton.disabled = state.discovering || state.busy;
    const reloadButton = container.querySelector('[data-opencode-source-action="reload"]');
    if (reloadButton) {
      reloadButton.hidden = state.conflict !== true;
      reloadButton.disabled = state.busy || state.discovering;
    }
  };
  const selectionSessionExpiry = (response, payload) => {
    if (response.status !== 401 || (payload && payload.error) !== 'session-expired') return false;
    if (typeof window !== 'undefined' && window.location) window.location.assign('/auth?reason=expired');
    return true;
  };
  const selectionErrorMessage = (payload) => {
    const messages = {
      'discovery-unavailable': 'Existing-agent discovery is unavailable for this repository.',
      'discovery-failed': 'Existing-agent discovery failed for this repository.',
      'no-profile': 'No managed team is saved for this repository yet.',
      'profile-revision-required': 'Reload the managed team before activating it.',
      'profile-conflict': 'The managed team changed in another session.',
      'not-opencode': 'This repository does not run the OpenCode executor.',
      'repository-not-found': 'This repository is no longer available.',
    };
    return messages[payload && payload.error] || 'The primary source was not accepted. Try again.';
  };
  const selectionFor = (node) => {
    const container = node && typeof node.closest === 'function' ? node.closest('[data-opencode-selection]') : null;
    if (!container || !container.dataset) return null;
    const repoId = Number(container.dataset.repoId);
    let state = selectionEditors.get(repoId);
    if (!state) { state = selectionStateFrom(container); selectionEditors.set(repoId, state); }
    state.container = container;
    return { container, state };
  };
  const selectionDiscover = async (container, state) => {
    if (state.discovering || state.busy) return;
    const url = container.dataset ? container.dataset.discoveryUrl : '';
    if (!url) return;
    state.discovering = true;
    state.feedback = 'Loading existing agents…';
    state.feedbackError = false;
    selectionRender(container, state);
    try {
      const response = await fetch(url + '?refresh=1', { credentials: 'same-origin' });
      const payload = await response.json().catch(() => ({}));
      if (selectionSessionExpiry(response, payload)) {
        state.discovering = false;
        return;
      }
      state.discovering = false;
      if (!response.ok || payload.ok === false) {
        if (payload.status === 'pending') {
          state.feedback = 'Agent discovery is still settling; refresh again in a moment.';
          state.feedbackError = false;
        } else {
          state.feedback = selectionErrorMessage(payload);
          state.feedbackError = true;
        }
        selectionRender(container, state);
        return;
      }
      selectionIngestAgents(state, payload.agents);
      if (state.unavailable) {
        state.feedback = 'The saved existing agent is no longer offered; it is kept as the current choice until you apply another source.';
        state.feedbackError = false;
      } else if (state.agents.length > 0) {
        state.feedback = 'Loaded ' + String(state.agents.length) + ' eligible agent' + (state.agents.length === 1 ? '' : 's') + '.';
        state.feedbackError = false;
      } else {
        state.feedback = 'No eligible existing agents were found for this repository.';
        state.feedbackError = false;
      }
      selectionRender(container, state);
    } catch {
      state.discovering = false;
      state.feedback = 'Agent discovery could not be reached.';
      state.feedbackError = true;
      selectionRender(container, state);
    }
  };
  const selectionApply = async (container, state) => {
    if (state.busy) return;
    if (selectionApplyDisabled(state)) {
      if (state.conflict === true) {
        state.feedback = 'Conflict unresolved: reload baselines to review the newer stored state before applying again.';
        state.feedbackError = true;
        selectionRender(container, state);
      }
      return;
    }
    const applyButton = container.querySelector('[data-opencode-source-action="apply"]');
    // Applying is a deliberate action activated from this control (including
    // keyboard Enter/Space). Keep it focusable throughout the async transition
    // and restore it afterwards even if the browser reports focus late in the
    // synthesized click sequence.
    const restoreApplyFocus = true;
    state.keepApplyFocusable = true;
    const restoreFocus = () => {
      if (!restoreApplyFocus) return;
      const currentContainer =
        document.querySelector(
          '[data-opencode-selection][data-repo-id="' + String(state.repoId) + '"]',
        ) ||
        state.container ||
        container;
      state.container = currentContainer;
      selectionEditors.set(state.repoId, state);
      const currentButton = currentContainer.querySelector('[data-opencode-source-action="apply"]');
      if (currentButton && typeof currentButton.focus === 'function') {
        const disabled = selectionApplyDisabled(state);
        currentButton.disabled = false;
        if (disabled) currentButton.setAttribute('aria-disabled', 'true');
        else currentButton.removeAttribute('aria-disabled');
        currentButton.focus({ preventScroll: true });
      }
    };
    const url = container.dataset ? container.dataset.updateUrl : '';
    if (!url) return;
    state.busy = true;
    state.feedback = 'Saving primary source…';
    state.feedbackError = false;
    selectionRender(container, state);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(selectionCandidate(state)),
      });
      const payload = await response.json().catch(() => ({}));
      if (selectionSessionExpiry(response, payload)) {
        state.busy = false;
        selectionRender(state.container || container, state);
        restoreFocus();
        return;
      }
      state.busy = false;
      if (!response.ok || payload.ok === false) {
        if (response.status === 409 && payload.error === 'conflict') {
          state.feedback = 'The saved primary source changed in another session (now revision ' + String(payload.currentRevision) + '). Your draft was kept; reload baselines to review the newer stored state, then apply again deliberately.';
          state.conflict = true;
        } else if (response.status === 409 && (payload.error === 'profile-conflict' || payload.error === 'no-profile')) {
          state.feedback = 'The managed team changed or is no longer saved. Reload baselines before activating it again.';
          state.conflict = true;
        } else if (response.status === 400 && Array.isArray(payload.issues) && payload.issues.length > 0) {
          state.feedback = payload.issues[0].message || 'The selection was refused.';
        } else {
          state.feedback = selectionErrorMessage(payload);
        }
        state.feedbackError = true;
        selectionRender(state.container || container, state);
        restoreFocus();
        return;
      }
      state.conflict = false;
      state.savedSource = payload.selection && payload.selection.source ? payload.selection.source : state.source;
      state.savedNativeId = payload.selection && payload.selection.agentId ? payload.selection.agentId : (state.source === 'native' ? state.nativeId : '');
      state.savedRevision = typeof payload.revision === 'number' ? payload.revision : state.savedRevision + 1;
      state.baseRevision = state.savedRevision;
      state.savedProfileRevision = typeof payload.profileRevision === 'number' ? payload.profileRevision : null;
      // A landed save is a clean baseline: the frozen profile revision advances
      // with the committed value.
      state.baseProfileRevision = state.savedProfileRevision;
      state.source = state.savedSource;
      state.nativeId = state.savedNativeId;
      state.feedback = 'Primary source saved. New jobs will use it.';
      state.feedbackError = false;
      selectionRender(state.container || container, state);
      // A committed source switch immediately marks a retained saved team
      // inactive (or active, for a managed apply that matched both revisions);
      // the next SSE fragment re-renders the authoritative workflow state.
      selectionSyncWorkflow(container, state);
      restoreFocus();
    } catch {
      state.busy = false;
      state.feedback = 'The primary source could not be saved. Try again.';
      state.feedbackError = true;
      selectionRender(state.container || container, state);
      restoreFocus();
    }
  };
  const selectionCancelDraft = (container, state) => {
    if (state.busy) return;
    state.keepApplyFocusable = false;
    state.source = state.savedSource;
    state.nativeId = state.savedNativeId;
    state.baseRevision = state.savedRevision;
    state.baseProfileRevision = state.savedProfileRevision;
    state.conflict = false;
    state.feedback = 'Draft discarded.';
    state.feedbackError = false;
    selectionRender(container, state);
  };
  // A discovery response carries the persisted selection baseline even when the
  // advisory agent inventory failed or is still settling. Read that baseline
  // when it is coherent; a response without it (for example a 404) cannot
  // advance the compare-and-set revisions and must leave the conflict intact.
  const selectionReloadedBaselines = (payload) => {
    if (!payload || typeof payload !== 'object') return null;
    if (typeof payload.revision !== 'number') return null;
    const selection = payload.selection;
    if (!selection || typeof selection !== 'object') return null;
    const source = selection.source;
    if (source !== 'default' && source !== 'native' && source !== 'managed') return null;
    return {
      source,
      agentId: source === 'native' && typeof selection.agentId === 'string' ? selection.agentId : null,
      revision: payload.revision,
      profileRevision: typeof payload.profileRevision === 'number' ? payload.profileRevision : null,
    };
  };
  const selectionReloadBaselines = async (container, state) => {
    if (state.busy || state.discovering) return;
    const url = container.dataset ? container.dataset.discoveryUrl : '';
    if (!url) return;
    state.busy = true;
    state.feedback = 'Reloading stored revisions…';
    state.feedbackError = false;
    selectionRender(container, state);
    try {
      const response = await fetch(url, { credentials: 'same-origin' });
      const payload = await response.json().catch(() => ({}));
      // Clear busy before every terminal render so a concurrent reload, apply
      // or cancel on the same entry can never observe a stale in-flight flag.
      state.busy = false;
      if (selectionSessionExpiry(response, payload)) {
        selectionRender(state.container || container, state);
        return;
      }
      const baseline = selectionReloadedBaselines(payload);
      if (!baseline) {
        // No usable persisted baseline in the response: nothing reliable can
        // advance the frozen revisions, so the conflict and draft are kept.
        state.feedback = 'The stored revisions could not be reloaded. Your draft was kept; review it before applying again.';
        state.feedbackError = true;
        selectionRender(state.container || container, state);
        return;
      }
      // The fresh persisted context advances only the compare-and-set baselines
      // after this explicit reload; the operator's draft is preserved and Apply
      // stays a deliberate action against the current revisions. A failed or
      // pending inventory discovery still supplies the baseline, but the
      // feedback never claims the agent list was refreshed.
      state.savedSource = baseline.source;
      state.savedNativeId = baseline.agentId === null ? state.savedNativeId : baseline.agentId;
      state.savedRevision = baseline.revision;
      state.savedProfileRevision = baseline.profileRevision;
      state.baseRevision = state.savedRevision;
      state.baseProfileRevision = state.savedProfileRevision;
      state.conflict = false;
      const label = selectionSourceLabels[state.savedSource] || state.savedSource;
      const inventoryLoaded = response.ok === true && payload.ok === true;
      state.feedback = inventoryLoaded
        ? 'Baselines reloaded from the stored state (source ' + label + ', revision ' + String(state.savedRevision) + '). Apply again deliberately with the current revisions.'
        : 'Stored revisions reloaded (source ' + label + ', revision ' + String(state.savedRevision) + '); existing-agent discovery did not complete, so the agent list is unchanged. Apply the current revisions deliberately.';
      state.feedbackError = false;
      selectionRender(state.container || container, state);
    } catch {
      state.busy = false;
      state.feedback = 'The stored revisions could not be reloaded. Your draft was kept; review it before applying again.';
      state.feedbackError = true;
      selectionRender(state.container || container, state);
    }
  };
  const captureSelectionEditors = () => [...selectionEditors.entries()].map(([repoId, state]) => ({
    repoId,
    savedSource: state.savedSource,
    savedNativeId: state.savedNativeId,
    savedRevision: state.savedRevision,
    savedProfileRevision: state.savedProfileRevision,
    baseRevision: state.baseRevision,
    baseProfileRevision: state.baseProfileRevision,
    source: state.source,
    nativeId: state.nativeId,
    agents: state.agents,
    discovering: state.discovering,
    unavailable: state.unavailable,
    conflict: state.conflict === true,
    feedback: state.feedback,
    feedbackError: state.feedbackError,
    busy: state.busy,
    keepApplyFocusable: state.keepApplyFocusable,
  }));
  const restoreSelectionEditors = (root, saved) => {
    if (!root || !Array.isArray(saved) || typeof root.querySelector !== 'function') return;
    saved.forEach((entry) => {
      if (!entry || !Number.isInteger(entry.repoId)) return;
      const container = root.querySelector('[data-opencode-selection][data-repo-id="' + String(entry.repoId) + '"]');
      // The console reconciles independently keyed SSE fragments. A fragment
      // that does not contain this repository (for example, the health panel)
      // is not evidence that the repository disappeared; retain its draft and
      // focus state until a matching selection container is present again.
      if (!container) return;
      const fresh = selectionStateFrom(container);
      // Preserve object identity: a pending apply/discovery/reload closure
      // already holds this same object, so the fresh container, saved values
      // and eventual busy/feedback mutations all land on the mounted entry
      // instead of being stranded on a detached copy.
      const prior = selectionEditors.get(entry.repoId);
      const state = prior || {};
      Object.assign(state, entry, {
        container,
        savedSource: fresh.savedSource,
        savedNativeId: fresh.savedNativeId,
        savedRevision: fresh.savedRevision,
        savedProfileRevision: fresh.savedProfileRevision,
      });
      if (state.baseProfileRevision === undefined) {
        state.baseProfileRevision = state.savedProfileRevision;
      }
      // Only an idle, conflict-free, deliberately reviewed snapshot advances
      // the frozen compare-and-set bases. A busy apply/discovery/reload or an
      // unresolved conflict keeps the revisions the draft began from, even when
      // the SSE committed snapshot happens to match the draft: a live update
      // must never silently rebind an in-flight or unreviewed operation.
      if (!state.busy && state.conflict !== true && !selectionDirty(state)) {
        state.baseRevision = fresh.savedRevision;
        state.baseProfileRevision = fresh.savedProfileRevision;
      }
      selectionEditors.set(entry.repoId, state);
      selectionRender(container, state);
    });
  };
  registerSurface('opencode-selection', {
    capture: () => captureSelectionEditors(),
    restore: (root, saved) => restoreSelectionEditors(root, saved),
  });
  document.addEventListener('click', (event) => {
    const target = event && event.target;
    if (!target || typeof target.closest !== 'function') return;
    const button = target.closest('[data-opencode-source-action]');
    if (!button || !button.dataset) return;
    const found = selectionFor(button);
    if (!found) return;
    const action = button.dataset.opencodeSourceAction;
    if (action === 'refresh') { void selectionDiscover(found.container, found.state); return; }
    if (action === 'apply') { void selectionApply(found.container, found.state); return; }
    if (action === 'reload') { void selectionReloadBaselines(found.container, found.state); return; }
    if (action === 'cancel') { selectionCancelDraft(found.container, found.state); return; }
  });
  document.addEventListener('focusout', (event) => {
    const target = event && event.target;
    if (!target || typeof target.closest !== 'function') return;
    const applyButton = target.closest('[data-opencode-source-action="apply"]');
    if (!applyButton) return;
    const found = selectionFor(applyButton);
    if (!found || !selectionApplyDisabled(found.state)) return;
    if (found.state.busy) return;
    // Once the operator moves on, restore the true disabled state so an idle
    // Apply button does not remain in the tab order.
    found.state.keepApplyFocusable = false;
    applyButton.disabled = true;
  });
  document.addEventListener('change', (event) => {
    const target = event && event.target;
    if (!target || typeof target.closest !== 'function') return;
    const sourceSelect = target.closest('[data-opencode-source-select]');
    const nativeSelect = target.closest('[data-opencode-native-select]');
    if (!sourceSelect && !nativeSelect) return;
    const found = selectionFor(sourceSelect || nativeSelect);
    if (!found) return;
    if (sourceSelect) {
      found.state.source = sourceSelect.value || 'default';
      if (found.state.source === 'native' && !Array.isArray(found.state.agents)) {
        void selectionDiscover(found.container, found.state);
      }
    } else {
      found.state.nativeId = nativeSelect.value || '';
    }
    found.state.feedback = '';
    found.state.feedbackError = false;
    selectionRender(found.container, found.state);
  });
  if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
    document.querySelectorAll('[data-opencode-selection]').forEach((container) => {
      const repoId = container && container.dataset ? Number(container.dataset.repoId) : NaN;
      if (!Number.isInteger(repoId) || selectionEditors.has(repoId)) return;
      const state = selectionStateFrom(container);
      selectionEditors.set(repoId, state);
      selectionRender(container, state);
    });
  }
  if (typeof window !== 'undefined' && window && window.gremlynConsole) {
    window.gremlynConsole.opencodeSelection = {
      editors: selectionEditors,
      stateFrom: selectionStateFrom,
      isDirty: selectionDirty,
      candidate: selectionCandidate,
      applyDisabled: selectionApplyDisabled,
      ingestAgents: selectionIngestAgents,
      nativeOptionsHtml: selectionNativeOptionsHtml,
      nativeDescription: selectionNativeDescription,
      savedSentence: selectionSavedSentence,
      render: selectionRender,
      apply: selectionApply,
      discover: selectionDiscover,
      cancel: selectionCancelDraft,
      reloadBaselines: selectionReloadBaselines,
      capture: captureSelectionEditors,
      restore: restoreSelectionEditors,
    };
  }
  // END_OPENCODE_SELECTION
  // BEGIN_OPENCODE_ACTIVATION
  /* Explicit team activation from the repository Agent workflow summary (tasks
     3.4-3.5). "Activate this team" posts mode 'activate-saved' with the two
     baselines the operator reviewed, frozen at action begin so an SSE refresh
     cannot rebind the request to a newer team. The operation intent, frozen
     baselines and busy flag persist across region swaps; every response
     mutation resolves the authoritative mounted workflow node first, and the
     committed outcome (payload.active/selection, possibly reflecting a
     concurrent source change) drives the summary, roster labels and scoped
     feedback — never an assumed active. A conflict keeps the frozen baselines
     and requires an explicit Reload baselines review before re-activating. */
  const activationMap = new Map();
  const activationStateShape = () => ({ busy: false, intent: 'activate-saved', frozen: null, conflict: false, container: null });
  const activationFor = (node) => {
    const container = node && typeof node.closest === 'function' ? node.closest('[data-opencode-workflow]') : null;
    if (!container || !container.dataset) return null;
    const repoId = Number(container.dataset.repoId);
    if (!Number.isInteger(repoId)) return null;
    let state = activationMap.get(repoId);
    if (!state) { state = activationStateShape(); activationMap.set(repoId, state); }
    state.container = container;
    return { container, state, repoId };
  };
  const activationErrorMessage = (payload) => {
    const known = payload && typeof payload.error === 'string' ? payload.error : '';
    const messages = {
      'invalid-request': 'The activation request was malformed; nothing changed.',
      'repository-not-found': 'This repository is no longer available.',
      'not-opencode': 'This repository does not run the OpenCode executor.',
      'validation': 'The reviewed profile is not valid; nothing was saved.',
      'no-profile': 'No managed team is saved for this repository yet.',
      'opencode-profile-corrupt': 'The saved team cannot be read; open the editor to repair it.',
    };
    return messages[known] || 'The saved team could not be activated. Try again.';
  };
  const activationSourcePhrase = (source, nativeId, profileRevision, primaryId) => {
    if (source === 'native') {
      return nativeId ? 'Existing OpenCode agent <code>' + selectionEscape(nativeId) + '</code>' : 'Existing OpenCode agent (the retained id is missing)';
    }
    if (source === 'managed') {
      const teamRef = primaryId
        ? 'Gremlyn-managed team (primary <code>' + selectionEscape(primaryId) + '</code>)'
        : 'Gremlyn-managed team';
      return profileRevision === null || profileRevision === undefined
        ? 'the ' + teamRef
        : 'the ' + teamRef + ' at revision ' + String(profileRevision);
    }
    return 'OpenCode default';
  };
  const activationSourceSentence = (source, nativeId, profileRevision, primaryId) =>
    'New jobs use: ' + activationSourcePhrase(source, nativeId, profileRevision, primaryId) + '.';
  const activationActionRow = (repoId, dataset, presentation) => {
    const editLabel = presentation.teamState === 'active-managed' ? 'Edit active team'
      : presentation.teamState === 'unavailable-managed' ? 'Repair team'
        : presentation.teamState === 'no-team' ? 'Configure team'
          : 'Edit team';
    let row = '';
    if (presentation.teamState === 'inactive-team') {
      if (presentation.profileRevision !== null && presentation.profileRevision !== undefined) {
        row += '<button type="button" data-opencode-activate data-repo-id="' + repoId + '" data-activation-url="' + selectionEscape(dataset.activationUrl || '') + '" data-selection-revision="' + selectionEscape(String((presentation.selectionRevision ?? dataset.selectionRevision) || 0)) + '" data-profile-revision="' + selectionEscape(String(presentation.profileRevision)) + '">Activate this team</button> ';
        row += '<button type="button" data-opencode-reload-baselines hidden data-repo-id="' + repoId + '">Reload baselines</button> ';
      } else {
        row += '<span class="muted">The saved team cannot run; edit it to repair the definition.</span> ';
      }
    }
    row += '<a id="repo-workflow-edit-' + repoId + '" href="#repo-agents-' + repoId + '" data-repo-agents-configure data-repo-id="' + repoId + '" data-repo-agents-url="/repos/' + repoId + '/opencode-profile">' + editLabel + '</a> ';
    row += '<a id="repo-workflow-change-' + repoId + '" href="#repo-primary-source-' + repoId + '" data-opencode-change-agent>Change agent</a>';
    return row;
  };
  const workflowPresentation = (input) => {
    const teamState = input.teamState;
    const profileRevision = input.profileRevision === null || input.profileRevision === undefined ? null : input.profileRevision;
    const selectionRevision = input.selectionRevision === null || input.selectionRevision === undefined ? null : input.selectionRevision;
    const heading = teamState === 'active-managed' ? 'Team: ACTIVE FOR NEW JOBS'
      : teamState === 'inactive-team' ? 'Saved team: INACTIVE'
        : teamState === 'unavailable-managed' ? 'Selected team unavailable'
          : 'No saved team';
    const isInactive = teamState === 'inactive-team';
    const visualState = teamState === 'inactive-team' ? 'warning'
      : teamState === 'active-managed' ? 'success'
        : 'neutral';
    const notice = teamState === 'inactive-team'
      ? 'Your orchestrator team is saved but is not selected; new jobs still use the selected source below. Activation makes its enabled children available to the primary, and the primary decides when to delegate.'
      : teamState === 'unavailable-managed'
        ? 'New jobs cannot safely use it until the saved definition is repaired or another agent is chosen.'
        : teamState === 'no-team'
          ? 'OpenCode runs with its normal project/global configuration until a managed team is saved and activated.'
          : 'Existing jobs and retries keep the selection recorded when they were created; only new jobs use this team.';
    return {
      teamState,
      source: input.source,
      nativeId: input.nativeId === null || input.nativeId === undefined ? null : input.nativeId,
      profileRevision,
      selectionRevision,
      primaryId: input.primaryId === null || input.primaryId === undefined ? null : input.primaryId,
      heading,
      isInactive,
      visualState,
      rosterActive: input.rosterActive,
      notice,
      sourceSentence: activationSourceSentence(input.source, input.nativeId, profileRevision, input.primaryId),
      actionsHtml: activationActionRow(String(input.repoId || ''), input.dataset || {}, { teamState, profileRevision, selectionRevision }),
    };
  };
  const activationApplyRoster = (container, active) => {
    const card = container && typeof container.closest === 'function'
      ? container.closest('[data-live-key^="repository-"]') : null;
    const agents = card && typeof card.querySelector === 'function'
      ? card.querySelector('[data-opencode-agents]') : null;
    if (agents && agents.dataset) agents.dataset.active = active ? '1' : '0';
    if (!card || typeof card.querySelectorAll !== 'function') return;
    [...card.querySelectorAll('[data-availability]')].forEach((chip) => {
      if (!chip || !chip.dataset) return;
      const enabled = chip.dataset.availability === 'available' || chip.dataset.availability === 'saved';
      const label = enabled ? (active ? 'available' : 'saved') : 'disabled';
      chip.dataset.availability = label;
      chip.textContent = label === 'available' ? 'Available to orchestrator' : label === 'saved' ? 'Enabled in saved team' : 'Disabled';
    });
  };
  const workflowApply = (container, presentation) => {
    if (!container) return;
    const dataset = container.dataset || {};
    container.dataset.teamState = presentation.teamState;
    if (presentation.source) container.dataset.source = presentation.source;
    if (presentation.selectionRevision !== null) container.dataset.selectionRevision = String(presentation.selectionRevision);
    container.dataset.profileRevision = presentation.profileRevision === null ? '' : String(presentation.profileRevision);
    container.classList.toggle('is-inactive', presentation.isInactive === true);
    const heading = container.querySelector('[data-workflow-heading]');
    if (heading) heading.textContent = presentation.heading || '';
    const status = container.querySelector('.workflow-status');
    if (status && status.dataset) status.dataset.visualState = presentation.visualState || 'neutral';
    const sentence = status && typeof status.querySelector === 'function' ? status.querySelector('.muted') : null;
    if (sentence) sentence.innerHTML = presentation.sourceSentence || '';
    const notice = container.querySelector('.workflow-notice');
    if (notice) notice.textContent = presentation.notice || '';
    const actions = container.querySelector('.workflow-actions');
    if (actions) actions.innerHTML = presentation.actionsHtml || '';
    if (presentation.rosterActive !== undefined) activationApplyRoster(container, presentation.rosterActive);
  };
  const activationPrimaryOf = (container) => {
    const card = container && typeof container.closest === 'function'
      ? container.closest('[data-live-key^="repository-"]') : null;
    const agents = card && typeof card.querySelector === 'function' ? card.querySelector('[data-opencode-agents]') : null;
    return agents && agents.dataset && agents.dataset.primaryId ? agents.dataset.primaryId : null;
  };
  const activationMarkActive = (container, override) => {
    const dataset = container.dataset || {};
    const primary = (override && override.primaryId) || activationPrimaryOf(container);
    const profileRevision = override && typeof override.profileRevision === 'number'
      ? override.profileRevision
      : (dataset.profileRevision === '' || dataset.profileRevision === undefined ? null : Number(dataset.profileRevision));
    const selectionRevision = override && typeof override.selectionRevision === 'number'
      ? override.selectionRevision
      : (dataset.selectionRevision === '' || dataset.selectionRevision === undefined ? 0 : Number(dataset.selectionRevision));
    workflowApply(container, workflowPresentation({
      repoId: String(dataset.repoId || ''),
      teamState: 'active-managed',
      source: 'managed',
      nativeId: null,
      profileRevision,
      selectionRevision,
      primaryId: primary,
      dataset,
      rosterActive: true,
    }));
  };
  const activationMarkInactive = (container, override) => {
    const dataset = container.dataset || {};
    const before = dataset.teamState || '';
    if (before === 'no-team' || before === 'unsupported-executor') return;
    const source = override && override.source ? override.source : (dataset.source || 'default');
    const selectionRevision = override && typeof override.selectionRevision === 'number'
      ? override.selectionRevision
      : (dataset.selectionRevision === '' || dataset.selectionRevision === undefined ? 0 : Number(dataset.selectionRevision));
    const profileRevision = override && typeof override.profileRevision === 'number'
      ? override.profileRevision
      : (dataset.profileRevision === '' || dataset.profileRevision === undefined ? null : Number(dataset.profileRevision));
    workflowApply(container, workflowPresentation({
      repoId: String(dataset.repoId || ''),
      teamState: 'inactive-team',
      source,
      nativeId: source === 'native' && override && override.nativeId ? override.nativeId : null,
      profileRevision,
      selectionRevision,
      primaryId: null,
      dataset,
      rosterActive: false,
    }));
  };
  const selectionSyncWorkflow = (container, state) => {
    const card = container && typeof container.closest === 'function'
      ? container.closest('[data-live-key^="repository-"]') : null;
    const workflow = card && typeof card.querySelector === 'function'
      ? card.querySelector('[data-opencode-workflow]') : null;
    if (!workflow || !workflow.dataset) return;
    const before = workflow.dataset.teamState || '';
    // Switching sources never turns a missing team into an inactive one, and an
    // unsupported executor has no workflow semantics at all.
    if (before === 'no-team' || before === 'unsupported-executor') return;
    const dataset = workflow.dataset;
    if (before === 'unavailable-managed') {
      // Switching away from a selected-but-unavailable team: a durable stored
      // profile row remains as an inactive repair state; an absent row is no
      // team at all.
      const selectionNode = card && typeof card.querySelector === 'function'
        ? card.querySelector('[data-opencode-selection]') : null;
      const durable = selectionNode && selectionNode.dataset ? String(selectionNode.dataset.profileRevision || '') : '';
      const durableRevision = durable === '' || durable === undefined ? null : Number(durable);
      const teamState = durableRevision === null ? 'no-team' : 'inactive-team';
      workflowApply(workflow, workflowPresentation({
        repoId: String(dataset.repoId || ''),
        teamState,
        source: state.savedSource,
        nativeId: state.savedSource === 'native' && state.savedNativeId ? state.savedNativeId : null,
        profileRevision: durableRevision,
        selectionRevision: state.savedRevision,
        primaryId: null,
        dataset,
        rosterActive: false,
      }));
      return;
    }
    if (state.savedSource === 'managed') {
      activationMarkActive(workflow, { profileRevision: state.savedProfileRevision, selectionRevision: state.savedRevision });
    } else {
      activationMarkInactive(workflow, {
        source: state.savedSource,
        nativeId: state.savedSource === 'native' && state.savedNativeId ? state.savedNativeId : null,
        selectionRevision: state.savedRevision,
        profileRevision: state.savedProfileRevision === null || state.savedProfileRevision === undefined
          ? (dataset.profileRevision === '' || dataset.profileRevision === undefined ? null : Number(dataset.profileRevision))
          : state.savedProfileRevision,
      });
    }
  };
  const activationMounted = (repoId, state) => {
    if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
      const node = document.querySelector('[data-opencode-workflow][data-repo-id="' + String(repoId) + '"]');
      if (node) { state.container = node; return node; }
    }
    return state.container || null;
  };
  const activationRestoreButtons = (mounted, state) => {
    if (!mounted || typeof mounted.querySelector !== 'function') return;
    const button = mounted.querySelector('[data-opencode-activate]');
    if (button) button.disabled = state.busy === true || state.conflict === true;
  };
  const activationToggleReload = (mounted, show) => {
    if (!mounted || typeof mounted.querySelector !== 'function') return;
    const button = mounted.querySelector('[data-opencode-reload-baselines]');
    if (button) button.hidden = show !== true;
  };
  // After a settled activation the workflow actions row is re-rendered, which
  // removes the focused "Activate this team" button. Move focus to a stable
  // server-rendered control in the same row (Reload baselines on conflict, the
  // Edit/Configure action, or the Change agent link) so a keyboard operator is
  // not stranded on the body, and a following SSE swap keeps the target.
  const activationFocusStable = (mounted, repoId) => {
    if (!mounted || typeof mounted.querySelector !== 'function') return;
    const card = typeof mounted.closest === 'function'
      ? mounted.closest('[data-live-key^="repository-"]') : null;
    const scope = card || mounted;
    if (!scope || typeof scope.querySelector !== 'function') return;
    const reload = scope.querySelector('[data-opencode-reload-baselines]');
    if (reload && !reload.hidden && typeof reload.focus === 'function') {
      reload.focus({ preventScroll: true });
      return;
    }
    const configure = scope.querySelector('[data-repo-agents-configure]');
    if (configure && typeof configure.focus === 'function') {
      configure.focus({ preventScroll: true });
      return;
    }
    const change = scope.querySelector('[data-opencode-change-agent]');
    if (change && typeof change.focus === 'function') change.focus({ preventScroll: true });
  };
  const activationApply = async (container, state) => {
    if (state.busy) return;
    const dataset = container.dataset || {};
    const repoId = Number(dataset.repoId);
    const url = dataset.activationUrl;
    const selectionRevision = dataset.selectionRevision === '' || dataset.selectionRevision === undefined ? null : Number(dataset.selectionRevision);
    const profileRevision = dataset.profileRevision === '' || dataset.profileRevision === undefined ? null : Number(dataset.profileRevision);
    if (!url || !Number.isInteger(repoId) || selectionRevision === null || profileRevision === null) {
      actionMessage(container, 'Reload the dashboard before activating this team.', true, 'activation:' + String(repoId) + ':baseline-missing');
      return;
    }
    if (state.conflict === true) {
      // An unreviewed conflict must not retry against the mutable dataset; the
      // frozen baselines stay unless the operator reloads baselines.
      actionMessage(container, 'Conflict unresolved: reload baselines to review the newer stored state before activating again.', true, 'activation:' + String(repoId) + ':unresolved');
      return;
    }
    // Freeze the reviewed baselines and the operation intent at action begin;
    // a later SSE refresh of the mutable dataset must not rebind this request.
    state.intent = 'activate-saved';
    state.frozen = { expectedProfileRevision: profileRevision, expectedSelectionRevision: selectionRevision };
    state.container = container;
    state.busy = true;
    state.conflict = false;
    const button = typeof container.querySelector === 'function' ? container.querySelector('[data-opencode-activate]') : null;
    if (button) button.disabled = true;
    actionMessage(container, 'Activating the saved team…', false, 'activation:' + String(repoId) + ':activating');
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'activate-saved', expectedProfileRevision: state.frozen.expectedProfileRevision, expectedSelectionRevision: state.frozen.expectedSelectionRevision }),
      });
      const payload = await response.json().catch(() => ({}));
      const mounted = activationMounted(repoId, state);
      if (selectionSessionExpiry(response, payload)) {
        state.busy = false;
        activationRestoreButtons(mounted, state);
        return;
      }
      state.busy = false;
      if (!response.ok) {
        const conflict = response.status === 409 && payload && (payload.error === 'conflict' || payload.error === 'profile-conflict');
        if (conflict) {
          state.conflict = true;
          activationRestoreButtons(mounted, state);
          activationToggleReload(mounted, true);
          actionMessage(mounted || container, 'The saved team or primary source changed in another session (profile revision ' + String(payload.currentProfileRevision ?? '?') + '). Nothing was changed; reload baselines to review the newer stored state, then activate again deliberately.', true, 'activation:' + String(repoId) + ':conflict');
          activationFocusStable(mounted || container, repoId);
          return;
        }
        activationRestoreButtons(mounted, state);
        actionMessage(mounted || container, activationErrorMessage(payload), true, 'activation:' + String(repoId) + ':refused:' + String((payload && payload.error) || response.status));
        activationFocusStable(mounted || container, repoId);
        return;
      }
      // Authoritative committed outcome: active/selection reflect any source
      // change that interleaved, so the summary is never assumed active.
      const active = payload.active === true;
      const selection = payload.selection && typeof payload.selection === 'object' ? payload.selection : {};
      const selectionSource = selection.source && selection.source !== 'managed' ? selection.source : 'managed';
      const selectionRevisionCommitted = typeof payload.selectionRevision === 'number' ? payload.selectionRevision
        : typeof selection.revision === 'number' ? selection.revision
          : state.frozen.expectedSelectionRevision + 1;
      const profileRevisionCommitted = typeof payload.profileRevision === 'number' ? payload.profileRevision
        : typeof selection.profileRevision === 'number' ? selection.profileRevision
          : (typeof payload.revision === 'number' ? payload.revision : state.frozen.expectedProfileRevision);
      const primaryId = typeof payload.primaryId === 'string' && payload.primaryId.length > 0
        ? payload.primaryId
        : activationPrimaryOf(mounted || container);
      const refreshFailed = payload.refreshError === 'notification-failed' || payload.notification === 'failed';
      const target = mounted || container;
      if (active) {
        activationMarkActive(target, { profileRevision: profileRevisionCommitted, selectionRevision: selectionRevisionCommitted, primaryId });
      } else {
        activationMarkInactive(target, {
          source: selectionSource,
          selectionRevision: selectionRevisionCommitted,
          profileRevision: profileRevisionCommitted,
        });
      }
      if (refreshFailed) {
        actionMessage(target, active
          ? 'The team activated, but the live settings refresh failed. The change is committed; reload the dashboard to confirm.'
          : 'The change was committed, but the live settings refresh failed; reload the dashboard to confirm the current source.', false, 'activation:' + String(repoId) + ':refresh-failed');
      } else {
        actionMessage(target, active
          ? 'Team active for new jobs. Existing jobs and retries keep their recorded selection.'
          : 'The change was committed, but the team is not currently selected for new jobs (the source changed alongside activation). Existing jobs and retries keep their recorded selection.', false, 'activation:' + String(repoId) + ':' + (active ? 'activated' : 'switched'));
      }
      // The actions row was just replaced, so a keyboard-activated operator is
      // not stranded on the body; the mounted workflow keeps a stable target.
      activationFocusStable(target, repoId);
    } catch {
      const mounted = activationMounted(repoId, state);
      state.busy = false;
      activationRestoreButtons(mounted, state);
      actionMessage(mounted || container, 'The saved team could not be activated. Try again.', true, 'activation:' + String(repoId) + ':failed');
      activationFocusStable(mounted || container, repoId);
    }
  };
  const activationReloadBaselines = async (container, state) => {
    if (state.busy) return;
    const mounted = activationMounted(Number(container && container.dataset ? container.dataset.repoId : 0), state);
    const target = mounted || container;
    const dataset = (target && target.dataset) || {};
    const repoId = Number(dataset.repoId);
    if (!Number.isInteger(repoId)) {
      actionMessage(target, 'Reload the dashboard, then review the saved team before activating again.', true, 'activation:' + String(repoId) + ':baseline-missing');
      return;
    }
    state.container = target;
    state.busy = true;
    activationRestoreButtons(target, state);
    actionMessage(target, 'Reloading the stored revisions…', false, 'activation:' + String(repoId) + ':reloading');
    try {
      // Read the authoritative revisions from the existing editor GET, which
      // returns the profile and the selection from one coherent snapshot. The
      // saved activation review (state.intent and the team choice) and any open
      // editor draft in a different map are never touched.
      const response = await fetch('/repos/' + String(repoId) + '/opencode-profile');
      const payload = await response.json().catch(() => ({}));
      const after = activationMounted(repoId, state) || target;
      if (selectionSessionExpiry(response, payload)) {
        state.busy = false;
        activationRestoreButtons(after, state);
        return;
      }
      state.busy = false;
      const profileRevision = typeof payload.profileRevision === 'number' ? payload.profileRevision
        : (typeof payload.revision === 'number' ? payload.revision : null);
      const selectionRevision = typeof payload.selectionRevision === 'number' ? payload.selectionRevision : null;
      const selection = payload.selection && typeof payload.selection === 'object' ? payload.selection : null;
      const source = selection && (selection.source === 'default' || selection.source === 'native' || selection.source === 'managed')
        ? selection.source : null;
      const nativeId = selection && typeof selection.nativeAgentId === 'string' ? selection.nativeAgentId : null;
      const primaryId = payload.profile && typeof payload.profile === 'object' && payload.profile.primary && typeof payload.profile.primary.id === 'string'
        ? payload.profile.primary.id : null;
      if (!response.ok || payload.ok === false || profileRevision === null || selectionRevision === null) {
        // A read that did not yield both revisions resolves nothing: keep the
        // frozen baselines and the conflict so a stale pair is never retried
        // without the deliberate review the conflict gate requires.
        state.conflict = true;
        activationRestoreButtons(after, state);
        activationToggleReload(after, true);
        actionMessage(after, 'The stored revisions could not be reloaded (status ' + String(response.status) + '). Nothing changed; reload baselines again before activating.', true, 'activation:' + String(repoId) + ':reload-failed');
        activationFocusStable(after, repoId);
        return;
      }
      if (primaryId === null) {
        // The authoritative read shows no readable saved team to activate; a
        // revision pair alone must never be presented as an activatable team.
        state.conflict = true;
        activationRestoreButtons(after, state);
        activationToggleReload(after, true);
        actionMessage(after, 'No readable saved team is available to activate; refresh the dashboard workflow summary before activating. Nothing changed.', true, 'activation:' + String(repoId) + ':no-profile');
        activationFocusStable(after, repoId);
        return;
      }
      // Advance the reviewed baselines to the authoritative stored pair and
      // mirror them onto the mounted node, so the next explicit activation
      // submits exactly the refreshed revisions.
      state.frozen = { expectedProfileRevision: profileRevision, expectedSelectionRevision: selectionRevision };
      state.conflict = false;
      if (after.dataset) {
        after.dataset.selectionRevision = String(selectionRevision);
        after.dataset.profileRevision = String(profileRevision);
      }
      activationRestoreButtons(after, state);
      activationToggleReload(after, false);
      // Name the newly stored team and the current source so the operator
      // reviews what was actually loaded, without trusting a stale summary or
      // waiting for the next SSE fragment.
      const sourceLabel = source === 'native'
        ? (nativeId === null ? 'Existing OpenCode agent (the retained id is missing)' : 'Existing OpenCode agent ' + nativeId)
        : source === 'managed' ? 'the Gremlyn-managed team' : 'OpenCode default';
      actionMessage(after, 'Baselines reloaded. Saved team primary ' + primaryId + '; new jobs use ' + sourceLabel + ' (profile revision ' + String(profileRevision) + ', selection revision ' + String(selectionRevision) + '). Review the saved team, then activate again deliberately.', false, 'activation:' + String(repoId) + ':baselines-reloaded');
      activationFocusStable(after, repoId);
    } catch {
      const after = activationMounted(repoId, state) || target;
      state.busy = false;
      state.conflict = true;
      activationRestoreButtons(after, state);
      activationToggleReload(after, true);
      actionMessage(after, 'The stored revisions could not be reloaded. Nothing changed; reload baselines again before activating.', true, 'activation:' + String(repoId) + ':reload-failed');
      activationFocusStable(after, repoId);
    }
  };
  registerSurface('opencode-activation', {
    capture: () => [...activationMap.entries()].map(([repoId, state]) => ({
      repoId,
      busy: state.busy,
      conflict: state.conflict === true,
      intent: state.intent || 'activate-saved',
      frozen: state.frozen ? { expectedProfileRevision: state.frozen.expectedProfileRevision, expectedSelectionRevision: state.frozen.expectedSelectionRevision } : null,
    })),
    restore: (root, saved) => {
      if (!root || !Array.isArray(saved) || typeof root.querySelector !== 'function') return;
      saved.forEach((entry) => {
        if (!entry || !Number.isInteger(entry.repoId)) return;
        const container = root.querySelector('[data-opencode-workflow][data-repo-id="' + String(entry.repoId) + '"]');
        if (!container) return;
        const state = activationMap.get(entry.repoId) || activationStateShape();
        state.busy = entry.busy === true;
        state.conflict = entry.conflict === true;
        state.intent = entry.intent || 'activate-saved';
        state.frozen = entry.frozen
          ? { expectedProfileRevision: entry.frozen.expectedProfileRevision, expectedSelectionRevision: entry.frozen.expectedSelectionRevision }
          : null;
        state.container = container;
        activationMap.set(entry.repoId, state);
        const button = typeof container.querySelector === 'function' ? container.querySelector('[data-opencode-activate]') : null;
        if (button && entry.busy === true) button.disabled = true;
        activationToggleReload(container, state.conflict);
      });
    },
  });
  document.addEventListener('click', (event) => {
    const target = event && event.target;
    if (!target || typeof target.closest !== 'function') return;
    const activateButton = target.closest('[data-opencode-activate]');
    if (activateButton && activateButton.dataset) {
      const found = activationFor(activateButton);
      if (!found) return;
      event.preventDefault();
      void activationApply(found.container, found.state);
      return;
    }
    const reloadButton = target.closest('[data-opencode-reload-baselines]');
    if (!reloadButton || !reloadButton.dataset) return;
    const found = activationFor(reloadButton);
    if (!found) return;
    event.preventDefault();
    void activationReloadBaselines(found.container, found.state);
  });
  if (typeof window !== 'undefined' && window && window.gremlynConsole) {
    window.gremlynConsole.opencodeActivation = {
      for: activationFor,
      apply: activationApply,
      reloadBaselines: activationReloadBaselines,
      markActive: activationMarkActive,
      markInactive: activationMarkInactive,
      syncWorkflow: selectionSyncWorkflow,
      errorMessage: activationErrorMessage,
      state: activationMap,
      presentation: workflowPresentation,
    };
  }
  // END_OPENCODE_ACTIVATION
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
