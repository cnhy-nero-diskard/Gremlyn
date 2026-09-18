# Console browser acceptance

This is the real-browser acceptance record for the PR-head console rendering
code. It supplements, rather than replaces, the offline CSS-contract coverage
in `console-visual.test.ts` and `console-accessibility.test.ts`.

## Run

- **Date:** September 18, 2026
- **Browser:** Chrome 153.0.8010.48, headless CDP session
- **Viewport:** 320 CSS px wide by 900 CSS px high (`Emulation.setDeviceMetricsOverride`)
- **Normal pass:** page scale 1
- **Zoom pass:** page scale 4, applied after every route navigation with
  `Emulation.setPageScaleFactor` (the browser reported
  `visualViewport.scale === 4` and `visualViewport.width === 76.25`)
- **Routes:** `/auth`, `/`, `/commands`, `/audit`, `/jobs/1`, and `/jobs/2`
- **Harness:** temporary local server using the PR-head console views and
  stylesheet, navigated in Chrome through CDP. No repository files were used
  as probe output.

The browser's layout viewport reported `innerWidth === 320` and
`document.documentElement.clientWidth === 305`; the 15 px difference is the
vertical scrollbar. The acceptance comparison therefore uses the document's
305 px client width, not the scrollbar-inclusive `innerWidth`.

## Page-level results

Every route passed at both page scales:

| Check                                        | Normal scale | 400% scale |
| -------------------------------------------- | -----------: | ---------: |
| Routes exercised                             |          6/6 |        6/6 |
| `document.scrollWidth` exceeded client width |          0/6 |        0/6 |
| Document-level horizontal overflow           |          0/6 |        0/6 |
| Clipped evidence elements                    |          0/6 |        0/6 |
| Clipped focused controls                     |          0/6 |        0/6 |
| Expected table-wrapper exception             |          4/6 |        4/6 |

For every route in both runs, `scrollWidth === 305` and
`documentOverflow === false`. The four data-heavy routes (`/commands`,
`/audit`, and both job pages) contain responsive table regions. Table
descendants were excluded from the page-level evidence-bound check because the
table interaction is scoped to its wrapper; the wrapper did not expand the
document and did not produce an additional focus or evidence clipping result.

## Route semantics

The semantic checks below were identical at normal scale and 400% scale.
Focusable counts are included as evidence that the probe exercised the route's
interactive controls rather than only checking static markup.

| Route       | Semantic checks observed                                                   | Focusable controls | Result |
| ----------- | -------------------------------------------------------------------------- | -----------------: | ------ |
| `/auth`     | Sign-in surface present                                                    |                  2 | Pass   |
| `/`         | Health region, repository surface, 5 dashboard panels, running status      |                 12 | Pass   |
| `/commands` | Commands region, inset evidence panel, caption `Command ingestion records` |                  5 | Pass   |
| `/audit`    | Audit region, inset evidence panel, caption `Operator audit records`       |                  4 | Pass   |
| `/jobs/1`   | Activity and log panels, `running` status/outcome, 2 dashboard panels      |                 15 | Pass   |
| `/jobs/2`   | Activity and log panels, `failed` status/outcome, 2 dashboard panels       |                 15 | Pass   |

## Conclusion

The PR-head console routes passed real-browser acceptance at 320 CSS px and
400% page scale: no route introduced document-level horizontal overflow, no
evidence panel was clipped, focused controls remained within the layout
viewport, and the expected dashboard, evidence, activity, log, and status
semantics remained present.
