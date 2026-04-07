# Contributing to specsmith AEE Workbench

The VS Code extension is a pure UI layer — all AI reasoning, tool execution, and governance logic
lives in the [specsmith Python CLI](https://github.com/BitConcepts/specsmith). The extension
communicates with the CLI via `specsmith run --json-events` (JSONL over stdout/stdin).

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | 18+ | `node --version` |
| npm | 9+ | comes with Node |
| TypeScript | 5.3+ | installed as dev dep |
| VS Code | 1.85+ | for the Extension Dev Host |
| specsmith CLI | 0.3.5+ | `pipx install specsmith` |

---

## Development Setup

```bash
git clone https://github.com/BitConcepts/specsmith-vscode
cd specsmith-vscode
npm install
npm run build       # one-shot esbuild bundle → out/extension.js
```

### Running in VS Code

Press **`F5`** to open the **Extension Development Host** — a second VS Code window with the
extension loaded from `out/extension.js`. Any change requires re-running `npm run build` (or use
`npm run watch` for continuous incremental rebuilds):

```bash
npm run watch       # incremental rebuild on file save
```

Reload the Extension Development Host window after each rebuild: `Ctrl+Shift+P → Developer: Reload Window`.

---

## Running Checks

```bash
npm run lint        # tsc --noEmit  (TypeScript type check — no emit)
npm run build       # esbuild bundle (catches import/syntax errors)
```

There is no automated test suite for the extension. Testing is done manually in the Extension
Development Host. The integration logic (agent sessions, tool execution, specsmith commands) is
tested by the specsmith CLI's own 214-test pytest suite.

---

## Source Layout

```
src/
  extension.ts        — Activation, command registration, session/project tree providers.
                        openSession() creates a SessionPanel and shows the Settings panel.
  SessionPanel.ts     — WebviewPanel with chat UI, SpecsmithBridge lifecycle, chat history (JSONL).
  GovernancePanel.ts  — 6-tab Settings webview. All HTML generated server-side as a template literal.
                        Tabs: Project | Tools | Files | Updates | Actions | Execution
  bridge.ts           — Spawns `specsmith run --json-events` as a child process.
                        Reads JSONL events from stdout; sends user messages to stdin (one UTF-8 line each).
                        Handles model hot-swap, kill, restart, startup timeout, turn timeout.
  OllamaManager.ts    — GPU VRAM detection, 9-model curated catalog, download with CancellationToken.
  ModelRegistry.ts    — Live model lists from provider REST APIs with 5-min cache + static fallback.
  ApiKeyManager.ts    — SecretStorage CRUD for all provider API keys.
  EpistemicBar.ts     — Status bar item polling `specsmith epistemic-audit --brief`.
  HelpPanel.ts        — Static help WebviewPanel.
  ProjectTree.ts      — Sidebar tree: project folders + governance docs + full file tree.
  types.ts            — Shared TypeScript types for events and messages.

.github/
  FUNDING.yml         — Sponsor button configuration
  SECURITY.md         — Vulnerability reporting policy
  dependabot.yml      — npm + github-actions weekly updates
  ISSUE_TEMPLATE/     — Bug report and feature request templates
  PULL_REQUEST_TEMPLATE.md
```

---

## JSONL Bridge Protocol

The extension communicates with the specsmith agent via:

```
specsmith run --json-events --project-dir <dir> --provider <p> --model <m>
        ↑ stdin:  user messages (one UTF-8 line each, no framing)
        ↓ stdout: JSONL event stream, one event per line
```

**Incoming events** (stdout → extension → webview):

| type | fields | meaning |
|------|--------|---------|
| `ready` | provider, model, tools, skills | Agent started; extension auto-sends `start` |
| `llm_chunk` | text | A text response fragment |
| `tool_started` | name, args | Tool call beginning |
| `tool_finished` | name, result, is_error | Tool call result |
| `tool_blocked` | name, reason | Execution profile blocked a tool |
| `tokens` | in_tokens, out_tokens, cost_usd | Credit meter update |
| `turn_done` | total_tokens, cost_usd | LLM turn complete |
| `error` | message | Recoverable error |
| `system` | message | Info/status message |

**Outgoing messages** (extension → stdin):

- Any text string → treated as a user message
- `/model <name>` → hot-switch model without restarting

---

## Webview Security

GovernancePanel, SessionPanel, and HelpPanel all use `'unsafe-inline'` in CSP for styles and
scripts. This is acceptable because:

- All HTML/JS is generated server-side in TypeScript (no untrusted input in script context)
- No remote scripts or stylesheets are loaded (`default-src 'none'`)
- The webview has no access to the file system or Node.js APIs

---

## Making Changes to the GovernancePanel

The Settings panel is generated as a single `/* html */` template literal in `_html()`. All
tab panes are rendered at once and shown/hidden with CSS `display`. This avoids any async
re-renders and keeps state management simple.

When adding a new tab:
1. Add a `<button class="tab">` entry
2. Add `'newtab'` to the `tabs` array in the `sw()` JS function
3. Add `<div id="t-newtab" class="tab-pane">` HTML
4. Add any message handlers needed in `_handleMsg()`
5. Update `GovMsg.command` union type if new messages are added

---

## Submitting Changes

1. Branch from `main`
2. `npm run build` and `npm run lint` must pass
3. Test manually in the Extension Development Host (F5)
4. Update `CHANGELOG.md` and `README.md` for user-facing changes
5. Open a PR using the PR template

---

## Reporting Issues

- **Security vulnerabilities**: see [SECURITY.md](.github/SECURITY.md)
- **Bugs**: [GitHub Issues](https://github.com/BitConcepts/specsmith-vscode/issues/new?template=bug_report.md)
- **Feature requests**: [GitHub Issues](https://github.com/BitConcepts/specsmith-vscode/issues/new?template=feature_request.md)

---

## Supporting the Project

If specsmith is useful to you, consider [sponsoring BitConcepts](https://github.com/sponsors/BitConcepts)
or starring the [specsmith](https://github.com/BitConcepts/specsmith) and
[specsmith-vscode](https://github.com/BitConcepts/specsmith-vscode) repos.
