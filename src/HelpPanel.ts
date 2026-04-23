// SPDX-License-Identifier: MIT
// Copyright (c) 2026 BitConcepts, LLC. All rights reserved.
import * as vscode from 'vscode';

let _panel: vscode.WebviewPanel | undefined;

export function showHelp(context: vscode.ExtensionContext): void {
  if (_panel) {
    _panel.reveal(vscode.ViewColumn.Beside);
    return;
  }

  _panel = vscode.window.createWebviewPanel(
    'specsmithHelp',
    'Help',
    vscode.ViewColumn.Beside,
    { enableScripts: false },
  );

  _panel.webview.html = _html();
  _panel.onDidDispose(() => { _panel = undefined; }, null, context.subscriptions);
}

function _html(): string {
  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>specsmith Help</title>
<style>
  :root {
    --bg:     var(--vscode-editor-background);
    --fg:     var(--vscode-editor-foreground);
    --h:      var(--vscode-textLink-foreground, #4ec9b0);
    --dim:    var(--vscode-descriptionForeground, #888);
    --border: var(--vscode-panel-border, #313244);
    --surface:var(--vscode-panel-background, #1e1e2e);
    --mono:   var(--vscode-editor-font-family, 'Cascadia Code', monospace);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--fg);
    font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
    font-size: 13px; line-height: 1.6;
    padding: 24px 28px; max-width: 860px;
  }
  h1 { color: var(--h); font-size: 20px; margin-bottom: 4px; }
  h2 { color: var(--h); font-size: 14px; margin: 24px 0 8px; border-bottom: 1px solid var(--border); padding-bottom: 4px; }
  h3 { font-size: 12px; font-weight: 600; margin: 12px 0 4px; }
  p  { margin-bottom: 8px; color: var(--dim); }
  a  { color: var(--h); }
  code {
    font-family: var(--mono); background: var(--surface);
    padding: 1px 6px; border-radius: 3px; font-size: 11px; color: var(--h);
  }
  table { width: 100%; border-collapse: collapse; margin: 8px 0; }
  th { text-align: left; font-size: 11px; color: var(--dim); padding: 4px 8px; border-bottom: 1px solid var(--border); }
  td { padding: 5px 8px; border-bottom: 1px solid var(--border); font-size: 12px; }
  td:first-child { font-family: var(--mono); font-size: 11px; color: var(--h); white-space: nowrap; }
  .badge {
    display: inline-block; background: var(--surface); border: 1px solid var(--border);
    border-radius: 3px; padding: 1px 6px; font-size: 10px; margin: 0 2px;
  }
  .tip { background: var(--surface); border-left: 3px solid var(--h); padding: 8px 12px; margin: 8px 0; border-radius: 0 4px 4px 0; }
</style>
</head>
<body>
<h1>🧠 specsmith AEE Workbench</h1>
<p>Applied Epistemic Engineering workbench for VS Code. Each session tab is an independent AI agent connected to a project directory.</p>

<h2>Getting Started</h2>
<div class="tip">
  <strong>First run:</strong> Set your API key via <code>Ctrl+Shift+P → specsmith: Set API Key</code>, then click <span class="badge">+</span> in the Sessions panel to open a new session.
</div>

<h2>Keyboard Shortcuts (in Chat)</h2>
<table>
  <tr><th>Shortcut</th><th>Action</th></tr>
  <tr><td>Ctrl+Enter</td><td>Send message</td></tr>
  <tr><td>↑ (empty input)</td><td>Recall last message</td></tr>
  <tr><td>@</td><td>Pick a file to inject as context</td></tr>
  <tr><td>Drag &amp; drop</td><td>Drop any file or screenshot onto the chat</td></tr>
  <tr><td>Ctrl+V / Cmd+V</td><td>Paste image from clipboard</td></tr>
</table>

<h2>Quick Tool Buttons</h2>
<table>
  <tr><th>Button</th><th>Equivalent CLI Command</th><th>What it does</th></tr>
  <tr><td>🔍 audit</td><td>specsmith audit</td><td>Check spec consistency, governance, and drift</td></tr>
  <tr><td>✅ validate</td><td>specsmith validate</td><td>Validate requirements against architecture</td></tr>
  <tr><td>🩺 doctor</td><td>specsmith doctor</td><td>Check project health: missing files, broken links</td></tr>
  <tr><td>🧠 epistemic</td><td>specsmith epistemic-audit</td><td>Run AEE belief certainty analysis</td></tr>
  <tr><td>⚡ stress-test</td><td>specsmith stress-test</td><td>Adversarial challenges to requirements</td></tr>
  <tr><td>🗑 clear</td><td>/clear</td><td>Clear conversation history (keeps system prompt)</td></tr>
  <tr><td>📊 status</td><td>status</td><td>Show session token usage and cost</td></tr>
</table>

<h2>Agent Slash Commands</h2>
<table>
  <tr><th>Command</th><th>What it does</th></tr>
  <tr><td>/help</td><td>Show agent's own command list</td></tr>
  <tr><td>/tools</td><td>List all available agent tools</td></tr>
  <tr><td>/skills</td><td>List loaded skills</td></tr>
  <tr><td>/model &lt;name&gt;</td><td>Switch model within the session</td></tr>
  <tr><td>/clear</td><td>Clear conversation history</td></tr>
  <tr><td>/save</td><td>Write a LEDGER.md entry for this session</td></tr>
  <tr><td>/status</td><td>Token usage, cost, and elapsed time</td></tr>
  <tr><td>exit / quit</td><td>End the agent session cleanly</td></tr>
</table>

<h2>Quick Commands (type the word, no slash)</h2>
<table>
  <tr><th>Command</th><th>What it does</th></tr>
  <tr><td>start</td><td>Session start protocol: sync + load state</td></tr>
  <tr><td>resume</td><td>Resume from last LEDGER.md entry</td></tr>
  <tr><td>save</td><td>Write a LEDGER.md entry</td></tr>
  <tr><td>audit</td><td>Run specsmith audit --fix</td></tr>
  <tr><td>commit</td><td>Run specsmith commit</td></tr>
  <tr><td>epistemic</td><td>Full AEE epistemic audit</td></tr>
  <tr><td>stress</td><td>Stress-test requirements</td></tr>
  <tr><td>status</td><td>Show session status + credit spend</td></tr>
</table>

<h2>Command Palette Commands</h2>
<table>
  <tr><th>Command</th><th>What it does</th></tr>
  <tr><td>specsmith: New Agent Session</td><td>Open a new agent tab</td></tr>
  <tr><td>specsmith: Set API Key</td><td>Store an API key securely (OS credential store)</td></tr>
  <tr><td>specsmith: Clear API Key</td><td>Remove a stored API key</td></tr>
  <tr><td>specsmith: API Key Status</td><td>Show which providers have keys configured</td></tr>
  <tr><td>specsmith: Add Project Folder</td><td>Add a project to the sidebar</td></tr>
  <tr><td>specsmith: Create New Project</td><td>Run specsmith init in a new directory</td></tr>
  <tr><td>specsmith: Import Existing Project</td><td>Run specsmith import on an existing project</td></tr>
  <tr><td>specsmith: Run Audit</td><td>Run audit in the active session</td></tr>
  <tr><td>specsmith: Run Validate</td><td>Run validate in the active session</td></tr>
  <tr><td>specsmith: Show Help</td><td>Show this panel</td></tr>
</table>

<h2>API Key Management</h2>
<p>Keys are stored in your OS credential store (Windows Credential Manager, macOS Keychain, libsecret on Linux) via VS Code's SecretStorage API. They never appear in <code>settings.json</code> and can't be read by other extensions.</p>
<p>Set once per machine — they're automatically injected into each agent process when sessions start.</p>

<h2>Session Status Indicators</h2>
<table>
  <tr><th>Icon</th><th>Meaning</th></tr>
  <tr><td>🟢 Green circle (spinning)</td><td>Agent is actively processing your message</td></tr>
  <tr><td>🟡 Amber/yellow circle</td><td>Session is ready, waiting for your input</td></tr>
  <tr><td>🟡 Yellow circle (starting)</td><td>Agent process is initializing</td></tr>
  <tr><td>🔴 Red circle</td><td>Session encountered an error</td></tr>
  <tr><td>⚪ Gray outline circle</td><td>Session is inactive / process has exited</td></tr>
</table>

<h2>Token Meter</h2>
<p>The bar below the chat shows context fill percentage for the current model's context window. Colors:</p>
<p>🟢 &lt;70% — healthy | 🟡 70–90% — warning (optimization banner shown) | 🔴 &gt;90% — critical</p>

<h2>AEE Project Lifecycle — 7 Phases</h2>
<p>Every specsmith project follows the Applied Epistemic Engineering lifecycle:</p>
<table>
  <tr><th>#</th><th>Phase</th><th>What You Do</th><th>Gate (must pass before advancing)</th></tr>
  <tr><td>1</td><td>🌱 Inception</td><td>Set up scaffold.yml, AGENTS.md, project type</td><td>scaffold.yml + AGENTS.md + LEDGER.md exist</td></tr>
  <tr><td>2</td><td>🏗 Architecture</td><td>Write ARCHITECTURE.md, define components</td><td>ARCHITECTURE.md ≥20 lines, trace vault has ≥1 seal</td></tr>
  <tr><td>3</td><td>📋 Requirements</td><td>Populate REQUIREMENTS.md, stress-test</td><td>≥5 formal REQ-* entries, TEST_SPEC.md exists</td></tr>
  <tr><td>4</td><td>✅ Test Spec</td><td>Write TEST_SPEC.md mapping to requirements</td><td>≥80% REQ coverage in TEST_SPEC.md</td></tr>
  <tr><td>5</td><td>⚙ Implementation</td><td>Code → commit → audit → ledger loop</td><td>LEDGER.md has content, TEST_SPEC.md exists</td></tr>
  <tr><td>6</td><td>🔬 Verification</td><td>Epistemic audit, trace vault sealed</td><td>Trace vault has seals, ≥80% coverage</td></tr>
  <tr><td>7</td><td>🚀 Release</td><td>CHANGELOG, tag, compliance report</td><td>CHANGELOG.md has version entry</td></tr>
</table>
<div class="tip">
  <strong>How to advance:</strong> Open the <strong>Project Settings</strong> panel — the phase bar shows your current position and readiness %. Click <strong>→ Next</strong> when all checks pass, or use <code>specsmith phase next</code> in the terminal.
</div>

<h2>AI-Guided Sessions</h2>
<p>The <strong>Actions</strong> tab in Project Settings shows prompts tailored to your current lifecycle phase. Click <strong>🤖 Start AI-Guided Session</strong> for a comprehensive walkthrough of the current phase — the AI will guide you step by step through the required artifacts.</p>
<p>You can also choose <strong>manual mode</strong>: use the individual phase prompts to do specific tasks at your own pace.</p>

<h2>Architecture</h2>
<p>The extension spawns <code>specsmith run --json-events</code> as a child process per session. Communication: user messages go to <strong>stdin</strong> (one line each); structured events come from <strong>stdout</strong> as newline-delimited JSON.</p>
<p>All AI logic lives in the Python CLI — the extension is a pure UI layer with no embedded LLM calls.</p>

<h2>Documentation &amp; Learning</h2>
<table>
  <tr><th>Resource</th><th>What You’ll Learn</th></tr>
  <tr><td><a href="https://specsmith.readthedocs.io/en/latest/aee-primer/">AEE Primer (Full Guide)</a></td><td>Applied Epistemic Engineering from zero to productive</td></tr>
  <tr><td><a href="https://specsmith.readthedocs.io/en/latest/epistemic-library/">epistemic Library</a></td><td>Standalone Python library for belief engineering</td></tr>
  <tr><td><a href="https://specsmith.readthedocs.io/en/latest/governance/">Governance Model</a></td><td>Closed-loop workflow, file hierarchy, modular governance</td></tr>
  <tr><td><a href="https://specsmith.readthedocs.io/en/latest/commands/">CLI Commands</a></td><td>Every specsmith command with options and examples</td></tr>
  <tr><td><a href="https://specsmith.readthedocs.io/en/latest/vscode-extension/">VS Code Extension</a></td><td>Full extension documentation (panels, shortcuts, config)</td></tr>
  <tr><td><a href="https://specsmith.readthedocs.io/en/latest/project-types/">Project Types</a></td><td>All 35+ project types with tools and governance rules</td></tr>
  <tr><td><a href="https://specsmith.readthedocs.io/en/latest/importing/">Importing Projects</a></td><td>How detection works, merge behavior, type inference</td></tr>
  <tr><td><a href="https://specsmith.readthedocs.io/en/latest/troubleshooting/">Troubleshooting</a></td><td>Common issues and solutions</td></tr>
</table>

<h2>Links</h2>
<p>
  <a href="https://specsmith.readthedocs.io">specsmith Documentation</a> ·
  <a href="https://github.com/BitConcepts/specsmith">specsmith on GitHub</a> ·
  <a href="https://github.com/BitConcepts/specsmith-vscode">Extension on GitHub</a>
</p>
</body>
</html>`;
}
