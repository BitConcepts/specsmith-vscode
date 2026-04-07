// SPDX-License-Identifier: MIT
// Copyright (c) 2026 BitConcepts, LLC. All rights reserved.
/**
 * GovernancePanel v2 — AI-assisted governance file management.
 *
 * Features:
 *  - scaffold.yml structured form (project type, multiple languages, platforms, integrations, VCS)
 *  - Out-of-date detection: spec_version vs installed specsmith version
 *  - Governance file status with Add buttons for missing files
 *  - Quick actions grid (audit, validate, doctor, export, etc.)
 *  - AI prompt palette → routes prompts to the active agent session
 *  - Auto-opens a session if none is active when AI prompts are clicked
 *  - Refresh button to reload all data
 */
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

let _panel: vscode.WebviewPanel | undefined;

export function showGovernancePanel(
  context: vscode.ExtensionContext,
  projectDir: string,
  sendToSession: (text: string) => void,
  openSession: () => Promise<void>,
): void {
  if (_panel) {
    _panel.reveal(vscode.ViewColumn.Beside);
    _refreshPanel(projectDir, sendToSession, openSession);
    return;
  }

  _panel = vscode.window.createWebviewPanel(
    'specsmithGovernance',
    '🧠 Governance',
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  _panel.webview.html = _html(_loadProjectData(projectDir));

  _panel.webview.onDidReceiveMessage(
    (msg: GovMsg) => _handleMsg(context, msg, projectDir, sendToSession, openSession),
    null,
    context.subscriptions,
  );

  _panel.onDidDispose(() => { _panel = undefined; }, null, context.subscriptions);
}

function _refreshPanel(
  projectDir: string,
  sendToSession: (text: string) => void,
  openSession: () => Promise<void>,
): void {
  if (!_panel) { return; }
  _panel.webview.html = _html(_loadProjectData(projectDir));
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ScaffoldData {
  name?: string;
  type?: string;
  languages?: string[];     // multi-language support
  description?: string;
  vcs_platform?: string;
  spec_version?: string;
  integrations?: string[];
  platforms?: string[];
}

interface GovFile { rel: string; label: string; uppercase: boolean; exists: boolean; lines?: number; addCmd?: string; }
interface ProjectData { projectDir: string; scaffold: ScaffoldData; govFiles: GovFile[]; installedVersion: string | null; }

interface GovMsg {
  command: 'saveScaffold' | 'runCommand' | 'sendToAgent' | 'openFile' | 'refresh' | 'addFile';
  scaffold?: ScaffoldData;
  cmd?: string;
  prompt?: string;
  file?: string;
  addType?: string;
}

// ── Supported values ───────────────────────────────────────────────────────────

const LANGUAGES = [
  'Python','Rust','Go','C','C++','TypeScript','JavaScript','C#','Swift','Kotlin',
  'VHDL','SystemVerilog','Dart','Java','Ruby','PHP','Scala','Haskell','Lua','Bash',
  'YAML','Makefile',
];

const VCS_PLATFORMS = ['github','gitlab','bitbucket','azure-devops','gitea','none'];

const PROJECT_TYPES = [
  'cli-python','lib-python','web-backend-python','web-fullstack','web-frontend',
  'cli-rust','lib-rust','web-backend-rust','cli-go','lib-go','cli-node','lib-node',
  'cli-cpp','lib-cpp','embedded-c','embedded-cpp','fpga-rtl','mobile-ios',
  'mobile-android','mobile-flutter','dotnet-cli','dotnet-lib','dotnet-web',
  'microservice','data-pipeline','ml-model','research-academic','patent-application',
  'legal-contract','business-strategy','project-management','yocto-bsp',
];

const INTEGRATIONS = ['warp','claude','cursor','copilot','aider','continue'];
const PLATFORMS    = ['linux','windows','macos','embedded','cloud','wasm'];

// Governance files — all uppercase per convention
const GOV_FILES: Array<{ rel: string; label: string; addType: string }> = [
  { rel: 'scaffold.yml',         label: 'scaffold.yml',      addType: 'scaffold'      },
  { rel: 'AGENTS.md',            label: 'AGENTS.md',         addType: 'agents'        },
  { rel: 'REQUIREMENTS.md',      label: 'REQUIREMENTS.md',   addType: 'requirements'  },
  { rel: 'docs/REQUIREMENTS.md', label: 'docs/REQUIREMENTS.md', addType: 'requirements' },
  { rel: 'docs/TEST_SPEC.md',    label: 'TEST_SPEC.md',      addType: 'test_spec'     },
  { rel: 'docs/ARCHITECTURE.md', label: 'ARCHITECTURE.md',   addType: 'architecture'  },
  // Legacy lowercase (read-only, shown if exists)
  { rel: 'docs/architecture.md', label: 'architecture.md ⚠ (rename to UPPERCASE)', addType: 'rename' },
  { rel: 'LEDGER.md',            label: 'LEDGER.md',         addType: 'ledger'        },
];

const PROMPT_PALETTE = [
  { label: '📋 Review requirements',  prompt: 'Review REQUIREMENTS.md and identify gaps, ambiguities, or missing test coverage. Suggest improvements with specific REQ IDs.' },
  { label: '🔍 Run full audit',        prompt: 'Run specsmith audit and fix any issues found. Report exactly what changed.' },
  { label: '✅ Check REQ coverage',    prompt: 'Check that every requirement in REQUIREMENTS.md has a corresponding test in TEST_SPEC.md. List any uncovered requirements with their IDs.' },
  { label: '📐 Improve ARCHITECTURE', prompt: 'Review docs/ARCHITECTURE.md (or docs/architecture.md) and suggest improvements based on the current codebase. Update the file with your suggestions.' },
  { label: '📝 Update LEDGER',         prompt: 'Write a LEDGER.md entry summarising the work done this session. Include: what changed, what was tested, next steps, and any open TODOs.' },
  { label: '🧠 Epistemic audit',       prompt: 'Run specsmith epistemic-audit and report the belief certainty scores. Identify the lowest-confidence requirements and suggest how to improve them.' },
  { label: '⚡ Stress test REQs',      prompt: 'Run specsmith stress-test on REQUIREMENTS.md. Apply adversarial challenges and report any failure modes or logic knots found.' },
  { label: '🔄 Upgrade governance',    prompt: 'Run specsmith upgrade to the latest spec version. Report what templates were regenerated and what changed.' },
  { label: '📦 Export compliance',     prompt: 'Run specsmith export and save the compliance report to docs/COMPLIANCE.md.' },
  { label: '🏗 Generate architecture', prompt: 'Run specsmith architect --non-interactive to generate an architecture document. Review and update docs/ARCHITECTURE.md.' },
];

// ── Data loading ───────────────────────────────────────────────────────────────

function _loadProjectData(projectDir: string): ProjectData {
  const scaffoldPath = path.join(projectDir, 'scaffold.yml');
  let scaffold: ScaffoldData = {};

  if (fs.existsSync(scaffoldPath)) {
    try {
      const raw = fs.readFileSync(scaffoldPath, 'utf8');
      // Parse scalar fields
      for (const line of raw.split('\n')) {
        const m = line.match(/^(\w+):\s*(.+)$/);
        if (m) {
          const [, key, val] = m;
          if (!['integrations','platforms','languages'].includes(key)) {
            (scaffold as Record<string, string>)[key] = val.replace(/^["']|["']$/g, '').trim();
          }
        }
      }
      // Parse list fields
      for (const field of ['integrations', 'platforms', 'languages']) {
        const re = new RegExp(`^${field}:\\s*\\n((?:[ \\t]*- .+\\n?)+)`, 'm');
        const m2 = raw.match(re);
        if (m2) {
          (scaffold as Record<string, string[]>)[field] = m2[1].match(/- (.+)/g)?.map(l => l.slice(2).trim()) ?? [];
        }
        // Also handle inline: languages: python (single value, legacy)
        const inline = raw.match(new RegExp(`^${field}:\\s*([^\\n]+)$`, 'm'));
        if (inline && !(scaffold as Record<string, unknown>)[field]) {
          const val = inline[1].trim();
          if (!val.startsWith('-')) {
            (scaffold as Record<string, string[]>)[field] = [val];
          }
        }
      }
    } catch { /* ignore */ }
  }

  const govFiles: GovFile[] = GOV_FILES
    .map(({ rel, label, addType }) => {
      const fp = path.join(projectDir, rel);
      const exists = fs.existsSync(fp);
      let lines: number | undefined;
      if (exists) {
        try { lines = fs.readFileSync(fp, 'utf8').split('\n').length; } catch { /* ignore */ }
      }
      // Skip lowercase architecture.md if uppercase exists (avoid duplicate)
      if (rel === 'docs/architecture.md' && fs.existsSync(path.join(projectDir, 'docs/ARCHITECTURE.md'))) {
        return null;
      }
      return { rel, label, uppercase: label === label.toUpperCase() || label.startsWith('scaffold'), exists, lines, addCmd: addType };
    })
    .filter((f): f is GovFile => f !== null);

  // Probe installed specsmith version
  let installedVersion: string | null = null;
  try {
    const cfg = vscode.workspace.getConfiguration('specsmith');
    const exec = cfg.get<string>('executablePath', 'specsmith');
    const r = cp.spawnSync(exec, ['--version'], { timeout: 3000, encoding: 'utf8' });
    if (r.status === 0) {
      const m = (r.stdout ?? '').match(/(\d+\.\d+\.\d+)/);
      installedVersion = m ? m[1] : null;
    }
  } catch { /* ignore */ }

  return { projectDir, scaffold, govFiles, installedVersion };
}

// ── Message handler ────────────────────────────────────────────────────────────

async function _handleMsg(
  context: vscode.ExtensionContext,
  msg: GovMsg,
  projectDir: string,
  sendToSession: (text: string) => void,
  openSession: () => Promise<void>,
): Promise<void> {
  switch (msg.command) {
    case 'saveScaffold':
      if (msg.scaffold) { _saveScaffold(projectDir, msg.scaffold); }
      break;

    case 'runCommand': {
      const cfg  = vscode.workspace.getConfiguration('specsmith');
      const exec = cfg.get<string>('executablePath', 'specsmith');
      const term = vscode.window.createTerminal({ name: 'specsmith governance', cwd: projectDir });
      term.sendText(`${exec} ${msg.cmd} --project-dir "${projectDir}"`);
      term.show();
      break;
    }

    case 'sendToAgent':
      if (msg.prompt) {
        // Auto-open session if none is active
        const { SessionPanel } = await import('./SessionPanel');
        if (!SessionPanel.current()) {
          await openSession();
          // Small delay to let session initialise before sending
          await new Promise((r) => setTimeout(r, 2000));
        }
        sendToSession(msg.prompt);
      }
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
      _refreshPanel(projectDir, sendToSession, openSession);
      break;

    case 'addFile':
      await _addGovFile(context, projectDir, msg.addType ?? '', sendToSession, openSession);
      _refreshPanel(projectDir, sendToSession, openSession);
      break;
  }
}

async function _addGovFile(
  context: vscode.ExtensionContext,
  projectDir: string,
  addType: string,
  sendToSession: (t: string) => void,
  openSession: () => Promise<void>,
): Promise<void> {
  const cfg  = vscode.workspace.getConfiguration('specsmith');
  const exec = cfg.get<string>('executablePath', 'specsmith');

  switch (addType) {
    case 'ledger': {
      const fp = path.join(projectDir, 'LEDGER.md');
      fs.writeFileSync(fp, `# LEDGER — ${path.basename(projectDir)}\n\n` +
        `## Session — ${new Date().toISOString().slice(0, 10)}\n\n` +
        `### Status: Initialised\n\n` +
        `- Project governance initialised\n- LEDGER.md created\n\n` +
        `### Open TODOs\n- [ ] Complete initial audit\n\n---\n`);
      void vscode.window.showInformationMessage('LEDGER.md created with initial template.');
      break;
    }
    case 'test_spec': {
      const ans = await vscode.window.showQuickPick(
        [
          { label: '🧠 AI-generated', description: 'Use specsmith to generate TEST_SPEC.md from REQUIREMENTS.md' },
          { label: '📄 Manual template', description: 'Create an empty TEST_SPEC.md with structure' },
        ],
        { placeHolder: 'How should TEST_SPEC.md be created?' },
      );
      if (!ans) { return; }
      const docsDir = path.join(projectDir, 'docs');
      fs.mkdirSync(docsDir, { recursive: true });
      if (ans.label.startsWith('🧠')) {
        const { SessionPanel } = await import('./SessionPanel');
        if (!SessionPanel.current()) { await openSession(); await new Promise(r => setTimeout(r, 2000)); }
        sendToSession('Generate a TEST_SPEC.md based on REQUIREMENTS.md. Write it to docs/TEST_SPEC.md with proper TEST-* IDs that map to REQ-* IDs.');
      } else {
        fs.writeFileSync(path.join(docsDir, 'TEST_SPEC.md'),
          `# Test Specification\n\n## Unit Tests\n\n- **TEST-001**: Description\n  Covers: REQ-001\n\n## Integration Tests\n\n- **TEST-INT-001**: Description\n  Covers: REQ-001\n`);
        void vscode.window.showInformationMessage('TEST_SPEC.md created with template.');
      }
      break;
    }
    case 'architecture': {
      const ans = await vscode.window.showQuickPick(
        [
          { label: '🧠 AI-generated', description: 'Ask the agent to generate ARCHITECTURE.md' },
          { label: '📄 Manual template', description: 'Create an empty ARCHITECTURE.md with structure' },
          { label: '⚙ specsmith architect', description: 'Run specsmith architect --non-interactive' },
        ],
        { placeHolder: 'How should ARCHITECTURE.md be created?' },
      );
      if (!ans) { return; }
      const docsDir = path.join(projectDir, 'docs');
      fs.mkdirSync(docsDir, { recursive: true });
      if (ans.label.startsWith('🧠')) {
        const { SessionPanel } = await import('./SessionPanel');
        if (!SessionPanel.current()) { await openSession(); await new Promise(r => setTimeout(r, 2000)); }
        sendToSession('Generate an architecture document for this project. Write it to docs/ARCHITECTURE.md with sections: Overview, Components, Data Flow, Deployment, Verification Tools.');
      } else if (ans.label.startsWith('⚙')) {
        const term = vscode.window.createTerminal({ name: 'specsmith architect', cwd: projectDir });
        term.sendText(`${exec} architect --non-interactive --project-dir "${projectDir}"`);
        term.show();
      } else {
        fs.writeFileSync(path.join(docsDir, 'ARCHITECTURE.md'),
          `# Architecture\n\n## Overview\n\n## Components\n\n## Data Flow\n\n## Deployment\n\n## Verification Tools\n`);
        void vscode.window.showInformationMessage('ARCHITECTURE.md created with template.');
      }
      break;
    }
    case 'requirements': {
      const fp = path.join(projectDir, 'REQUIREMENTS.md');
      const docsFp = path.join(projectDir, 'docs', 'REQUIREMENTS.md');
      const target = fs.existsSync(path.dirname(docsFp)) ? docsFp : fp;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `# Requirements\n\n## Core\n\n- **REQ-001**: Description\n`);
      void vscode.window.showTextDocument(vscode.Uri.file(target));
      break;
    }
    case 'agents': {
      const term = vscode.window.createTerminal({ name: 'specsmith import', cwd: projectDir });
      term.sendText(`${exec} import --project-dir "${projectDir}"`);
      term.show();
      break;
    }
    case 'rename': {
      // Rename docs/architecture.md → docs/ARCHITECTURE.md
      const src  = path.join(projectDir, 'docs', 'architecture.md');
      const dest = path.join(projectDir, 'docs', 'ARCHITECTURE.md');
      if (fs.existsSync(src)) {
        fs.renameSync(src, dest);
        void vscode.window.showInformationMessage('Renamed docs/architecture.md → docs/ARCHITECTURE.md');
      }
      break;
    }
  }
}

function _saveScaffold(projectDir: string, scaffold: ScaffoldData): void {
  const p = path.join(projectDir, 'scaffold.yml');
  if (!fs.existsSync(p)) {
    void vscode.window.showWarningMessage('scaffold.yml not found — run specsmith init first');
    return;
  }
  let raw = fs.readFileSync(p, 'utf8');

  // Update scalar fields
  const scalars: Record<string, string> = {
    name:         scaffold.name        ?? '',
    type:         scaffold.type        ?? '',
    description:  scaffold.description ?? '',
    vcs_platform: scaffold.vcs_platform ?? '',
  };
  for (const [key, val] of Object.entries(scalars)) {
    if (val) {
      const re = new RegExp(`^(${key}:)\\s*.+$`, 'm');
      if (re.test(raw)) { raw = raw.replace(re, `$1 ${val}`); }
    }
  }

  // Update list fields (languages, integrations, platforms)
  const lists: Record<string, string[]> = {
    languages:    scaffold.languages    ?? [],
    integrations: scaffold.integrations ?? [],
    platforms:    scaffold.platforms    ?? [],
  };
  for (const [key, vals] of Object.entries(lists)) {
    if (vals.length > 0) {
      const listYaml = `${key}:\n${vals.map(v => `  - ${v}`).join('\n')}`;
      const re = new RegExp(`^${key}:[^\\n]*(?:\\n(?:[ \\t]+- .+)?)*`, 'm');
      if (re.test(raw)) {
        raw = raw.replace(re, listYaml);
      } else {
        raw += `\n${listYaml}`;
      }
    }
  }

  fs.writeFileSync(p, raw, 'utf8');
  void vscode.window.showInformationMessage('scaffold.yml saved. Run specsmith upgrade to apply changes.');
}

// ── HTML ──────────────────────────────────────────────────────────────────────

function _isOutOfDate(scaffoldVer: string | undefined, installedVer: string | null): boolean {
  if (!scaffoldVer || !installedVer) { return false; }
  return scaffoldVer !== installedVer && scaffoldVer < installedVer;
}

function _html(data: ProjectData): string {
  const s = data.scaffold;
  const selectedLangs = s.languages ?? [];
  const selectedInts  = s.integrations ?? [];
  const selectedPlats = s.platforms ?? [];
  const outOfDate     = _isOutOfDate(s.spec_version, data.installedVersion);

  const typeOpts = PROJECT_TYPES.map(t =>
    `<option value="${t}"${s.type === t ? ' selected' : ''}>${t}</option>`,
  ).join('');

  const fileRows = data.govFiles.map(f => {
    if (f.exists) {
      return `<tr>
        <td class="ok">✓</td>
        <td>${f.label}</td>
        <td class="dim">${f.lines ?? ''} lines</td>
        <td><button class="tb" onclick="openFile('${f.rel}')">Open</button></td>
      </tr>`;
    }
    const btnLabel = f.addCmd === 'rename' ? 'Rename' : 'Add';
    return `<tr>
      <td class="miss">✗</td>
      <td class="dim">${f.label}</td>
      <td class="dim">—</td>
      <td><button class="add-btn" onclick="addFile('${f.addCmd ?? f.rel}')">${btnLabel}</button></td>
    </tr>`;
  }).join('');

  const langChips = LANGUAGES.map(l =>
    `<label class="chip${selectedLangs.includes(l) ? ' sel' : ''}">
      <input type="checkbox" name="language" value="${l}"${selectedLangs.includes(l) ? ' checked' : ''}> ${l}
    </label>`,
  ).join('');

  const vcsOpts = VCS_PLATFORMS.map(v =>
    `<option value="${v}"${s.vcs_platform === v ? ' selected' : ''}>${v}</option>`,
  ).join('');

  const intChips = INTEGRATIONS.map(i =>
    `<label class="chip${selectedInts.includes(i) ? ' sel' : ''}">
      <input type="checkbox" name="integration" value="${i}"${selectedInts.includes(i) ? ' checked' : ''}> ${i}
    </label>`,
  ).join('');

  const platChips = PLATFORMS.map(p =>
    `<label class="chip${selectedPlats.includes(p) ? ' sel' : ''}">
      <input type="checkbox" name="platform" value="${p}"${selectedPlats.includes(p) ? ' checked' : ''}> ${p}
    </label>`,
  ).join('');

  const prompts = PROMPT_PALETTE.map(p =>
    `<button class="pb" onclick="sendToAgent(${JSON.stringify(p.prompt)})">${p.label}</button>`,
  ).join('');

  const outOfDateBanner = outOfDate ? `
    <div class="warn-banner">
      ⚠ scaffold.yml spec_version <strong>${s.spec_version}</strong> is older than installed specsmith
      <strong>${data.installedVersion}</strong>
      <button class="tb" onclick="runCmd('upgrade')">↑ Run upgrade</button>
    </div>` : '';

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
    --teal:#4ec9b0;--red:#f44747;--grn:#4ec94e;--amb:#ce9178;--dim:#7f849c;
    --fn:var(--vscode-font-family,'Segoe UI',system-ui,sans-serif);}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--fg);font-family:var(--fn);font-size:13px;padding:14px;overflow-y:auto}
  h2{color:var(--teal);font-size:13px;margin:18px 0 7px;border-bottom:1px solid var(--br);padding-bottom:3px;display:flex;align-items:center;gap:8px}
  h2:first-of-type{margin-top:0}
  label.fld{font-size:11px;color:var(--dim);display:block;margin-bottom:2px}
  input[type=text],select{width:100%;background:var(--ib);color:var(--if);
    border:1px solid var(--br);border-radius:4px;padding:4px 7px;font-size:12px;font-family:var(--fn)}
  input[type=text]:focus,select:focus{outline:1px solid var(--teal)}
  input[type=checkbox]{margin-right:3px}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:7px}
  .fld-grp{margin-bottom:7px}
  .btn{background:var(--bb);color:var(--bf);border:none;border-radius:4px;
    padding:5px 12px;cursor:pointer;font-size:12px;font-weight:600}
  .btn:hover{opacity:.85}
  .btn-sm{background:none;border:1px solid var(--br);color:var(--dim);border-radius:3px;
    padding:3px 9px;cursor:pointer;font-size:11px}
  .btn-sm:hover{border-color:var(--teal);color:var(--teal)}
  .tb{background:none;border:1px solid var(--br);border-radius:3px;color:var(--dim);
    padding:2px 7px;cursor:pointer;font-size:10px}
  .tb:hover{border-color:var(--teal);color:var(--teal)}
  .add-btn{background:rgba(78,201,176,.12);border:1px solid var(--teal);border-radius:3px;
    color:var(--teal);padding:2px 7px;cursor:pointer;font-size:10px;font-weight:600}
  .add-btn:hover{background:rgba(78,201,176,.25)}
  table{width:100%;border-collapse:collapse;font-size:12px}
  td{padding:3px 7px;border-bottom:1px solid var(--br)}
  .ok{color:var(--grn);font-weight:700;width:18px}
  .miss{color:var(--red);width:18px}
  .dim{color:var(--dim);font-size:11px}
  .chip-group{display:flex;flex-wrap:wrap;gap:5px;margin-top:3px}
  .chip{display:inline-flex;align-items:center;background:var(--sf);border:1px solid var(--br);
    border-radius:12px;padding:2px 9px;font-size:11px;cursor:pointer;transition:border-color .1s,background .1s}
  .chip:hover{border-color:var(--teal)}
  .chip.sel{background:rgba(78,201,176,.15);border-color:var(--teal);color:var(--teal)}
  .chip input{display:none}
  .qa{display:grid;grid-template-columns:1fr 1fr;gap:5px}
  .qa-btn{background:none;border:1px solid var(--br);border-radius:4px;color:var(--dim);
    padding:4px 7px;cursor:pointer;font-size:11px;text-align:left}
  .qa-btn:hover{border-color:var(--teal);color:var(--teal)}
  .pb{background:var(--sf);border:1px solid var(--br);border-radius:5px;
    color:var(--fg);padding:6px 10px;cursor:pointer;font-size:12px;
    text-align:left;display:block;width:100%;margin-bottom:4px}
  .pb:hover{border-color:var(--teal);background:rgba(78,201,176,.06)}
  .notice{background:rgba(78,201,176,.08);border:1px solid rgba(78,201,176,.25);
    border-radius:4px;padding:7px 10px;font-size:11px;color:var(--teal);margin-bottom:10px}
  .warn-banner{background:rgba(206,145,120,.1);border:1px solid var(--amb);
    border-radius:4px;padding:7px 10px;font-size:11px;color:var(--amb);
    margin-bottom:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
  .hdr-btns{display:flex;gap:6px}
  .filter-input{font-size:11px;padding:3px 6px;margin-bottom:5px}
  .search-wrap{position:relative;margin-bottom:5px}
</style>
</head>
<body>

<div class="hdr">
  <strong style="font-size:14px;color:var(--teal)">🧠 Governance</strong>
  <div class="hdr-btns">
    <button class="btn-sm" onclick="refresh()">↺ Refresh</button>
    <button class="btn-sm" onclick="sendToAgent('Open a new session and run the session start protocol: sync, load AGENTS.md, read LEDGER.md, check for updates.')">🤖 Agent</button>
  </div>
</div>

<div class="notice">AI prompts route through the active agent session. If none is open, one will be started automatically.</div>
${outOfDateBanner}

<h2>📁 scaffold.yml
  <span class="dim" style="font-size:10px;font-weight:400">${data.scaffold.spec_version ? `v${data.scaffold.spec_version}` : ''}</span>
</h2>
<div class="row">
  <div class="fld-grp"><label class="fld">Project Name</label>
    <input type="text" id="name" value="${s.name ?? ''}"></div>
  <div class="fld-grp"><label class="fld">Project Type</label>
    <select id="type">${typeOpts}</select></div>
</div>
<div class="fld-grp"><label class="fld">Description</label>
  <input type="text" id="description" value="${s.description ?? ''}"></div>
<div class="fld-grp">
  <label class="fld">Language(s)</label>
  <input class="filter-input" type="text" placeholder="Filter languages…" oninput="filterChips(this,'language')">
  <div class="chip-group" id="lang-chips">${langChips}</div>
</div>
<div class="row">
  <div class="fld-grp"><label class="fld">VCS Platform</label>
    <select id="vcs_platform">${vcsOpts}</select></div>
  <div class="fld-grp"><label class="fld">Spec Version (read-only)</label>
    <input type="text" id="spec_version" value="${s.spec_version ?? ''}" disabled style="opacity:.5"></div>
</div>
<div class="fld-grp"><label class="fld">Agent Integrations</label>
  <div class="chip-group">${intChips}</div></div>
<div class="fld-grp"><label class="fld">Platforms</label>
  <div class="chip-group">${platChips}</div></div>

<div style="display:flex;gap:7px;margin:10px 0">
  <button class="btn" onclick="saveScaffold()">💾 Save</button>
  <button class="btn-sm" onclick="runCmd('upgrade')">↑ upgrade</button>
  <button class="btn-sm" onclick="sendToAgent('Review scaffold.yml and suggest improvements to the project configuration. Focus on type, integrations, and any missing fields.')">🧠 Ask Agent</button>
</div>

<h2>📋 Governance Files</h2>
<table>
  <thead><tr><td></td><td><b>File</b></td><td class="dim">Size</td><td></td></tr></thead>
  <tbody>${fileRows}</tbody>
</table>

<h2>⚡ Quick Actions</h2>
<div class="qa">
  <button class="qa-btn" onclick="runCmd('audit --fix')">🔍 audit --fix</button>
  <button class="qa-btn" onclick="runCmd('validate')">✅ validate</button>
  <button class="qa-btn" onclick="runCmd('doctor')">🩺 doctor</button>
  <button class="qa-btn" onclick="runCmd('epistemic-audit --brief')">🧠 epistemic</button>
  <button class="qa-btn" onclick="runCmd('stress-test')">⚡ stress-test</button>
  <button class="qa-btn" onclick="runCmd('export')">📄 export</button>
  <button class="qa-btn" onclick="runCmd('req list')">📋 req list</button>
  <button class="qa-btn" onclick="runCmd('req gaps')">⚠ req gaps</button>
</div>

<h2>🤖 AI Prompt Palette</h2>
${prompts}

<script>
const vscode = acquireVsCodeApi();
function refresh(){vscode.postMessage({command:'refresh'})}
function runCmd(cmd){vscode.postMessage({command:'runCommand',cmd})}
function sendToAgent(prompt){vscode.postMessage({command:'sendToAgent',prompt})}
function openFile(file){vscode.postMessage({command:'openFile',file})}
function addFile(addType){vscode.postMessage({command:'addFile',addType})}
function saveScaffold(){
  const languages=[...document.querySelectorAll('input[name=language]:checked')].map(e=>e.value);
  const integrations=[...document.querySelectorAll('input[name=integration]:checked')].map(e=>e.value);
  const platforms=[...document.querySelectorAll('input[name=platform]:checked')].map(e=>e.value);
  vscode.postMessage({command:'saveScaffold',scaffold:{
    name:document.getElementById('name').value,
    type:document.getElementById('type').value,
    description:document.getElementById('description').value,
    vcs_platform:document.getElementById('vcs_platform').value,
    languages,integrations,platforms
  }});
}
// Filter chips by typing
function filterChips(input,name){
  const q=input.value.toLowerCase();
  document.querySelectorAll(\`input[name=\${name}]\`).forEach(cb=>{
    const chip=cb.closest('.chip');
    if(chip)chip.style.display=(!q||cb.value.toLowerCase().includes(q))?'':'none';
  });
}
// Toggle chip selected style on click
document.querySelectorAll('.chip').forEach(c=>{
  c.addEventListener('click',()=>c.classList.toggle('sel',c.querySelector('input').checked));
});
</script>
</body>
</html>`;
}
