---
name: background-terminals
description: Run and manage long-lived shell commands in background terminals. Use for dev servers, watchers, streaming builds, and other commands that should keep running while the agent continues working.
---

# Background Terminals

Use `bg_start` for long-running commands; use regular `bash` for quick commands.

## Start

Call `bg_start` with:

- `command`: shell command to run
- `title`: short recognizable label
- `working_dir`: project directory when different from the current directory

Background commands receive no stdin. Never use them for interactive prompts.

After starting, continue useful work instead of polling. The terminal sends one model-visible completion message when it exits; that message stays hidden from the user's transcript.

## Inspect and stop

- Use `bg_status` only when current output or status is needed.
- Use `bg_list` to inventory all tracked terminals.
- Use `bg_kill` when a process is no longer needed or is stuck; termination continues even if the tool wait is aborted.
- Tell the user they can open `/ps` to inspect live output and kill terminals interactively.

Prefer meaningful titles and avoid starting duplicate servers or watchers. Tool output remains available to the model, while transcript rows stay metadata-only and cannot expand with Ctrl+O. `/ps` is the detailed user-facing surface: it shows retained tails and links a private complete spill log when one is available. Settled terminals and spill resources remain there for five minutes; spill failures or safety budgets can make earlier output unavailable. Terminals are session-scoped and are stopped during shutdown or reload.
