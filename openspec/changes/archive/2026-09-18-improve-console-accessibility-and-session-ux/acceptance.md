# AA-oriented acceptance record

Checked 2026-09-18 against a local in-memory console fixture in headless Chrome 152.0.7977.83. The fixture contained one repository, one failed job, a command record, an audit record, and one failed validation run.

## Real-browser checks

- `/auth`: password input received initial focus; the native POST form submitted with Enter; protected links and live regions were absent; the submitted token was not present in the page.
- `/`: the Dashboard link was the sole current navigation item; keyboard Tab order reached Dashboard, Commands, Audit, and Sign out; the opaque cookie was HttpOnly, SameSite=Strict, Path `/`, non-Secure on HTTP, and did not contain the token.
- `/commands` and `/audit`: populated labelled tables exposed `command-1` and `audit-1` keyed records, with their matching current navigation items.
- `/jobs/1`: the validation details disclosure opened with a keyboard Enter event; Retry and typed `RESET` confirmation completed through keyboard activation and kept feedback beside the originating control.
- Dashboard repository settings: changing the effort select produced local feedback and restored focus to the select after the asynchronous save.
- Dashboard at 320 CSS pixels with 400% page scale: document scroll width matched its 305px layout client width (the 320px viewport included the scrollbar) and no interactive control was clipped. Reduced-motion emulation matched and resolved animation duration to `0.01ms`.
- Sign out: keyboard activation returned `/auth?reason=signed-out`; protected navigation disappeared and `/session-status` returned `{ "status": "absent" }`.

## Automated checks

`tests/console-accessibility.test.ts` covers accessible names, current navigation, table semantics, light/dark token contrast, visible focus, and reduced-motion overrides. Console/session/announcement tests cover opaque sessions, scoped channels, deduplication, heartbeat suppression, keyed state changes, and redacted action failures.

This is an AA-oriented engineering acceptance record, not a WCAG conformance certification or a substitute for assistive-technology testing.
