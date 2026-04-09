# AGENTS.md — specsmith-vscode

## Identity
- **Project**: specsmith-vscode (VS Code Extension)
- **Type**: VS Code Extension (TypeScript)
- **Language**: TypeScript (esbuild bundled)
- **Platforms**: Windows, Linux, macOS (via VS Code)
- **Parent project**: [specsmith](https://github.com/BitConcepts/specsmith)

## Purpose
The specsmith AEE Workbench — flagship VS Code client for the specsmith Applied Epistemic Engineering toolkit. Provides AI agent sessions, project governance panels, AEE lifecycle phase tracking, Ollama local model management, and a comprehensive user guide to the AEE process.

## Quick Commands
- `npm install` — install dependencies
- `npm run build` — esbuild bundle
- `npm run lint` — TypeScript type check (`tsc --noEmit`)
- `npm run watch` — esbuild watch mode
- Press `F5` in VS Code — launch Extension Development Host

## File Registry
- `src/extension.ts` — extension entry point
- `src/SessionPanel.ts` — AI agent chat sessions (per-project JSONL bridge)
- `src/GovernancePanel.ts` — Project Settings panel (5 tabs: Project, Tools, Files, Actions, Execution)
- `src/SettingsPanel.ts` — Global Settings panel (Environment, Ollama, System)
- `src/HelpPanel.ts` — Help & user guide panel
- `src/bridge.ts` — specsmith CLI process bridge
- `src/VenvManager.ts` — Python venv lifecycle management
- `src/OllamaManager.ts` — Ollama model management
- `package.json` — extension manifest, commands, settings, keybindings

## Governance
This extension is a pure UI layer — all AI logic lives in the specsmith Python CLI. The extension communicates via `specsmith run --json-events` (stdin/stdout JSONL bridge).

Documentation for this extension lives in the specsmith RTD site:
- **[specsmith.readthedocs.io/vscode-extension](https://specsmith.readthedocs.io/en/latest/vscode-extension/)** — full extension documentation
- **[specsmith.readthedocs.io/aee-primer](https://specsmith.readthedocs.io/en/latest/aee-primer/)** — AEE process guide

## Documentation Rule (H14 — Hard Rule)

Before committing ANY change, verify documentation is current:
1. Check if the change affects user-facing behavior, panels, commands, settings, or keybindings
2. If yes: update `docs/site/vscode-extension.md` in the **specsmith repo** in a coordinated commit
3. Update this project's README.md if it affects the project summary
4. The HelpPanel.ts acts as an in-app user guide — keep it current when commands or panels change
5. Never commit UI changes without checking the RTD docs and HelpPanel for gaps

This is a hard rule. Undocumented features are governance violations.

## Tech Stack
- Language: TypeScript
- Bundler: esbuild
- Types: tsc --noEmit (strict)
- UI: VS Code Webview API (raw HTML/CSS/JS)
- Process bridge: child_process (stdin/stdout JSONL)
- Secret storage: VS Code SecretStorage API (OS credential store)
