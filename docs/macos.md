# Starting Gremlyn on macOS

Use Node.js 22 or newer, Git, and an authenticated OpenCode installation.
Install dependencies with `npm ci` using that Node version. The Mac launcher
tries the current Node first, then common local and Homebrew installations if
the shell's Node is too old. Its selected directory must also provide npm.
After changing Node versions, reinstall dependencies under the selected Node
with `npm ci`; the native SQLite binding must match that runtime. The launcher
checks that SQLite loads before starting.

Copy `config.example.yaml` to `gremlyn.macos.yaml` (ignored by Git), then:

- Remove agent definitions you do not use. Startup verifies every configured
  agent, including ones not assigned to a repository.
- Set OpenCode's `credential_source` to the absolute data directory reported by
  `opencode debug paths`, usually `/Users/<you>/.local/share/opencode`.
  Startup accepts either a readable legacy `auth.json` or OpenCode 2's
  `opencode.db`. The database remains with the shared OpenCode service and is
  never copied into attempt directories. This check confirms the store exists;
  it does not prove provider authentication or model access.
- Use absolute Mac checkout paths for each repository's `source_path` and
  separate directories outside those checkouts for `workspace_root`.
- Include only repositories available on this machine. Use `./gradlew` instead
  of `gradlew.bat`, and `npm` instead of `npm.cmd`. Preserve required ignored
  inputs such as Android `local.properties` through `workspace_seed_files`.
- Keep tokens out of YAML. The launcher uses exported `GREMLYN_GITHUB_TOKEN`
  and `GREMLYN_CONSOLE_TOKEN` when present. Otherwise it reads the Keychain
  account `gremlyn`, services `gremlyn.github.token` and `gremlyn.console.token`.

Keep a Windows config separately; the launcher defaults to `gremlyn.macos.yaml`.
Set `GREMLYN_CONFIG` to an absolute path to select another config.

Check local prerequisites without starting the daemon or polling GitHub:

```sh
bash scripts/start-macos.sh --check
```

This checks config loading, credential stores, repository paths, and configured
CLI versions. Normal startup additionally verifies the GitHub identity, data
directory ownership, and console binding. If a CLI version has drifted, use
`npm run pin:sync` to check its command surface and update its pin, then retry.

Start the daemon and stop it with Ctrl+C:

```sh
bash scripts/start-macos.sh
```

For the `gremlyn start` convenience command, add this function to `~/.zshrc`
(replace the checkout path), then run `source ~/.zshrc`:

```sh
gremlyn() {
  if [[ "${1:-}" != start ]]; then
    print -u2 "Usage: gremlyn start [options]"
    return 2
  fi
  shift
  bash /absolute/path/to/Gremlyn/scripts/start-macos.sh "$@"
}
```

`gremlyn start --check` performs the local check. A shell function is available
in shells that load `.zshrc`; scripts can invoke the launcher directly.
