# pi-background-terminals

Session-scoped background terminals for [Pi](https://github.com/earendil-works/pi), compatible with Pi 0.81.1.

## Features

- `bg_start`, `bg_status`, `bg_list`, and `bg_kill` tools, with at most eight running processes.
- No stdin surface: background commands receive EOF and cannot prompt interactively.
- Separate bounded stdout and stderr tails, plus best-effort private session-lifetime spill logs.
- Whole-tree termination: POSIX process groups or Windows `taskkill /T`, escalating to force termination.
- Exactly-once deferred completion follow-ups, a selectable running-count footer status, and a read-only `/ps` picker/detail view.
- Cleanup of all processes and temporary logs on session shutdown or reload.

## Install locally

```bash
npm install
pi -e .
```

Or add this package's absolute path to Pi's package settings.

## Usage

Ask Pi to start a long-running command, for example:

```text
Start npm run dev in the background and continue with the implementation.
```

Use `/ps` to inspect live stdout/stderr or kill a terminal interactively. With `pi-ui-customization` loaded, an empty editor can use Up/Down to select the running-terminal footer row and Enter to open the same view. The model can use `bg_status`, `bg_list`, and `bg_kill` directly. Prefer Pi's regular shell tool for quick commands.

## Safety and limits

Commands execute through `/bin/sh -c` on POSIX and `cmd.exe /d /s /c` on Windows with your user permissions. This package is process management, not a sandbox. In-memory capture retains the latest 2 MiB per stream per terminal. Best-effort spill files have a 256 MiB per-stream and 512 MiB session-wide safety cap; `/ps` identifies when earlier output is unavailable. Spill files are deleted when records are pruned and during shutdown.

POSIX process groups are reaped after the root closes and again at shutdown. On Windows, `taskkill /T` is best effort while the root PID exists; descendants that outlive it cannot be reaped reliably without Job Objects, which Pi does not currently expose.

## Development

```bash
npm run check
npm run typecheck
npm test
npm pack --dry-run
npm audit
```

## Credits

The tools and `/ps` experience are based on the [`background-terminals`](https://github.com/davis7dotsh/my-pi-setup/tree/main/extensions/background-terminals) extension from `davis7dotsh/my-pi-setup`; this package replaces its Effect runtime with plain TypeScript lifecycle management.

## License

MIT
