# Changelog — specsmith AEE Workbench

All notable changes to the VS Code extension are documented here.

## [0.3.1] — 2026-04-07

### Added
- **AEE workflow phase indicator** — live phase bar in Governance Panel showing current phase (🌱→🏗→📋→✅→⚙→🔬→🚀), readiness %, step count, Next Phase button, and phase selector dropdown. Phase read from `scaffold.yml` `aee_phase` field; phase selector writes back immediately.
- **`phaseNext` and `phaseSet` message handlers** — "→ next phase" button runs `specsmith phase next` in a terminal; phase selector runs `specsmith phase set --force` via child process.
- **`specsmith.autoOpenGovernancePanel` setting** — auto-open governance panel 1.5s after VS Code starts with a workspace folder (default: true).
- **GovernancePanel v3 — 5 tabs**: Project, Tools, Files, Updates & System, Actions & AI.
- **FPGA/HDL tool selection** — Tools tab with 21 FPGA/HDL tool chips (vivado, gtkwave, vsg, ghdl, verilator, yosys, nextpnr, symbiyosys, and more). Saved as `fpga_tools:` in scaffold.yml.
- **Update checker** — Updates tab queries PyPI for latest specsmith version, shows current vs available, last-checked timestamp, Check for Updates / Install Update buttons.
- **System info panel** — Updates tab lazy-loads OS, CPU, cores, RAM, GPU, disk info on tab open.
- **Ollama 404 auto-recovery** — resolves quantization-suffix mismatches before spawning the session (e.g. `qwen2.5:14b` → `qwen2.5:14b-instruct-q4_K_M`).
- **Auto-open governance panel** on VS Code activation when a workspace is present.
- **`_detectAndSetLanguages`** — scans project file extensions and patches `scaffold.yml`.
- **`_runUpgradeAndRefresh`** — runs `specsmith upgrade` in terminal and reloads panel.
- Module-level state in GovernancePanel (`_ctx`, `_projectDir`, `_sendFn`, `_openFn`) for cleaner lifecycle management.

### Changed
- GovernancePanel completely rewritten (v2→v3); all existing functionality preserved in new tab layout.
- Out-of-date scaffold spec_version banner now appears above the tab bar (always visible).
- Project type list expanded with FPGA-specific types: `fpga-rtl-xilinx`, `fpga-rtl-intel`, `fpga-rtl-lattice`, `fpga-rtl-generic`.
- Target platforms expanded with FPGA variants.

## [0.3.0] — 2026-04-07

### Added
- **Ollama model download flow** — selecting a `dl:`-prefixed model triggers confirmation dialog then `OllamaManager.download()` with progress notification and Cancel support.
- **`specsmith.downloadModel` command** — orchestrates the download + model list refresh.
- **`specsmith.selectModelForTask` command** — QuickPick task → model suggestions including download option.
- **OllamaManager.ts** — GPU VRAM detection (nvidia-smi + Windows WMI), 9-model curated catalog, `getInstalledIds()`, `getAvailableModels()`, `download()` with CancellationToken, `suggestForTask()`.
- **ModelRegistry.ts `fetchOllama()`** — delegates to OllamaManager; installed models show as `category: 'Installed'`, uninstalled as `dl:` prefix and `category: 'Available to Download'`.
- **Stale Ollama model validation** on session create: validates saved model against installed list, auto-selects first installed model if saved model is stale.
- **Daily update check** — polls PyPI once per day on activation; prompts to upgrade if newer version found.
- **`specsmith.clearHistory` and `specsmith.clearAllHistory` commands**.
- **Copy all messages** — `⎘` button in header copies full chat as Markdown.
- Session status indicator icons in the Sessions sidebar (yellow=starting, green=waiting, spin=running, warning=error).

### Changed
- `OllamaProvider` Ollama error messages improved (404, connection refused).
- Auto-select first installed Ollama model if none saved.
- OpenAI model fetcher uses exclude-list approach to include future models automatically.

## [0.2.1] — 2026-04-06

### Added
- **GovernancePanel v2** — right-side WebviewPanel with scaffold.yml form editor, multi-language/platform/integration chips, out-of-date banner, governance file status, quick actions, AI prompt palette.
- **`specsmith.showGovernance` command** with `Ctrl+Shift+G` shortcut.
- **Language detection** — auto-detects languages from file extensions; `Detect Languages` button patches scaffold.yml.
- **Auto-upgrade** — upgrade button runs specsmith upgrade in terminal.
- **Daily update check** for specsmith CLI; notification with Upgrade Now option.
- **Auto-run 'start' protocol** on session ready event.
- **`specsmith.installOrUpgrade` command** — QuickPick: install via pipx, pip, or copy path.
- Governance panel auto-opens when AI prompt clicked if no session is active.
- Toolbar icons on Projects sidebar for governance panel.

### Fixed
- Ollama stale model detection on session open.
- Help button wired to `specsmith.showHelp`.
- PATH augmentation prefers newer specsmith installs over older pipx versions.

## [0.2.0] — 2026-04-06

### Added
- **SecretStorage API key management** — `ApiKeyManager.ts` with CRUD for Anthropic, OpenAI, Gemini, Mistral keys. Keys stored in OS credential store.
- **`specsmith.setApiKey` / `clearApiKey` / `apiKeyStatus` commands**.
- **Live model listing** — `ModelRegistry.ts` fetches from provider REST APIs with 5-min cache and static fallback. Model dropdown renders `<optgroup>` by category with context window in tooltip.
- **OpenAI model auto-filter** — excludes non-chat families (embeddings, audio, images, legacy).
- **Gemini and Mistral live model fetch**.
- **Provider/model per-session persistence** — saved per project in global state. Validates saved Ollama model against installed list on load.
- **Timeout and kill** — 5-minute agent timeout; bridge kills process with graceful then forced termination.
- **`specsmith.runAudit` / `runValidate` / `runDoctor` commands**.
- **`specsmith.addRequirement` command** (`Ctrl+Shift+R`) — guided requirement add with ID/priority/description.
- **`specsmith.navigateRequirements` command** (`Ctrl+Shift+Q`) — QuickPick through REQ IDs.
- **`specsmith.openScaffold` command** — opens scaffold.yml.
- **Drag and drop files/images** into chat.
- **Paste image** from clipboard (`Ctrl+V`).
- **Copy message** / **Edit last message** / **Regenerate** message actions (hover).
- **Export chat as Markdown** (`⬇` button).
- **Resizable message input** (drag teal handle).
- **Chat history persistence** to `.specsmith/chat/chat-*.jsonl`. Replay last 40 messages on re-open.
- **`specsmith.deleteSession` command** and delete icon in Sessions context menu.
- **`specsmith.createProject` / `importProject` / `removeProject` commands**.
- **Projects sidebar merged with FileTree** — unified tree with governance docs, full file tree, context menu (new file, rename, delete, copy path, reveal).
- **EpistemicBar.ts** — status bar polling epistemic audit score.
- **`specsmith.apiKeyStatus` verification** — verifies key against provider API on save, broadcasts fresh model list.
- **`specsmith.selectModelForTask` command** (Ollama) — task QuickPick → model suggestions.

## [0.1.0] — 2026-04-06

### Added
- Initial release
- Activity Bar sidebar with Projects tree and Active Sessions tree
- Multi-tab WebviewPanel agent sessions (one process per tab)
- JSON events bridge to `specsmith run --json-events`
- Dark/light theme-compatible chat UI using VS Code CSS variables
- Token meter with context fill bar, token counts, and cost estimate
- Epistemic status bar item polling `specsmith epistemic-audit --brief`
- Quick-tool buttons: Audit, Validate, Doctor, Epistemic, Status
- Provider/model hot-swap within a session
- Configuration: executablePath, defaultProvider, defaultModel, watchedProjects
