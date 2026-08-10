# pi-background-terminals

Session-scoped background terminals for [Pi](https://github.com/earendil-works/pi). Tested with Pi 0.84.1; that is the supported/tested floor.

## Features

- `bg_start`, `bg_status`, `bg_list`, and `bg_kill` tools, with at most eight running processes.
- No stdin surface: background commands receive EOF and cannot prompt interactively.
- Separate bounded stdout and stderr tails, plus best-effort private session-lifetime spill logs.
- Whole-tree termination: POSIX process groups or Windows `taskkill /T`, escalating to force termination.
- Exactly-once deferred completion follow-ups, a selectable running-count footer status, and a read-only two-pane `/ps` inspector compatible with regular and fullscreen TUI modes.
- Literal, control-sanitized completion rendering: terminal output is never interpreted as Markdown.
- Strict-preferred JSON Schema tool sampling where the active provider supports it.
- Cleanup of all processes and temporary logs on session shutdown or reload.

## Install

From npm:

```bash
pi install npm:@inv1x/pi-background-terminals
```

For local development, install dependencies and register the absolute package path persistently so `/reload` can rediscover it:

```bash
npm install
pi install /absolute/path/to/pi-background-terminals
```

Use `pi -e .` only for a temporary smoke test. Pi supplies `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox` as unbundled host peer dependencies.

## Usage

Ask Pi to start a long-running command, for example:

```text
Start npm run dev in the background and continue with the implementation.
```

Use `/ps` to inspect live stdout/stderr or kill a terminal interactively. The inspector uses `Up`/`Down` to select terminals, `g`/`G` to jump to the first/last terminal, `j`/`k` to scroll output, `t` to switch stdout/stderr, `x` to kill a running terminal, `r` to refresh, and `Esc`, `Ctrl+C`, or `q` to close. With `pi-ui-customization` loaded, an empty editor can use `Up`/`Down` to select the running-terminal footer row and `Enter` to open the same view; its accent color is preserved while selected. The model can use `bg_status`, `bg_list`, and `bg_kill` directly. Prefer Pi's regular shell tool for quick commands.

## Safety and limits

Commands execute through `/bin/sh -c` on POSIX and `cmd.exe /d /s /c` on Windows with your user permissions. This package is process management, not a sandbox. In-memory capture retains the latest 2 MiB per stream per terminal. Best-effort spill files have a 256 MiB per-stream and 512 MiB session-wide safety cap; `/ps` identifies when earlier output is unavailable. Spill files are deleted when records are pruned and during shutdown.

Background children do not receive Pi's session-specific `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, or `PI_REASONING_LEVEL` values by default. They still inherit ordinary ambient variables, including Pi CLI/RPC process markers `AI_AGENT=pi` and `PI_CODING_AGENT=true` when those are present. Do not treat either marker as a secret or a sandbox boundary.

POSIX process groups are reaped after the root closes and again at shutdown. On Windows, `taskkill /T` is best effort while the root PID exists; descendants that outlive it cannot be reaped reliably without Job Objects, which Pi does not currently expose.

## Optional pi-ui-customization integration

The package works without `pi-ui-customization`. When it is present, this extension emits `pi-ui-customization:status-options` with `{ key: "background-terminals", preserveSelectedColors: true }` and listens for `pi-ui-customization:activate-status` with `{ key, sessionId }`. The constants and payload interfaces are exported as `UI_CUSTOMIZATION_STATUS_OPTIONS_EVENT`, `UI_CUSTOMIZATION_STATUS_ACTIVATION_EVENT`, `UIStatusOptionsEvent`, and `UIStatusActivationEvent` so integrations do not duplicate the contract.

## Development

```bash
npm run verify
npm pack --dry-run
npm audit
```

## Versioning

Run `npm run changeset` for each user-facing change and commit the generated `.changeset/*.md` file. To prepare a release, run `npm run release:status` and then `npm run release:version`; Changesets consumes the pending files and updates `package.json`, `package-lock.json`, and `CHANGELOG.md`. These commands do not publish to npm or create a GitHub Release.

## Credits

The tools and `/ps` experience are based on the [`background-terminals`](https://github.com/davis7dotsh/my-pi-setup/tree/main/extensions/background-terminals) extension from `davis7dotsh/my-pi-setup`; this package replaces its Effect runtime with plain TypeScript lifecycle management.

## License

MIT
