# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Fixed

- Made manager initialization synchronous and session-generation-safe, detached snapshots atomically, froze forced settlements, hardened working-directory validation and Unicode sanitization, and centralized unknown-terminal checks.
- Fixed Kitty-protocol literal shortcuts and duplicate output wrapping in `/ps`.
- Made `bg_start.working_dir` required-but-nullable so Codex/OpenAI strict tool-schema validation accepts the tool.

### Added

- Pi 0.84.1 extension-boundary, reload/shutdown cleanup, completion-delivery race, output-padding, environment privacy, and fullscreen `/ps` coverage.
- Strict-preferred constrained sampling for all tools and schema-level non-empty `bg_kill.ids` validation.
- Typed exports and documentation for the optional `pi-ui-customization` status event contract.
- Repository/npm metadata, CI, and a prepack verification gate.

### Changed

- Made all background tool transcript rows metadata-only, hid model-visible completion follow-ups, and made historical completion rendering compact and expansion-invariant.
- Retain settled terminals in `/ps` for exactly five minutes from settlement, then clean their timers, listeners, and spill resources while preserving inspector selection; the independent tracking safety limit rejects starts instead of evicting early.
- Updated Pi/TUI development hosts to 0.84.1 and aligned TypeBox with Pi's 1.3.7 host version. Pi/TUI/TypeBox remain unbundled peer dependencies.
- Render completion output literally after control-sequence sanitization instead of interpreting arbitrary process text as Markdown.
- Honor Pi's custom-message `outputPad` setting and size `/ps` within regular and fullscreen overlays.
- Remove Pi session/model metadata from background child environments while preserving ordinary inherited variables such as `AI_AGENT` and `PI_CODING_AGENT`.

## [0.1.0] - 2026-08-10

- Initial package release with session-scoped background process management and the `/ps` inspector.
