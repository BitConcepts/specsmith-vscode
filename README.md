# specsmith — AEE Workbench (VS Code Extension)

Applied Epistemic Engineering workbench for VS Code.

## Features

- **Activity Bar** — dedicated specsmith sidebar with project tree and session list
- **Multi-tab sessions** — each project runs in its own VS Code editor tab with an independent agent process
- **Live agent chat** — styled chat UI with user/assistant/tool/system message bubbles
- **Token meter** — real-time context fill bar, token counts, and estimated cost per session
- **Epistemic status bar** — live `🧠 C=0.87 ✓` score in the status bar, polling your project's belief certainty
- **Quick tools** — one-click Audit, Validate, Doctor, Epistemic Audit from the input bar
- **Provider/model hot-swap** — switch provider and model within a running session
- **Auto-dark/light** — uses VS Code CSS variables; matches your active theme automatically

## Requirements

- [specsmith](https://github.com/BitConcepts/specsmith) installed and on PATH
  ```
  pip install specsmith[anthropic]
  ```
- An LLM provider API key (or Ollama running locally)

## Usage

1. Click the **🧠** icon in the Activity Bar to open the specsmith sidebar
2. Click **+** in the Sessions view to start a new agent session
3. Select your project folder, provider, and model
4. Chat with your AEE agent — it has access to all specsmith tools

## Commands

| Command | Description |
|---------|-------------|
| `specsmith: New Agent Session` | Open a new agent session tab |
| `specsmith: Add Project Folder` | Add a project to the sidebar |
| `specsmith: Run Audit` | Run specsmith audit in the active session |
| `specsmith: Run Validate` | Run specsmith validate |
| `specsmith: Run Doctor` | Run specsmith doctor |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `specsmith.executablePath` | `specsmith` | Path to specsmith CLI |
| `specsmith.defaultProvider` | `anthropic` | Default LLM provider |
| `specsmith.defaultModel` | `` | Default model (blank = provider default) |

## Architecture

The extension spawns `specsmith run --json-events` as a child process per session.
The bridge communicates via:
- **stdin** — user messages (one line per message)
- **stdout** — JSONL events (`llm_chunk`, `tool_started`, `tool_finished`, `tokens`, `turn_done`, `error`, `system`)

This keeps all AI logic in the Python CLI; the extension is a pure UI layer.

## Development

```bash
npm install
npm run build      # one-shot build
npm run watch      # incremental watch
npm run package    # produce .vsix
```

Press `F5` in VS Code to launch a new Extension Development Host window.
