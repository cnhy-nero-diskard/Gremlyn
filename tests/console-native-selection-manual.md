# Manual keyboard validation — Run with agent (tasks 5.3–5.4)

This is the manual step for `select-native-opencode-agent` task 5.4. It uses the
fixture helper `tests/helpers/console-native-fixture.ts`, which serves the real
console with a **fake worker and fake discovery**. It uses no OpenCode binary,
no credentials and no model calls. The console token is a fixture-only value.

## Run

```powershell
node --import tsx tests/helpers/console-native-fixture.ts
```

It prints a `http://127.0.0.1:<port>/` URL and the token
`fixture-console-token`. Open the URL, sign in with that token.

## Seeded repositories

| Repository         | Configured primary source                        |
| ------------------ | ------------------------------------------------ |
| `default-repo`     | OpenCode default                                 |
| `native-repo`      | Existing agent `reviewer` (offered by discovery) |
| `unavailable-repo` | Existing agent `gone-agent` (not offered)        |
| `managed-repo`     | Gremlyn-managed team (revision 1)                |
| `cline-repo`       | Cline — must render **no** OpenCode picker       |

Fake discovery always offers `reviewer` and `implementer`.

## Keyboard-only checklist

1. **Reach the control without a mouse.** `Tab` through the `default-repo` card
   to the `Run with agent` region. The `Primary source` select takes focus with
   a visible focus ring.
2. **Choose an existing agent.** With the `Primary source` select focused, use
   the arrow keys / `Alt`+`↓` to open it, select `Existing OpenCode agent`, and
   confirm. The `Existing agent` select appears and loads the fake choices.
   `Tab` to it and pick `reviewer`. `Apply` and `Cancel` become enabled.
3. **Deliberate apply.** `Tab` to `Apply` and press `Enter` or `Space`. Focus
   stays on `Apply`; the scoped status line reports the save and the disabled
   state clears. Confirm the repository chip now reads the native source.
4. **Cancel discards the draft.** Change `Primary source` back to
   `OpenCode default`, then `Tab` to `Cancel` and activate it. The draft returns
   to the saved value and the control shows `Draft discarded.`
5. **Unavailable saved id.** On `unavailable-repo`, activate `Refresh agents`
   (keyboard). `gone-agent` stays selected and is labelled `(unavailable)` with
   an explanation; no replacement is applied automatically.
6. **Managed team path.** On `managed-repo`, the control shows
   `managed team revision 1` and an `Edit managed team` link. `Tab` to the link
   and press `Enter`; the existing managed-team editor opens.
7. **Draft survives a live update.** Start a native draft on `default-repo`
   (do not apply). Wait for a live SSE update (the health/metrics tick) and
   confirm the select keeps the draft value, the focused control keeps focus,
   and any open managed-team editor stays expanded.
8. **Cline exclusion.** The `cline-repo` card has no `Run with agent` region,
   no `Primary source` select, and no `Edit managed team` link.
9. **Stale apply feedback.** If two tabs are open, apply a change in one, then
   apply the stale draft in the other. The second apply is refused with scoped
   feedback naming the newer revision; the draft is preserved.

Record any failure with the browser, viewport and the step number.
