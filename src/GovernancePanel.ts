// SPDX-License-Identifier: MIT
// Copyright (c) 2026 BitConcepts, LLC. All rights reserved.
/**
 * GovernancePanel — AI-assisted governance file management.
 *
 * Opens as a WebviewPanel showing:
 *   - scaffold.yml structured form editor (project type, platforms, integrations)
 *   - Governance file status (REQUIREMENTS.md, AGENTS.md, LEDGER.md, etc.)
 *   - AI prompt palette (pre-written prompts → sent to active session)
 *   - Quick actions (run audit, validate, upgrade)
 *
 * All AI assistance routes through the active specsmith agent session, so
 * the agent's full project context and file-write tools are available.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

let _panel: vscode.WebviewPanel | undefined;

export function showGovernancePanel(
  context: vscode.ExtensionContext,
  projectDir: string,
  sendToSession: (text: string) => void,
): void {
  if (_panel) {
    _panel.reveal(vscode.ViewColumn.Beside);
    void _panel.webview.postMessage({ command: 'refresh', projectDir });
    return;
  }

  _panel = vscode.window.createWebviewPanel(
    'specsmithGovernance',
    '🧠 Governance',
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  const data = _loadProjectData(projectDir);
  _panel.webview.html = _html(data);

  _panel.webview.onDidReceiveMessage((msg: GovernancePanelMessage) => {
    switch (msg.command) {
      case 'saveScaffold':
        if (msg.scaffold) { _saveScaffold(projectDir, msg.scaffold); }
        break;
      case 'runCommand':
        if (msg.cmd) { _runInTerminal(context, msg.cmd, projectDir); }
        break;
      case 'sendToAgent':
        if (msg.prompt) { sendToSession(msg.prompt); }
        break;
      case 'openFile':
        if (msg.file) {
          const fp = path.join(projectDir, msg.file);
          if (fs.existsSync(fp)) {
            void vscode.window.showTextDocument(vscode.Uri.file(fp));
          }
        }
        break;
      case 'refresh':
        // Re-read files and update panel
        _panel?.webview.postMessage({ command: 'data', data: _loadProjectData(projectDir) });
        break;
    }
  }, null, context.subscriptions);

  _panel.onDidDispose(() => { _panel = undefined; }, null, context.subscriptions);
}

// ── Data loading ──────────────────────────────────────────────────────────────

interface ScaffoldData {
  name?: string;
  type?: string;
  language?: string;
  description?: string;
  vcs_platform?: string;
  spec_version?: string;
  integrations?: string[];
  platforms?: string[];
}

interface GovernanceFile {
  rel: string;
  label: string;
  exists: boolean;
  lines?: number;
}

interface ProjectData {
  projectDir: string;
  scaffold: ScaffoldData;
  govFiles: GovernanceFile[];
}

interface GovernancePanelMessage {
  command: 'saveScaffold' | 'runCommand' | 'sendToAgent' | 'openFile' | 'refresh';
  scaffold?: ScaffoldData;
  cmd?: string;
  prompt?: string;
  file?: string;
}

function _loadProjectData(projectDir: string): ProjectData {
  const scaffoldPath = path.join(projectDir, 'scaffold.yml');
  let scaffold: ScaffoldData = {};
  if (fs.existsSync(scaffoldPath)) {
    try {
      // Simple YAML parser for key: value lines (no deps needed)
      const raw = fs.readFileSync(scaffoldPath, 'utf8');
      for (const line of raw.split('\n')) {
        const m = line.match(/^(\w+):\s*(.+)$/);
        if (m) {
          const [, key, val] = m;
          (scaffold as Record<string, string>)[key] = val.replace(/^["']|["']$/g, '').trim();
        }
        // Parse lists
        if (line.match(/^(integrations|platforms):$/)) {
          // handled below with multi-line parsing
        }
      }
      // Parse integrations and platforms as arrays
      const intM  = raw.match(/^integrations:\s*\n((?:- .+\n?)+)/m);
      const platM = raw.match(/^platforms:\s*\n((?:- .+\n?)+)/m);
      if (intM)  { scaffold.integrations = intM[1].match(/- (.+)/g)?.map(l => l.slice(2).trim()) ?? []; }
      if (platM) { scaffold.platforms    = platM[1].match(/- (.+)/g)?.map(l => l.slice(2).trim()) ?? []; }
    } catch { /* ignore parse errors */ }
  }

  const GOV_FILES: Array<{ rel: string; label: string }> = [
    { rel: 'scaffold.yml',          label: 'scaffold.yml' },
    { rel: 'AGENTS.md',             label: 'AGENTS.md' },
    { rel: 'REQUIREMENTS.md',       label: 'REQUIREMENTS.md' },
    { rel: 'docs/REQUIREMENTS.md',  label: 'docs/REQUIREMENTS.md' },
    { rel: 'docs/TEST_SPEC.md',     label: 'TEST_SPEC.md' },
    { rel: 'docs/architecture.md',  label: 'architecture.md' },
    { rel: 'LEDGER.md',             label: 'LEDGER.md' },
  ];

  const govFiles: GovernanceFile[] = GOV_FILES.map(({ rel, label }) => {
    const fp = path.join(projectDir, rel);
    const exists = fs.existsSync(fp);
    let lines: number | undefined;
    if (exists) {
      try { lines = fs.readFileSync(fp, 'utf8').split('\n').length; } catch { /* ignore */ }
    }
    return { rel, label, exists, lines };
  });

  return { projectDir, scaffold, govFiles };
}

function _saveScaffold(projectDir: string, scaffold: ScaffoldData): void {
  const p = path.join(projectDir, 'scaffold.yml');
  if (!fs.existsSync(p)) {
    void vscode.window.showWarningMessage('scaffold.yml not found — run specsmith init first');
    return;
  }
  // Read existing, update changed keys preserving structure
  let raw = fs.readFileSync(p, 'utf8');
  const updates: Record<string, string> = {
    name:         scaffold.name        ?? '',
    type:         scaffold.type        ?? '',
    language:     scaffold.language    ?? '',
    description:  scaffold.description ?? '',
    vcs_platform: scaffold.vcs_platform ?? '',
  };
  for (const [key, val] of Object.entries(updates)) {
    if (val !== undefined && val !== '') {
      const re = new RegExp(`^(${key}:)\\s*.+$`, 'm');
      if (re.test(raw)) {
        raw = raw.replace(re, `$1 ${val}`);
      }
    }
  }
  fs.writeFileSync(p, raw, 'utf8');
  void vscode.window.showInformationMessage('scaffold.yml saved. Run specsmith upgrade to apply.');
}

function _runInTerminal(
  context: vscode.ExtensionContext,
  cmd: string,
  projectDir: string,
): void {
  const cfg  = vscode.workspace.getConfiguration('specsmith');
  const exec = cfg.get<string>('executablePath', 'specsmith');
  const term = vscode.window.createTerminal({ name: 'specsmith governance', cwd: projectDir });
  term.sendText(`${exec} ${cmd} --project-dir "${projectDir}"`);
  term.show();
}

// ── Webview HTML ──────────────────────────────────────────────────────────────

const PROJECT_TYPES = [
  'cli-python','lib-python','web-backend-python','web-fullstack','web-frontend',
  'cli-rust','lib-rust','web-backend-rust','cli-go','lib-go','cli-node','lib-node',
  'cli-cpp','lib-cpp','embedded-c','embedded-cpp','fpga-rtl','mobile-ios',
  'mobile-android','mobile-flutter','dotnet-cli','dotnet-lib','dotnet-web',
  'microservice','data-pipeline','ml-model','research-academic','patent-application',
  'legal-contract','business-strategy','project-management',
];

const INTEGRATIONS = ['warp','claude','cursor','copilot','aider'];
const PLATFORMS    = ['linux','windows','macos','embedded','cloud'];

// Prompt palette — pre-written AI prompts for common governance tasks
const PROMPT_PALETTE = [
  { label: '📋 Review requirements',  prompt: 'Review REQUIREMENTS.md and identify any gaps, ambiguities, or missing test coverage. Suggest improvements.' },
  { label: '🔍 Run full audit',        prompt: 'Run specsmith audit and fix any issues found. Report what you changed.' },
  { label: '✅ Check REQ coverage',    prompt: 'Check that every requirement in REQUIREMENTS.md has a corresponding test in TEST_SPEC.md. List any uncovered requirements.' },
  { label: '📐 Improve architecture', prompt: 'Review docs/architecture.md and suggest improvements based on the current codebase. Update the file with your suggestions.' },
  { label: '📝 Update LEDGER',         prompt: 'Write a LEDGER.md entry summarising recent changes. Include what changed, what was tested, and next steps.' },
  { label: '🧠 Epistemic audit',       prompt: 'Run specsmith epistemic-audit and report the belief certainty scores. Identify the lowest-confidence requirements and suggest how to improve them.' },
  { label: '⚡ Stress test REQs',      prompt: 'Run specsmith stress-test on REQUIREMENTS.md. Apply adversarial challenges and report any failure modes or logic knots.' },
  { label: '🔄 Upgrade governance',    prompt: 'Run specsmith upgrade to the latest spec version. Report what templates were regenerated.' },
  { label: '📦 Export compliance',     prompt: 'Run specsmith export and save the compliance report to docs/compliance-report.md.' },
];

function _html(data: ProjectData): string {
  const s = data.scaffold;
  const typeOpts = PROJECT_TYPES.map(t =>
    `<option value="${t}"${s.type === t ? ' selected' : ''}>${t}</option>`,
  ).join('');
  const intChecks = INTEGRATIONS.map(i =>
    `<label><input type="checkbox" name="integration" value="${i}"${(s.integrations ?? []).includes(i) ? ' checked' : ''}> ${i}</label>`,
  ).join(' ');
  const platChecks = PLATFORMS.map(p =>
    `<label><input type="checkbox" name="platform" value="${p}"${(s.platforms ?? []).includes(p) ? ' checked' : ''}> ${p}</label>`,
  ).join(' ');
  const fileRows = data.govFiles.map(f => {
    const icon   = f.exists ? '✓' : '✗';
    const cls    = f.exists ? 'ok' : 'miss';
    const action = f.exists
      ? `<button class="tb" onclick="openFile('${f.rel}')">Open</button>`
      : `<span class="dim">not found</span>`;
    return `<tr><td class="${cls}">${icon}</td><td>${f.label}</td><td class="dim">${f.lines !== undefined ? f.lines + ' lines' : ''}</td><td>${action}</td></tr>`;
  }).join('');

  const promptItems = PROMPT_PALETTE.map(p =>
    `<button class="pb" onclick="sendToAgent(${JSON.stringify(p.prompt)})">${p.label}</button>`,
  ).join('');

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  :root{--bg:var(--vscode-editor-background);--fg:var(--vscode-editor-foreground);
    --sf:var(--vscode-panel-background,#1e1e2e);--br:var(--vscode-panel-border,#313244);
    --ib:var(--vscode-input-background);--if:var(--vscode-input-foreground);
    --bb:var(--vscode-button-background);--bf:var(--vscode-button-foreground);
    --teal:#4ec9b0;--red:#f44747;--grn:#4ec94e;--dim:#7f849c;
    --fn:var(--vscode-font-family,'Segoe UI',system-ui,sans-serif);
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--fg);font-family:var(--fn);font-size:13px;padding:16px;overflow-y:auto}
  h2{color:var(--teal);font-size:14px;margin:20px 0 8px;border-bottom:1px solid var(--br);padding-bottom:4px}
  h2:first-child{margin-top:0}
  label{font-size:11px;color:var(--dim);display:block;margin-bottom:2px}
  input[type=text],input[type=email],select{width:100%;background:var(--ib);color:var(--if);
    border:1px solid var(--br);border-radius:4px;padding:5px 8px;font-size:13px;font-family:var(--fn)}
  input[type=text]:focus,select:focus{outline:1px solid var(--teal)}
  input[type=checkbox]{margin-right:4px}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:8px}
  .row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:8px}
  .field{margin-bottom:8px}
  .checks{display:flex;flex-wrap:wrap;gap:8px;font-size:12px;margin-top:4px}
  .btn{background:var(--bb);color:var(--bf);border:none;border-radius:4px;padding:6px 14px;
    cursor:pointer;font-size:12px;font-weight:600}
  .btn:hover{opacity:.85}
  .btn-outline{background:none;border:1px solid var(--br);color:var(--dim);border-radius:4px;
    padding:4px 10px;cursor:pointer;font-size:11px}
  .btn-outline:hover{border-color:var(--teal);color:var(--teal)}
  .tb{background:none;border:1px solid var(--br);border-radius:3px;color:var(--dim);
    padding:2px 8px;cursor:pointer;font-size:10px}
  .tb:hover{border-color:var(--teal);color:var(--teal)}
  table{width:100%;border-collapse:collapse;font-size:12px}
  td{padding:4px 8px;border-bottom:1px solid var(--br)}
  .ok{color:var(--grn);font-weight:700;width:20px}
  .miss{color:var(--red);font-weight:700;width:20px}
  .dim{color:var(--dim);font-size:11px}
  .pb{background:var(--sf);border:1px solid var(--br);border-radius:5px;color:var(--fg);
    padding:7px 12px;cursor:pointer;font-size:12px;text-align:left;display:block;width:100%;margin-bottom:5px}
  .pb:hover{border-color:var(--teal);background:rgba(78,201,176,.06)}
  .qa-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
  .qa-btn{background:none;border:1px solid var(--br);border-radius:4px;color:var(--dim);
    padding:5px 8px;cursor:pointer;font-size:11px}
  .qa-btn:hover{border-color:var(--teal);color:var(--teal)}
  .notice{background:rgba(78,201,176,.08);border:1px solid rgba(78,201,176,.3);border-radius:4px;
    padding:8px 12px;font-size:11px;color:var(--teal);margin-bottom:12px}
</style>
</head>
<body>
<div class="notice">✦ Changes routed through the active agent session — open a session first for AI assistance.</div>

<h2>📁 scaffold.yml</h2>
<div class="row">
  <div class="field"><label>Project Name</label>
    <input type="text" id="name" value="${s.name ?? ''}"></div>
  <div class="field"><label>Language</label>
    <input type="text" id="language" value="${s.language ?? ''}"></div>
</div>
<div class="field"><label>Project Type</label>
  <select id="type">${typeOpts}</select></div>
<div class="field"><label>Description</label>
  <input type="text" id="description" value="${s.description ?? ''}"></div>
<div class="row">
  <div class="field"><label>VCS Platform</label>
    <input type="text" id="vcs_platform" value="${s.vcs_platform ?? ''}"></div>
  <div class="field"><label>Spec Version</label>
    <input type="text" id="spec_version" value="${s.spec_version ?? ''}" disabled style="opacity:.5"></div>
</div>
<div class="field"><label>Agent Integrations</label>
  <div class="checks">${intChecks}</div></div>
<div class="field"><label>Platforms</label>
  <div class="checks">${platChecks}</div></div>

<div style="display:flex;gap:8px;margin:12px 0">
  <button class="btn" onclick="saveScaffold()">💾 Save scaffold.yml</button>
  <button class="btn-outline" onclick="runCmd('upgrade')">↑ specsmith upgrade</button>
  <button class="btn-outline" onclick="sendToAgent('Review scaffold.yml and suggest any improvements to the project configuration, integrations, and type selection.')">🧠 Ask Agent</button>
</div>

<h2>📋 Governance Files</h2>
<table>
  <thead><tr><td></td><td><b>File</b></td><td class="dim">Size</td><td></td></tr></thead>
  <tbody>${fileRows}</tbody>
</table>

<h2>⚡ Quick Actions</h2>
<div class="qa-grid">
  <button class="qa-btn" onclick="runCmd('audit --fix')">🔍 audit --fix</button>
  <button class="qa-btn" onclick="runCmd('validate')">✅ validate</button>
  <button class="qa-btn" onclick="runCmd('doctor')">🩺 doctor</button>
  <button class="qa-btn" onclick="runCmd('epistemic-audit --brief')">🧠 epistemic</button>
  <button class="qa-btn" onclick="runCmd('stress-test')">⚡ stress-test</button>
  <button class="qa-btn" onclick="runCmd('export')">📄 export</button>
</div>

<h2>🤖 AI Prompt Palette</h2>
<p style="font-size:11px;color:var(--dim);margin-bottom:8px">Click to send a pre-written prompt to the active agent session:</p>
${promptItems}

<script>
const vscode = acquireVsCodeApi();
function saveScaffold() {
  const integrations = [...document.querySelectorAll('input[name=integration]:checked')].map(e=>e.value);
  const platforms    = [...document.querySelectorAll('input[name=platform]:checked')].map(e=>e.value);
  vscode.postMessage({
    command: 'saveScaffold',
    scaffold: {
      name:         document.getElementById('name').value,
      type:         document.getElementById('type').value,
      language:     document.getElementById('language').value,
      description:  document.getElementById('description').value,
      vcs_platform: document.getElementById('vcs_platform').value,
      integrations,
      platforms,
    }
  });
}
function runCmd(cmd) { vscode.postMessage({ command: 'runCommand', cmd }); }
function sendToAgent(prompt) { vscode.postMessage({ command: 'sendToAgent', prompt }); }
function openFile(file) { vscode.postMessage({ command: 'openFile', file }); }
window.addEventListener('message', ({data}) => {
  if (data.command === 'data') { /* future: live-refresh */ }
});
</script>
</body>
</html>`;
}
