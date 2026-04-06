# Changelog

## [0.1.0] — 2026-04-06

### Added
- Initial release of the specsmith AEE Workbench VS Code extension
- Activity Bar sidebar with Projects tree view and Active Sessions tree view
- Multi-tab WebviewPanel agent sessions (one process per tab)
- JSON events bridge to `specsmith run --json-events`
- Dark/light theme-compatible chat UI using VS Code CSS variables
- Token meter with context fill bar, token counts, and cost estimate
- Epistemic status bar item polling `specsmith epistemic-audit --brief`
- Quick-tool buttons: Audit, Validate, Doctor, Epistemic Audit, Status
- Provider/model hot-swap within a session
- Configuration: executablePath, defaultProvider, defaultModel, watchedProjects
