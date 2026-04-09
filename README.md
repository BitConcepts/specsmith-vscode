# specsmith — AEE Workbench

[![specsmith](https://img.shields.io/badge/specsmith-v0.3.6%2B-4ec9b0)](https://github.com/BitConcepts/specsmith)
[![Sponsor](https://img.shields.io/badge/sponsor-%E2%9D%A4-ea4aaa?logo=github)](https://github.com/sponsors/BitConcepts)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.85%2B-blue?logo=visualstudiocode)](https://code.visualstudio.com/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](https://github.com/BitConcepts/specsmith-vscode/blob/main/LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-specsmith--vscode-black?logo=github)](https://github.com/BitConcepts/specsmith-vscode)

**Applied Epistemic Engineering workbench for VS Code.**

The specsmith AEE Workbench brings the full specsmith workflow into VS Code: AI agent sessions
with VCS context, the 7-phase AEE workflow tracker, dual settings panels, execution profiles,
FPGA/HDL tool support, live Ollama model management, and epistemic engineering tools — all in a
dedicated sidebar.

---

## Requirements

- VS Code 1.85+
- An LLM provider: API key (Anthropic/OpenAI/Gemini/Mistral) or local [Ollama](https://ollama.ai)
- Python 3.10+ (for the specsmith environment)

### First-Time Setup

1. Install the extension from the `.vsix` or VS Code Marketplace
2. Press **`Ctrl+Shift+,`** to open **⚙ specsmith Settings**
3. Click **🔒 Create Environment** — creates `~/.specsmith/venv/` with specsmith and your provider packages
4. VS Code will prompt to restart after the terminal finishes
5. Set your API key: `Ctrl+Shift+P → specsmith: Set API Key`
6. Press `Ctrl+Shift+;` to start an agent session

The extension requires the environment before any session can start. Sessions are blocked with a
prompt if the environment is missing.

---

## Two-Panel Architecture

### ⚙ specsmith Settings  (`Ctrl+Shift+,`)

**Global settings — not tied to any project. Opens even with no workspace.**

| Tab | Contents |
|-----|----------|
| **🔧 Environment** | Global venv at `~/.specsmith/venv/` — Create / Update / Rebuild / Delete; Remove System Installs; specsmith version check + update; release channel |
| **🤖 Ollama** | Installed model table (Update/Remove per model, Update All); Ollama version check; Upgrade button |
| **💻 System** | OS, CPU, cores, RAM, GPU, disk info |

After any environment operation, a persistent **↺ Restart VS Code** banner appears in the panel
(replaces transient popups that disappear before you see them).

### ⚙ Project Settings  (`Ctrl+Shift+G`)

**Per-project settings — requires an open project or session.**

| Tab | Contents |
|-----|----------|
| **📁 Project** | scaffold.yml form: name, type (35 types), description, languages, VCS platform. Detect Languages + Scan Project auto-fill. |
| **🔧 Tools** | FPGA/HDL tool chips (21 tools), auxiliary disciplines for mixed projects, target platforms |
| **📋 Files** | Governance file status (scaffold.yml, AGENTS.md, REQUIREMENTS.md, TEST_SPEC.md, ARCHITECTURE.md, LEDGER.md) with Add/Open buttons |
| **⚡ Actions** | Quick actions grid (audit, validate, doctor, epistemic, stress-test, export, req list, tools scan, phase) + 10 AI prompt shortcuts |
| **🛡 Execution** | Execution profile selector (🔒 safe / ⚙ standard / 🔓 open / ⚠ admin), custom allowed/blocked command overrides, Tool Installer (scan + one-click install) |

Both panels open as tabs in the same VS Code editor column when a session starts.

---

## Features

### 🌱 AEE Workflow Phase Indicator

Track your project through the 7-phase AEE cycle in the Project Settings header:

```
🌱 Inception → 🏗 Architecture → 📋 Requirements → ✅ Test Spec
   → ⚙ Implementation → 🔬 Verification → 🚀 Release
```

Live phase bar shows: current phase pill · readiness % · step N/7 · → next phase button · phase selector dropdown.

### 🧠 AI Agent Sessions

Each project runs an independent `specsmith run --json-events` agent process:

- **VCS context on open** — `git status` + recent commits shown as a system message; agent system prompt includes the VCS snapshot
- Styled chat UI with user / agent / tool / system bubbles
- Token meter with real-time context fill bar and cost estimate
- Chat history saved to `.specsmith/chat/` and replayed on re-open
- Session status icons in sidebar: 🟡 Starting / 🟢 Ready / ⚙ Running / ⚠ Error
- Auto-start protocol: git status → AGENTS.md → LEDGER.md → propose next action
- **🐛 Report Bug** buttons on Python crash tool errors

### 🖥 Ollama — Local LLMs

- Model dropdown: `Installed` and `Available to Download` groups, VRAM-filtered
- Select an undownloaded model → confirmation → progress notification with Cancel
- `specsmith: Select Model for Task` — task-specific model picker
- GPU VRAM auto-detection: context window scaled to hardware (4K/8K/16K/32K tokens)
- **Automatic 404 recovery**: resolves quantization-suffix mismatches
- **`keep_alive=-1`**: model stays loaded between turns for consistent context

### 🔌 FPGA / HDL Tool Support

21 tools selectable in Project Settings > Tools. Saved as `fpga_tools:` in scaffold.yml.

**Synthesis:** vivado, quartus, radiant, diamond, gowin  
**Simulation:** ghdl, iverilog, verilator, modelsim, questasim, xsim  
**Waveform:** gtkwave, surfer | **Linting:** vsg, verible, svlint  
**Formal:** symbiyosys | **OSS:** yosys, nextpnr, openFPGALoader

### 💬 Rich Chat Features

- Drag & drop files or screenshots into the chat to inject as context
- `Ctrl+V` pastes screenshots directly
- Hover messages for copy ⎘, edit ✏, or regenerate ↺
- Tool events show actual command text: `⏳ Running command → git status…`
- Export chat as Markdown, clear with one click
- `@` in empty input → file picker | `↑` → recall last message

### 🔑 API Key Management

Keys stored in OS credential store (Windows Credential Manager / macOS Keychain) via VS Code
SecretStorage. Never written to `settings.json` or any file.

---

## Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| `specsmith: New Agent Session` | `Ctrl+Shift+;` | Open a new agent session tab |
| `specsmith: Settings` | `Ctrl+Shift+,` | Open ⚙ specsmith Settings (global) |
| `specsmith: Open Project Settings` | `Ctrl+Shift+G` | Open ⚙ Project Settings (per-project) |
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
| `specsmith: Report Issue` | | File a bug or feature request |

---

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `specsmith.executablePath` | `specsmith` | Fallback path to specsmith CLI (venv takes precedence) |
| `specsmith.envPath` | `` | Custom environment path (blank = `~/.specsmith/venv/`) |
| `specsmith.defaultProvider` | `anthropic` | Default LLM provider |
| `specsmith.defaultModel` | `` | Default model (blank = provider default) |
| `specsmith.ollamaContextLength` | `0` | Ollama context size (0 = auto-detect from GPU VRAM) |
| `specsmith.autoOpenGovernancePanel` | `true` | Auto-open both panels on VS Code start |
| `specsmith.releaseChannel` | `stable` | `stable` or `pre-release` for Install/Upgrade |

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+;` | New agent session |
| `Ctrl+Shift+,` | Open ⚙ specsmith Settings (global) |
| `Ctrl+Shift+G` | Open ⚙ Project Settings (per-project) |
| `Ctrl+Shift+R` | Quick add requirement |
| `Ctrl+Shift+Q` | Navigate requirements (QuickPick) |
| `Ctrl+Shift+H` | Help panel (when session is active) |
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
        ↑ stdin:  user messages (one UTF-8 line per message)
        ↓ stdout: JSONL events (ready, llm_chunk, tool_started, tokens, turn_done, error…)
```

The global venv at `~/.specsmith/venv/` is used automatically when present.
All AI reasoning, tool execution, and governance logic lives in the Python CLI. The extension
is a pure UI layer — TypeScript/VS Code only.

### Source layout

```
src/
  extension.ts       — activation, command registration, session tree, venv enforcement
  SessionPanel.ts    — WebviewPanel with chat UI, VCS display, bridge lifecycle
  SettingsPanel.ts   — Global Settings panel (venv, version, Ollama, system info)
  GovernancePanel.ts — Project Settings panel (scaffold, tools, files, actions, execution)
  VenvManager.ts     — Global venv (~/.specsmith/venv/) lifecycle management
  ProjectTree.ts     — sidebar project tree with governance docs and file operations
  OllamaManager.ts   — GPU detection, model catalog, download, recommendations
  ModelRegistry.ts   — live model lists from provider REST APIs with 5-min cache
  ApiKeyManager.ts   — SecretStorage CRUD for all provider keys
  bridge.ts          — process spawn, stdin/stdout JSONL protocol, kill
  EpistemicBar.ts    — status bar polling epistemic score
  HelpPanel.ts       — static help webview
  BugReporter.ts     — consent-gated GitHub issue filing
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

**Environment not found** — Open `Ctrl+Shift+,` → Environment tab → **Create Environment**.
Sessions cannot start until the environment is ready.

**specsmith not found in environment** — The environment may be corrupted. Use **Rebuild** in
specsmith Settings > Environment to delete and recreate it.

**Ollama 404** — Open the model dropdown and select from the **Installed** group. The extension
auto-resolves quantization-suffix mismatches from v0.3.1+.

**Ollama not running** — `ollama serve` or open the Ollama desktop app.

**API key 401** — `Ctrl+Shift+P → specsmith: Set API Key` to re-enter.

**API key 429** — Quota exceeded; add billing credits at your provider portal.

**Agent loses context** — With Ollama, this is often due to model unloading. v0.3.4+ sets
`keep_alive=-1` to keep the model in memory. If it persists, check GPU VRAM is sufficient for
the context window (`specsmith.ollamaContextLength`).

---

## Supporting the Project

specsmith is open source and built by a small team. Every bit of support helps:

- ⭐ **Star** [specsmith](https://github.com/BitConcepts/specsmith) and [specsmith-vscode](https://github.com/BitConcepts/specsmith-vscode) on GitHub
- 📣 **Tell your friends and colleagues** — word of mouth is our best growth channel
- 🐛 **Report bugs** via [Issues](https://github.com/BitConcepts/specsmith-vscode/issues) — include VS Code + specsmith versions
- 💡 **Suggest features** via [Discussions](https://github.com/BitConcepts/specsmith-vscode/discussions) — we read every suggestion
- 🔧 **Fix bugs and contribute** — see [CONTRIBUTING.md](CONTRIBUTING.md); TypeScript PRs welcome
- 📝 **Write about specsmith** — blog posts, tutorials, and demos help the community grow
- ❤️ **[Sponsor BitConcepts](https://github.com/sponsors/BitConcepts)** — directly funds development

---

## Links

- [specsmith CLI](https://github.com/BitConcepts/specsmith)
- [Documentation](https://specsmith.readthedocs.io)
- [AEE Workflow Phases](https://specsmith.readthedocs.io/en/stable/commands/#specsmith-phase)
- [Ollama](https://ollama.ai)
- [Sponsor BitConcepts](https://github.com/sponsors/BitConcepts)
- [Contributing](CONTRIBUTING.md)
- [Privacy Policy](PRIVACY.md)
