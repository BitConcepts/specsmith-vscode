# specsmith — AEE Workbench

[![specsmith](https://img.shields.io/badge/specsmith-v0.3.5%2B-4ec9b0)](https://github.com/BitConcepts/specsmith)
[![Sponsor](https://img.shields.io/badge/sponsor-%E2%9D%A4-ea4aaa?logo=github)](https://github.com/sponsors/BitConcepts)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.85%2B-blue?logo=visualstudiocode)](https://code.visualstudio.com/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](https://github.com/BitConcepts/specsmith-vscode/blob/main/LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-specsmith--vscode-black?logo=github)](https://github.com/BitConcepts/specsmith-vscode)

**Applied Epistemic Engineering workbench for VS Code.**

The specsmith AEE Workbench brings the full specsmith workflow into VS Code: AI agent sessions, the
7-phase AEE workflow tracker, **6-tab Settings panel**, execution profiles, FPGA/HDL tool support,
live Ollama model management, and epistemic engineering tools — all in a dedicated sidebar.

---

## Requirements

- VS Code 1.85+
- [specsmith](https://github.com/BitConcepts/specsmith) **v0.3.5+** on PATH
- An LLM provider: API key (Anthropic/OpenAI/Gemini/Mistral) or local [Ollama](https://ollama.ai)

```bash
pipx install specsmith                    # recommended
pipx inject specsmith anthropic           # + Claude
pipx inject specsmith openai              # + GPT / O-series
```

---

## Features

### 🌱 AEE Workflow Phase Indicator

Track exactly where your project is in the Applied Epistemic Engineering cycle:

```
🌱 Inception → 🏗 Architecture → 📋 Requirements → ✅ Test Spec
   → ⚙ Implementation → 🔬 Verification → 🚀 Release
```

The Settings Panel shows a live phase bar with:
- Current phase pill with emoji and label
- Readiness % (how many prerequisites are satisfied)
- Step indicator (e.g. `step 3/7`)
- **→ next phase** button — runs `specsmith phase next` in a terminal
- Phase selector dropdown — jump to any phase

### 🧠 AI Agent Sessions

Each project runs an independent `specsmith run --json-events` agent process:

- Styled chat UI with user/agent/tool/system bubbles
- Token meter with real-time context fill bar and cost estimate
- Chat history saved to `.specsmith/chat/` and replayed on re-open
- Session status icons in sidebar: 🟡 Starting / 🟢 Ready / ⚙ Running / ⚠ Error
- Auto-start protocol: sync → load AGENTS.md → read LEDGER.md

### ⚙️ 6-Tab Settings Panel (`Ctrl+Shift+G`)

**Project** — scaffold.yml form: name, type (35 project types), description, languages (multi-select with filter), VCS platform. Detect Languages + Scan Project auto-populate the form.

**Tools** — FPGA/HDL tool chips (21 tools), auxiliary disciplines for mixed projects, target platforms, installed Ollama models with Update/Remove buttons.

**Files** — governance file status (scaffold.yml, AGENTS.md, REQUIREMENTS.md, TEST_SPEC.md, ARCHITECTURE.md, LEDGER.md) with Add/Open/Rename buttons.

**Updates & System** — PyPI version check; **Install Update** respects the `specsmith.releaseChannel` setting and swaps to **↺ Reload Window** after install. System info: OS, CPU, RAM, GPU, disk.

**Actions & AI** — Quick actions grid (audit, validate, doctor, epistemic, stress-test, export) + 10 pre-written AI prompts routed to the active session.

**Execution** — Execution profile selector (🔒 safe / ⚙️ standard / 🔓 open / ⚠ admin), custom allowed/blocked command overrides, and Tool Installer (scan + one-click install for missing tools).

### 🖥 Ollama — Local LLMs

First-class Ollama integration with 9-model curated catalog:

- Model dropdown: `Installed` and `Available to Download` groups, VRAM-filtered
- Select an undownloaded model → confirmation → VS Code progress notification with Cancel
- `specsmith: Select Model for Task` — task-specific model picker
- GPU VRAM auto-detection: context window scaled to hardware (4K/8K/16K/32K)
- **Automatic 404 recovery**: resolves quantization-suffix mismatches (e.g. `qwen2.5:14b` → `qwen2.5:14b-instruct-q4_K_M`)

### 🔌 FPGA / HDL Tool Support

Select which FPGA/HDL tools your project uses from the Tools tab. Saved as `fpga_tools:` in `scaffold.yml`. specsmith uses this to generate CI adapters and AGENTS.md guidance.

Supported: **Synthesis:** vivado, quartus, radiant, diamond, gowin. **Simulation:** ghdl, iverilog, verilator, modelsim, questasim, xsim. **Waveform:** gtkwave, surfer. **Linting:** vsg, verible, svlint. **Formal:** symbiyosys. **OSS:** yosys, nextpnr, openFPGALoader.

### 💬 Rich Chat Features

- Drag & drop files or screenshots into the chat to inject as context
- `Ctrl+V` pastes screenshots directly
- Hover messages for copy ⎘, edit ✏, or regenerate ↺ buttons
- Export chat as Markdown, clear with one click
- Resizable input area (drag the teal handle up)
- `@` in empty input → file picker
- `↑` in empty input → recall last message

### 🔑 API Key Management

API keys stored in OS credential store (Windows Credential Manager / macOS Keychain) via VS Code SecretStorage. Never written to `settings.json` or any file.

---

## Quick Start

1. Install specsmith: `pipx install specsmith`
2. Clone the extension and open in VS Code
3. Press `F5` to launch the Extension Development Host
4. Click the **🧠** icon in the Activity Bar
5. Set API key: `Ctrl+Shift+P → specsmith: Set API Key`
6. Press `Ctrl+Shift+;` to start an agent session

The Settings Panel opens automatically when a workspace is present.

---

## Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| `specsmith: New Agent Session` | `Ctrl+Shift+;` | Open a new agent session tab |
| `specsmith: Open Settings Panel` | `Ctrl+Shift+G` | Open the 6-tab Settings Panel |
| `specsmith: Set API Key` | | Store an LLM API key securely |
| `specsmith: API Key Status` | | Show which keys are configured |
| `specsmith: Clear API Key` | | Remove a stored key |
| `specsmith: Quick Add Requirement` | `Ctrl+Shift+R` | Add a REQ to REQUIREMENTS.md |
| `specsmith: Navigate Requirements` | `Ctrl+Shift+Q` | QuickPick through all REQ IDs |
| `specsmith: Open Scaffolding File` | | Open scaffold.yml |
| `specsmith: Run Audit` | | Run `specsmith audit` in session |
| `specsmith: Run Validate` | | Run `specsmith validate` |
| `specsmith: Run Doctor` | | Run `specsmith doctor` |
| `specsmith: Download Ollama Model` | | Download a model via `ollama pull` |
| `specsmith: Select Model for Task` | | Task-based model recommendations |
| `specsmith: Install or Upgrade specsmith` | | Install/upgrade via terminal |
| `specsmith: Clear Chat History` | | Clear current session chat |
| `specsmith: Add Project Folder` | | Add a project to the sidebar |
| `specsmith: Create New Project` | | Scaffold a new project |
| `specsmith: Import Existing Project` | | Import an existing project |
| `specsmith: Show Help` | `Ctrl+Shift+H` | Show help panel |

---

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `specsmith.executablePath` | `specsmith` | Path to specsmith CLI |
| `specsmith.defaultProvider` | `anthropic` | Default LLM provider |
| `specsmith.defaultModel` | `` | Default model (blank = provider default) |
| `specsmith.ollamaContextLength` | `0` | Ollama context size (0 = auto-detect from GPU VRAM) |
| `specsmith.autoOpenGovernancePanel` | `true` | Auto-open Settings panel on VS Code start |
| `specsmith.releaseChannel` | `stable` | Release channel for Install/Upgrade: `stable` or `pre-release` |

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+;` | New agent session |
| `Ctrl+Shift+G` | Open Settings Panel |
| `Ctrl+Shift+R` | Quick add requirement |
| `Ctrl+Shift+Q` | Navigate requirements (QuickPick) |
| `Enter` | Send message |
| `Shift+Enter` | New line in message input |
| `↑` (empty input) | Recall last message |
| `@` (empty input) | File picker (inject as context) |
| `Escape` | Stop agent |

---

## Architecture

The extension spawns `specsmith run --json-events` as a child process per session:

```
specsmith run --json-events --project-dir <dir> --provider <p> --model <m>
        ↑ stdin: user messages (one UTF-8 line per message)
        ↓ stdout: JSONL events (ready, llm_chunk, tool_started, tokens, turn_done, error...)
```

All AI reasoning, tool execution, and governance logic lives in the Python CLI. The extension is a
pure UI layer — TypeScript/VS Code only. This means the CLI can be used standalone, upgraded
independently, and tested without VS Code.

### Source layout

```
src/
  extension.ts       — activation, command registration, session tree
  SessionPanel.ts    — WebviewPanel with chat UI and bridge lifecycle
  GovernancePanel.ts — 6-tab Settings webview (phase, scaffold, tools, files, updates, actions, execution)
  ProjectTree.ts     — sidebar project tree with governance docs and file operations
  OllamaManager.ts   — GPU detection, model catalog, download, recommendations
  ModelRegistry.ts   — live model lists from provider REST APIs with 5-min cache
  ApiKeyManager.ts   — SecretStorage CRUD for all provider keys
  bridge.ts          — process spawn, stdin/stdout JSONL protocol, kill
  EpistemicBar.ts    — status bar polling epistemic score
  HelpPanel.ts       — static help webview
  types.ts           — shared event/message types
```

---

## Development

```bash
npm install
npm run build      # one-shot esbuild bundle
npm run watch      # incremental watch mode
npm run lint       # tsc --noEmit typecheck
npm run package    # produce .vsix (requires vsce)
```

Press `F5` in VS Code to open an Extension Development Host window.

---

## Troubleshooting

**specsmith not found** — Install via `pipx install specsmith` or set `specsmith.executablePath`. Run `Ctrl+Shift+P → specsmith: Install or Upgrade` for guided install.

**Ollama 404** — Open the model dropdown and select from the **Installed** group. The model name saved in your settings may differ from what Ollama has installed (quantization suffix). The extension auto-resolves this from v0.3.1+.

**Ollama not running** — `ollama serve` or open the Ollama desktop app.

**API key 401** — `Ctrl+Shift+P → specsmith: Set API Key` to re-enter.

**API key 429** — Quota exceeded; add billing credits at your provider's portal.

---

## Supporting the Project

If specsmith is saving you time, consider [sponsoring BitConcepts](https://github.com/sponsors/BitConcepts) or ⭐ starring both repos. It helps prioritize features and bug fixes.

---

## Links

- [specsmith CLI](https://github.com/BitConcepts/specsmith)
- [Documentation](https://specsmith.readthedocs.io)
- [AEE Workflow Phases](https://specsmith.readthedocs.io/en/stable/commands/#specsmith-phase)
- [Ollama](https://ollama.ai)
- [Sponsor BitConcepts](https://github.com/sponsors/BitConcepts)
- [Contributing](CONTRIBUTING.md)
