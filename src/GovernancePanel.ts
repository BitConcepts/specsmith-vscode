// SPDX-License-Identifier: MIT
// Copyright (c) 2026 BitConcepts, LLC. All rights reserved.
/**
 * GovernancePanel v3 — 5-tab AI-assisted governance workbench.
 *
 * Tabs:  Project | Tools | Files | Updates & System | Actions & AI
 */
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let _panel: vscode.WebviewPanel | undefined;
let _ctx: vscode.ExtensionContext | undefined;
let _projectDir: string | undefined;
let _sendFn: ((t: string) => void) | undefined;
let _openFn: (() => Promise<void>) | undefined;

export function showGovernancePanel(
  context: vscode.ExtensionContext,
  projectDir: string,
  sendToSession: (text: string) => void,
  openSession: () => Promise<void>,
): void {
  _ctx        = context;
  _projectDir = projectDir;
  _sendFn     = sendToSession;
  _openFn     = openSession;

  if (_panel) {
    _panel.reveal(vscode.ViewColumn.Beside);
    _reload();
    return;
  }

  _panel = vscode.window.createWebviewPanel(
    'specsmithGovernance',
    '🧠 Governance',
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  _reload();

  _panel.webview.onDidReceiveMessage(
    (msg: GovMsg) => void _handleMsg(msg),
    null,
    context.subscriptions,
  );

  _panel.onDidDispose(() => {
    _panel = undefined;
    _ctx = undefined;
  }, null, context.subscriptions);
}

function _reload(): void {
  if (!_panel || !_ctx || !_projectDir) { return; }
  _panel.webview.html = _html(_loadProjectData(_projectDir, _ctx));
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ScaffoldData {
  name?: string; type?: string; description?: string; vcs_platform?: string; spec_version?: string;
  languages?: string[]; integrations?: string[]; platforms?: string[]; fpga_tools?: string[];
}
interface GovFile { rel: string; label: string; exists: boolean; lines?: number; addCmd?: string; }
interface ProjectData {
  projectDir: string; scaffold: ScaffoldData; govFiles: GovFile[];
  installedVersion: string | null; availableVersion: string | null; lastUpdateCheck: string | null;
}
interface GovMsg {
  command:
    | 'saveScaffold' | 'runCommand' | 'sendToAgent' | 'openFile' | 'refresh'
    | 'addFile' | 'checkVersion' | 'installUpdate' | 'getSysInfo' | 'detectLanguages';
  scaffold?: ScaffoldData; cmd?: string; prompt?: string; file?: string; addType?: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const LANGUAGES = [
  'Python','Rust','Go','C','C++','TypeScript','JavaScript','C#','Swift','Kotlin',
  'VHDL','SystemVerilog','Verilog','Dart','Java','Ruby','PHP','Scala','Haskell','Lua',
  'Bash','PowerShell','Cmd','BitBake','YAML','Makefile','SQL','Zig','Nim',
];

const VCS_PLATFORMS = ['github','gitlab','bitbucket','azure-devops','gitea','none'];

const PROJECT_TYPES = [
  'cli-python','lib-python','web-backend-python','web-fullstack','web-frontend',
  'cli-rust','lib-rust','cli-go','lib-go','cli-node','lib-node',
  'cli-cpp','lib-cpp','embedded-c','embedded-cpp',
  'fpga-rtl-xilinx','fpga-rtl-intel','fpga-rtl-lattice','fpga-rtl-generic',
  'mobile-ios','mobile-android','mobile-flutter',
  'dotnet-cli','dotnet-lib','dotnet-web',
  'microservice','data-pipeline','ml-model',
  'research-academic','patent-application','legal-contract',
  'business-strategy','project-management','yocto-bsp',
];

const INTEGRATIONS = ['warp','claude','cursor','copilot','aider','continue'];
const PLATFORMS    = ['linux','windows','macos','embedded','cloud','wasm','xilinx-fpga','intel-fpga','lattice-fpga'];

/** Tool-agnostic FPGA/HDL toolchain catalog. */
const FPGA_TOOLS = [
  // Synthesis & Implementation
  'vivado','quartus','radiant','diamond','gowin',
  // Simulation
  'ghdl','iverilog','verilator','modelsim','questasim','xsim',
  // Waveform viewers
  'gtkwave','surfer',
  // Linting / Style
  'vsg','verible','svlint',
  // Formal
  'symbiyosys',
  // Open-source flow
  'yosys','nextpnr','openFPGALoader',
];

const GOV_FILES = [
  { rel: 'scaffold.yml',         label: 'scaffold.yml',             addType: 'scaffold'     },
  { rel: 'AGENTS.md',            label: 'AGENTS.md',                addType: 'agents'       },
  { rel: 'REQUIREMENTS.md',      label: 'REQUIREMENTS.md',          addType: 'requirements' },
  { rel: 'docs/REQUIREMENTS.md', label: 'docs/REQUIREMENTS.md',     addType: 'requirements' },
  { rel: 'docs/TEST_SPEC.md',    label: 'TEST_SPEC.md',             addType: 'test_spec'    },
  { rel: 'docs/ARCHITECTURE.md', label: 'ARCHITECTURE.md',          addType: 'architecture' },
  { rel: 'docs/architecture.md', label: 'architecture.md ⚠ rename', addType: 'rename'       },
  { rel: 'LEDGER.md',            label: 'LEDGER.md',                addType: 'ledger'       },
];

const PROMPTS = [
  { label: '📋 Review requirements',  prompt: 'Review REQUIREMENTS.md and identify gaps, ambiguities, or missing test coverage.' },
  { label: '🔍 Run full audit',        prompt: 'Run specsmith audit and fix any issues found. Report exactly what changed.' },
  { label: '✅ Check REQ coverage',    prompt: 'Check that every requirement has a corresponding test in TEST_SPEC.md.' },
  { label: '📐 Improve ARCHITECTURE', prompt: 'Review docs/ARCHITECTURE.md and update it based on the current codebase.' },
  { label: '📝 Update LEDGER',         prompt: 'Write a LEDGER.md entry: what changed, what was tested, next steps, open TODOs.' },
  { label: '🧠 Epistemic audit',       prompt: 'Run specsmith epistemic-audit. Report low-confidence requirements.' },
  { label: '⚡ Stress test REQs',      prompt: 'Run specsmith stress-test on REQUIREMENTS.md. Report failure modes.' },
  { label: '🔄 Upgrade governance',    prompt: 'Run specsmith upgrade to the latest spec version. Report what changed.' },
  { label: '📦 Export compliance',     prompt: 'Run specsmith export and save the report to docs/COMPLIANCE.md.' },
  { label: '🏗 Generate architecture', prompt: 'Run specsmith architect --non-interactive and update docs/ARCHITECTURE.md.' },
];

// ── Data loading ───────────────────────────────────────────────────────────────

function _loadProjectData(projectDir: string, context: vscode.ExtensionContext): ProjectData {
  const scaffoldPath = path.join(projectDir, 'scaffold.yml');
  let scaffold: ScaffoldData = {};

  if (fs.existsSync(scaffoldPath)) {
    try {
      const raw = fs.readFileSync(scaffoldPath, 'utf8');
      for (const line of raw.split('\n')) {
        const m = line.match(/^(\w+):\s*(.+)$/);
        if (m && !['integrations','platforms','languages','fpga_tools'].includes(m[1])) {
          (scaffold as Record<string, string>)[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
        }
      }
      for (const field of ['integrations','platforms','languages','fpga_tools']) {
        const re  = new RegExp(`^${field}:\\s*\\n((?:[ \\t]*- .+\\n?)+)`, 'm');
        const m2  = raw.match(re);
        if (m2) { (scaffold as Record<string, string[]>)[field] = m2[1].match(/- (.+)/g)?.map(l => l.slice(2).trim()) ?? []; }
        const inl = raw.match(new RegExp(`^${field}:\\s*([^\\n]+)$`, 'm'));
        if (inl && !(scaffold as Record<string, unknown>)[field]) {
          const v = inl[1].trim();
          if (!v.startsWith('-')) { (scaffold as Record<string, string[]>)[field] = [v]; }
        }
      }
    } catch { /* ignore */ }
  }

  const govFiles: GovFile[] = GOV_FILES.flatMap(({ rel, label, addType }) => {
    if (rel === 'docs/architecture.md' && fs.existsSync(path.join(projectDir, 'docs/ARCHITECTURE.md'))) { return []; }
    const fp = path.join(projectDir, rel);
    const exists = fs.existsSync(fp);
    let lines: number | undefined;
    if (exists) { try { lines = fs.readFileSync(fp, 'utf8').split('\n').length; } catch { /* ignore */ } }
    return [{ rel, label, exists, lines, addCmd: addType } as GovFile];
  });

  let installedVersion: string | null = null;
  try {
    const exec = vscode.workspace.getConfiguration('specsmith').get<string>('executablePath', 'specsmith');
    const r    = cp.spawnSync(exec, ['--version'], { timeout: 3000, encoding: 'utf8' });
    if (r.status === 0) { const m = (r.stdout ?? '').match(/(\d+\.\d+\.\d+)/); installedVersion = m?.[1] ?? null; }
  } catch { /* ignore */ }

  const avail     = context.globalState.get<string>('specsmith.availableVersion', '');
  const checkMs   = context.globalState.get<number>('specsmith.lastVersionCheck', 0);
  const lastCheck = checkMs ? new Date(checkMs).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;

  return { projectDir, scaffold, govFiles, installedVersion, availableVersion: avail || null, lastUpdateCheck: lastCheck };
}

// ── Message handler ────────────────────────────────────────────────────────────

async function _handleMsg(msg: GovMsg): Promise<void> {
  if (!_ctx || !_projectDir || !_sendFn || !_openFn) { return; }

  switch (msg.command) {
    case 'saveScaffold':
      if (msg.scaffold) { _saveScaffold(_projectDir, msg.scaffold); }
      break;

    case 'runCommand': {
      const exec = vscode.workspace.getConfiguration('specsmith').get<string>('executablePath', 'specsmith');
      const term = vscode.window.createTerminal({ name: 'specsmith', cwd: _projectDir });
      term.sendText(`${exec} ${msg.cmd} --project-dir "${_projectDir}"`);
      term.show();
      break;
    }

    case 'sendToAgent': {
      if (!msg.prompt) { break; }
      const { SessionPanel } = await import('./SessionPanel');
      if (!SessionPanel.current()) {
        await _openFn();
        await new Promise((r) => setTimeout(r, 2000));
      }
      _sendFn(msg.prompt);
      break;
    }

    case 'openFile':
      if (msg.file) {
        const fp = path.join(_projectDir, msg.file);
        if (fs.existsSync(fp)) { void vscode.window.showTextDocument(vscode.Uri.file(fp)); }
      }
      break;

    case 'refresh': _reload(); break;

    case 'addFile':
      await _addGovFile(_ctx, _projectDir, msg.addType ?? '');
      _reload();
      break;

    case 'detectLanguages':
      _detectAndSetLanguages(_projectDir);
      _reload();
      break;

    case 'checkVersion':
      await _checkVersion(_ctx);
      _reload();
      break;

    case 'installUpdate': {
      const term = vscode.window.createTerminal({ name: 'specsmith upgrade', shellPath: _shellPath() });
      term.sendText('pipx upgrade specsmith || pip install --upgrade specsmith');
      term.show();
      void vscode.window.showInformationMessage('Upgrading specsmith… Reload after it completes.', 'Reload Now')
        .then((a) => { if (a === 'Reload Now') { void vscode.commands.executeCommand('workbench.action.reloadWindow'); } });
      break;
    }

    case 'getSysInfo':
      void _sendSysInfo();
      break;
  }
}

// ── Version check ──────────────────────────────────────────────────────────────

async function _checkVersion(context: vscode.ExtensionContext): Promise<void> {
  await context.globalState.update('specsmith.lastVersionCheck', Date.now());
  try {
    const httpsM = await import('https');
    const raw    = await new Promise<string>((resolve, reject) => {
      const req = httpsM.get('https://pypi.org/pypi/specsmith/json', { timeout: 8000 }, (r) => {
        let d = '';
        r.on('data', (c: Buffer) => { d += c; });
        r.on('end', () => resolve(d));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
    const latest = (JSON.parse(raw) as { info?: { version?: string } }).info?.version ?? '';
    await context.globalState.update('specsmith.availableVersion', latest);
    _panel?.webview.postMessage({ type: 'versionInfo', available: latest });
  } catch (err) {
    _panel?.webview.postMessage({ type: 'versionInfo', error: String(err) });
  }
}

// ── System info ────────────────────────────────────────────────────────────────

async function _sendSysInfo(): Promise<void> {
  if (!_panel) { return; }
  const GB = 1073741824;
  const info: Record<string, string> = {
    os:    `${os.type()} ${os.release()} (${os.arch()})`,
    cpu:   os.cpus()[0]?.model ?? 'Unknown',
    cores: String(os.cpus().length),
    ram:   `${(os.totalmem() / GB).toFixed(1)} GB total, ${(os.freemem() / GB).toFixed(1)} GB free`,
  };

  // GPU detection
  try {
    const r = cp.spawnSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], { timeout: 4000, encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) { info.gpu = r.stdout.trim().split('\n')[0]; }
  } catch { /* no nvidia */ }

  if (!info.gpu && process.platform === 'win32') {
    try {
      const r = cp.spawnSync('powershell', ['-NoProfile', '-Command',
        'Get-WmiObject Win32_VideoController | Select-Object -First 1 Name,AdapterRAM | ForEach-Object { "$($_.Name) ($([math]::Round($_.AdapterRAM/1GB,1))GB)" }',
      ], { timeout: 6000, encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim()) { info.gpu = r.stdout.trim(); }
    } catch { /* no wmi */ }
  }
  if (!info.gpu) { info.gpu = 'Not detected'; }

  // Disk
  try {
    if (process.platform === 'win32') {
      const r = cp.spawnSync('wmic', ['logicaldisk', 'get', 'caption,freespace,size', '/format:csv'], { timeout: 4000, encoding: 'utf8' });
      if (r.status === 0) {
        info.disk = r.stdout.trim().split('\n').slice(1)
          .filter(l => l.trim() && !l.startsWith('Node'))
          .map(row => {
            const [, caption, free, size] = row.split(',');
            if (!caption || !size) { return ''; }
            return `${caption.trim()} ${(Number(free) / GB).toFixed(1)}/${(Number(size) / GB).toFixed(1)} GB`;
          }).filter(Boolean).join('  ') || 'N/A';
      }
    } else {
      const r = cp.spawnSync('df', ['-h', '-P', '/'], { timeout: 3000, encoding: 'utf8' });
      if (r.status === 0) { const p = r.stdout.split('\n')[1]?.split(/\s+/) ?? []; if (p[3]) { info.disk = `${p[0]}: ${p[3]} free / ${p[1]}`; } }
    }
  } catch { /* ignore */ }
  if (!info.disk) { info.disk = 'N/A'; }

  _panel.webview.postMessage({ type: 'sysInfo', info });
}

// ── scaffold helpers ───────────────────────────────────────────────────────────

function _replaceYamlSection(lines: string[], key: string, val: string | string[]): string[] {
  const out: string[] = [];
  let i = 0; let replaced = false;
  const altKey = key === 'languages' ? 'language' : null;
  while (i < lines.length) {
    const line = lines[i];
    if (new RegExp(`^(${key}${altKey ? `|${altKey}` : ''}):`).test(line) && !replaced) {
      replaced = true; i++;
      while (i < lines.length && (lines[i].match(/^[ \t]*-/) || lines[i].match(/^[ \t]+\S/))) { i++; }
      if (Array.isArray(val) && val.length) { out.push(`${key}:`); for (const v of val) { out.push(`  - ${v}`); } }
      else if (typeof val === 'string' && val) { out.push(`${key}: ${val}`); }
    } else { out.push(line); i++; }
  }
  if (!replaced) {
    if (Array.isArray(val) && val.length) { out.push(`${key}:`); for (const v of val) { out.push(`  - ${v}`); } }
    else if (typeof val === 'string' && val) { out.push(`${key}: ${val}`); }
  }
  return out;
}

function _saveScaffold(projectDir: string, scaffold: ScaffoldData): void {
  const p = path.join(projectDir, 'scaffold.yml');
  if (!fs.existsSync(p)) { void vscode.window.showWarningMessage('scaffold.yml not found — run specsmith init first'); return; }
  let lines = fs.readFileSync(p, 'utf8').split('\n');
  for (const [k, v] of Object.entries({ name: scaffold.name ?? '', type: scaffold.type ?? '', description: scaffold.description ?? '', vcs_platform: scaffold.vcs_platform ?? '' })) {
    if (v) { lines = _replaceYamlSection(lines, k, v); }
  }
  for (const [k, v] of Object.entries({ languages: scaffold.languages ?? [], integrations: scaffold.integrations ?? [], platforms: scaffold.platforms ?? [], fpga_tools: scaffold.fpga_tools ?? [] })) {
    if (v.length) { lines = _replaceYamlSection(lines, k, v); }
  }
  fs.writeFileSync(p, lines.join('\n'), 'utf8');
  void vscode.window.showInformationMessage('scaffold.yml saved.');
}

// ── Language detection ─────────────────────────────────────────────────────────

const EXT_LANG: Record<string, string> = {
  '.py':'Python','.rs':'Rust','.go':'Go','.c':'C','.cpp':'C++','.cc':'C++','.h':'C','.hpp':'C++',
  '.ts':'TypeScript','.tsx':'TypeScript','.js':'JavaScript','.cs':'C#','.swift':'Swift','.kt':'Kotlin',
  '.vhd':'VHDL','.vhdl':'VHDL','.sv':'SystemVerilog','.v':'Verilog','.dart':'Dart','.java':'Java',
  '.rb':'Ruby','.php':'PHP','.sh':'Bash','.ps1':'PowerShell','.cmd':'Cmd','.bb':'BitBake','.zig':'Zig',
};
const SKIP_DIRS = new Set(['node_modules','.git','.venv','__pycache__','dist','out','build','.specsmith']);

function _detectAndSetLanguages(projectDir: string): void {
  const found = new Set<string>();
  (function scan(dir: string, depth: number) {
    if (depth > 4) { return; }
    let ents: string[]; try { ents = fs.readdirSync(dir); } catch { return; }
    for (const e of ents) {
      if (SKIP_DIRS.has(e)) { continue; }
      const full = path.join(dir, e);
      let st: ReturnType<typeof fs.statSync> | undefined; try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) { scan(full, depth + 1); }
      else { const l = EXT_LANG[path.extname(e).toLowerCase()]; if (l) { found.add(l); } }
    }
  })(projectDir, 0);
  if (!found.size) { void vscode.window.showInformationMessage('No recognisable language files found.'); return; }
  const sp = path.join(projectDir, 'scaffold.yml');
  if (!fs.existsSync(sp)) { void vscode.window.showWarningMessage('scaffold.yml not found.'); return; }
  let lines = fs.readFileSync(sp, 'utf8').split('\n');
  const langs = [...found].sort();
  lines = _replaceYamlSection(lines, 'languages', langs);
  fs.writeFileSync(sp, lines.join('\n'), 'utf8');
  void vscode.window.showInformationMessage(`Detected & saved languages: ${langs.join(', ')}`);
}

async function _addGovFile(context: vscode.ExtensionContext, projectDir: string, addType: string): Promise<void> {
  const exec = vscode.workspace.getConfiguration('specsmith').get<string>('executablePath', 'specsmith');

  switch (addType) {
    case 'ledger': {
      const fp = path.join(projectDir, 'LEDGER.md');
      fs.writeFileSync(fp, `# LEDGER — ${path.basename(projectDir)}\n\n## Session — ${new Date().toISOString().slice(0, 10)}\n\n### Status: Initialised\n\n- LEDGER.md created\n\n### Open TODOs\n- [ ] Complete initial audit\n\n---\n`);
      void vscode.window.showInformationMessage('LEDGER.md created.');
      break;
    }
    case 'test_spec': {
      const ans = await vscode.window.showQuickPick([{ label: '🧠 AI-generated' }, { label: '📄 Template' }], { placeHolder: 'How should TEST_SPEC.md be created?' });
      if (!ans) { break; }
      const docsDir = path.join(projectDir, 'docs'); fs.mkdirSync(docsDir, { recursive: true });
      if (ans.label.startsWith('🧠')) {
        if (_openFn && _sendFn) {
          const { SessionPanel } = await import('./SessionPanel');
          if (!SessionPanel.current()) { await _openFn(); await new Promise(r => setTimeout(r, 2000)); }
          _sendFn('Generate a TEST_SPEC.md based on REQUIREMENTS.md. Write to docs/TEST_SPEC.md with TEST-* IDs mapping to REQ-* IDs.');
        }
      } else {
        fs.writeFileSync(path.join(docsDir, 'TEST_SPEC.md'), '# Test Specification\n\n## Unit Tests\n\n- **TEST-001**: Description\n  Covers: REQ-001\n');
        void vscode.window.showInformationMessage('TEST_SPEC.md created.');
      }
      break;
    }
    case 'architecture': {
      const ans = await vscode.window.showQuickPick([{ label: '🧠 AI-generated' }, { label: '📄 Template' }, { label: '⚙ specsmith architect' }], { placeHolder: 'How should ARCHITECTURE.md be created?' });
      if (!ans) { break; }
      const docsDir = path.join(projectDir, 'docs'); fs.mkdirSync(docsDir, { recursive: true });
      if (ans.label.startsWith('🧠')) {
        if (_openFn && _sendFn) {
          const { SessionPanel } = await import('./SessionPanel');
          if (!SessionPanel.current()) { await _openFn(); await new Promise(r => setTimeout(r, 2000)); }
          _sendFn('Generate an architecture document for this project. Write to docs/ARCHITECTURE.md.');
        }
      } else if (ans.label.startsWith('⚙')) {
        const term = vscode.window.createTerminal({ name: 'specsmith architect', cwd: projectDir });
        term.sendText(`${exec} architect --non-interactive --project-dir "${projectDir}"`); term.show();
      } else {
        fs.writeFileSync(path.join(docsDir, 'ARCHITECTURE.md'), '# Architecture\n\n## Overview\n\n## Components\n\n## Data Flow\n\n## Deployment\n\n');
        void vscode.window.showInformationMessage('ARCHITECTURE.md created.');
      }
      break;
    }
    case 'requirements': {
      const target = fs.existsSync(path.join(projectDir, 'docs')) ? path.join(projectDir, 'docs', 'REQUIREMENTS.md') : path.join(projectDir, 'REQUIREMENTS.md');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '# Requirements\n\n## Core\n\n- **REQ-001**: Description\n');
      void vscode.window.showTextDocument(vscode.Uri.file(target));
      break;
    }
    case 'agents': {
      const term = vscode.window.createTerminal({ name: 'specsmith import', cwd: projectDir });
      term.sendText(`${exec} import --project-dir "${projectDir}"`); term.show();
      break;
    }
    case 'rename': {
      const src = path.join(projectDir, 'docs', 'architecture.md'), dest = path.join(projectDir, 'docs', 'ARCHITECTURE.md');
      if (fs.existsSync(src)) { fs.renameSync(src, dest); void vscode.window.showInformationMessage('Renamed to ARCHITECTURE.md'); }
      break;
    }
  }
}

function _shellPath(): string | undefined {
  return process.platform === 'win32' ? (process.env.ComSpec ?? 'powershell.exe') : process.env.SHELL;
}

// ── HTML ──────────────────────────────────────────────────────────────────────

function _html(data: ProjectData): string {
  const s     = data.scaffold;
  const ood   = s.spec_version && data.installedVersion && s.spec_version < data.installedVersion;
  const upd   = data.availableVersion && data.installedVersion && data.availableVersion !== data.installedVersion;

  const selL = s.languages ?? [], selI = s.integrations ?? [], selP = s.platforms ?? [], selF = s.fpga_tools ?? [];

  const typeOpts  = PROJECT_TYPES.map(t => `<option${s.type === t ? ' selected' : ''}>${t}</option>`).join('');
  const vcsOpts   = VCS_PLATFORMS.map(v => `<option${s.vcs_platform === v ? ' selected' : ''}>${v}</option>`).join('');

  const chips = (arr: string[], sel: string[], name: string) =>
    arr.map(x =>
      `<label class="chip${sel.includes(x) ? ' sel' : ''}">` +
      `<input type="checkbox" name="${name}" value="${x}"${sel.includes(x) ? ' checked' : ''}> ${x}</label>`
    ).join('');

  const fileRows = data.govFiles.map(f => f.exists
    ? `<tr><td class="ok">✓</td><td>${f.label}</td><td class="dim">${f.lines} lines</td>` +
      `<td><button class="tb" onclick="openFile('${f.rel}')">Open</button></td></tr>`
    : `<tr><td class="miss">✗</td><td class="dim">${f.label}</td><td class="dim">—</td>` +
      `<td><button class="add-btn" onclick="addFile('${f.addCmd ?? f.rel}')">${f.addCmd === 'rename' ? 'Rename' : 'Add'}</button></td></tr>`
  ).join('');

  const prompts = PROMPTS.map(p =>
    `<button class="pb" onclick="sendToAgent(${JSON.stringify(p.prompt)})">${p.label}</button>`
  ).join('');

  return /* html */`<!DOCTYPE html>
<html lang="en"><head>
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
  body{background:var(--bg);color:var(--fg);font-family:var(--fn);font-size:13px;
       display:flex;flex-direction:column;height:100vh;overflow:hidden}
  .topbar{display:flex;align-items:center;justify-content:space-between;
          padding:7px 12px;background:var(--sf);border-bottom:1px solid var(--br);flex-shrink:0}
  .title{font-size:13px;color:var(--teal);font-weight:700}
  .tab-bar{display:flex;background:var(--sf);border-bottom:2px solid var(--br);flex-shrink:0;overflow-x:auto}
  .tab{background:none;border:none;border-bottom:2px solid transparent;margin-bottom:-2px;
       padding:6px 11px;cursor:pointer;color:var(--dim);font-size:11px;white-space:nowrap;font-family:var(--fn)}
  .tab:hover:not(.active){color:var(--fg)}
  .tab.active{border-bottom-color:var(--teal);color:var(--teal);font-weight:600}
  .scroll{flex:1;overflow-y:auto;padding:12px 14px}
  .tab-pane{display:none}.tab-pane.active{display:block}
  h3{color:var(--teal);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;
     margin:14px 0 5px;border-bottom:1px solid var(--br);padding-bottom:3px}
  h3:first-child{margin-top:0}
  label.fl{font-size:11px;color:var(--dim);display:block;margin-bottom:2px}
  input[type=text],select{width:100%;background:var(--ib);color:var(--if);border:1px solid var(--br);
    border-radius:4px;padding:4px 7px;font-size:12px;font-family:var(--fn)}
  input[type=text]:focus,select:focus{outline:1px solid var(--teal)}
  input[type=checkbox]{margin-right:3px}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:7px}
  .fg{margin-bottom:7px}
  .btn{background:var(--bb);color:var(--bf);border:none;border-radius:4px;
       padding:5px 12px;cursor:pointer;font-size:12px;font-weight:600}
  .btn:hover{opacity:.85}
  .btn-sm{background:none;border:1px solid var(--br);color:var(--dim);border-radius:3px;
          padding:3px 9px;cursor:pointer;font-size:11px}
  .btn-sm:hover{border-color:var(--teal);color:var(--teal)}
  .btn-upd{background:#4ec94e;color:#000;font-weight:700}
  .tb{background:none;border:1px solid var(--br);border-radius:3px;color:var(--dim);
      padding:2px 7px;cursor:pointer;font-size:10px}
  .tb:hover{border-color:var(--teal);color:var(--teal)}
  .add-btn{background:rgba(78,201,176,.12);border:1px solid var(--teal);border-radius:3px;
           color:var(--teal);padding:2px 7px;cursor:pointer;font-size:10px;font-weight:600}
  .add-btn:hover{background:rgba(78,201,176,.25)}
  table{width:100%;border-collapse:collapse;font-size:12px}
  td{padding:3px 7px;border-bottom:1px solid var(--br)}
  .ok{color:var(--grn);font-weight:700;width:18px}.miss{color:var(--red);width:18px}
  .dim{color:var(--dim);font-size:11px}
  .chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:3px}
  .chip{display:inline-flex;align-items:center;background:var(--sf);border:1px solid var(--br);
        border-radius:12px;padding:2px 9px;font-size:11px;cursor:pointer}
  .chip:hover{border-color:var(--teal)}.chip.sel{background:rgba(78,201,176,.15);border-color:var(--teal);color:var(--teal)}
  .chip input{display:none}
  .qa{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:12px}
  .qa-btn{background:none;border:1px solid var(--br);border-radius:4px;color:var(--dim);
          padding:4px 7px;cursor:pointer;font-size:11px;text-align:left}
  .qa-btn:hover{border-color:var(--teal);color:var(--teal)}
  .pb{background:var(--sf);border:1px solid var(--br);border-radius:4px;color:var(--fg);
      padding:5px 9px;cursor:pointer;font-size:12px;text-align:left;display:block;width:100%;margin-bottom:3px}
  .pb:hover{border-color:var(--teal);background:rgba(78,201,176,.06)}
  .warn-banner{background:rgba(206,145,120,.1);border:1px solid var(--amb);border-radius:4px;
               padding:6px 10px;font-size:11px;color:var(--amb);margin-bottom:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .info-box{background:rgba(78,201,176,.06);border:1px solid rgba(78,201,176,.25);
            border-radius:4px;padding:7px 10px;font-size:11px;color:var(--teal);margin-bottom:8px}
  .ver-grid{display:grid;grid-template-columns:100px 1fr;gap:4px 8px;font-size:12px;margin-bottom:10px}
  .ver-lbl{color:var(--dim)}.ver-val{font-weight:600}
  .sys-grid{display:grid;grid-template-columns:80px 1fr;gap:3px 8px;font-size:11px;margin-top:6px}
  .sys-lbl{color:var(--dim)}.sys-val{font-family:var(--vscode-editor-font-family,'Cascadia Code',monospace)}
  .badge{display:inline-block;background:rgba(78,201,176,.2);color:var(--teal);
         border-radius:10px;padding:1px 7px;font-size:9px;font-weight:700;margin-left:4px}
  .filter-in{font-size:11px;padding:3px 6px;margin-bottom:4px;width:100%}
  .btn-row{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
</style></head>
<body>
<div class="topbar">
  <span class="title">🧠 Governance</span>
  <div style="display:flex;gap:5px">
    <button class="btn-sm" onclick="refresh()">↺</button>
    <button class="btn-sm" onclick="sendToAgent('Run the session start protocol: sync, load AGENTS.md, check LEDGER.md.')">🤖 Agent</button>
  </div>
</div>
${ood ? `<div class="warn-banner">⚠ scaffold.yml spec_version <b>${s.spec_version}</b> older than installed <b>${data.installedVersion}</b><button class="tb" onclick="runCmd('upgrade')">↑ upgrade</button></div>` : ''}
<div class="tab-bar">
  <button class="tab active" onclick="sw('project')">📁 Project</button>
  <button class="tab" onclick="sw('tools')">🔧 Tools</button>
  <button class="tab" onclick="sw('files')">📋 Files</button>
  <button class="tab" onclick="sw('updates')">🆙 Updates${upd ? '<span class="badge">NEW</span>' : ''}</button>
  <button class="tab" onclick="sw('actions')">⚡ Actions</button>
</div>
<div class="scroll">

<!-- Project tab -->
<div id="t-project" class="tab-pane active">
<div class="row">
  <div class="fg"><label class="fl">Project Name</label><input type="text" id="name" value="${s.name ?? ''}"></div>
  <div class="fg"><label class="fl">Project Type</label><select id="type">${typeOpts}</select></div>
</div>
<div class="fg"><label class="fl">Description</label><input type="text" id="desc" value="${s.description ?? ''}"></div>
<div class="fg"><label class="fl">Language(s)</label>
  <input class="filter-in" type="text" placeholder="Filter…" oninput="filt(this,'language')">
  <div class="chips">${chips(LANGUAGES, selL, 'language')}</div>
</div>
<div class="row">
  <div class="fg"><label class="fl">VCS Platform</label><select id="vcs">${vcsOpts}</select></div>
  <div class="fg"><label class="fl">Spec Version</label><input type="text" id="specver" value="${s.spec_version ?? ''}" disabled style="opacity:.5"></div>
</div>
<div class="btn-row">
  <button class="btn" onclick="save()">💾 Save</button>
  <button class="btn-sm" onclick="detectLang()">🔍 Detect Languages</button>
  <button class="btn-sm" onclick="runCmd('upgrade')">↑ Upgrade spec</button>
</div>
</div>

<!-- Tools tab -->
<div id="t-tools" class="tab-pane">
<div class="info-box">Record which FPGA/HDL tools and agent integrations your project uses.
  specsmith uses this to generate CI/CD adapters and AGENTS.md guidance.</div>
<h3>FPGA / HDL Tools</h3>
<div class="chips">${chips(FPGA_TOOLS, selF, 'fpga_tool')}</div>
<h3>Agent Integrations</h3>
<div class="chips">${chips(INTEGRATIONS, selI, 'integration')}</div>
<h3>Target Platforms</h3>
<div class="chips">${chips(PLATFORMS, selP, 'platform')}</div>
<div class="btn-row"><button class="btn" onclick="save()">💾 Save</button></div>
</div>

<!-- Files tab -->
<div id="t-files" class="tab-pane">
<div class="info-box">AI prompts auto-open an agent session if none is active.</div>
<table>
  <thead><tr><td></td><td><b>File</b></td><td class="dim">Lines</td><td></td></tr></thead>
  <tbody>${fileRows}</tbody>
</table>
</div>

<!-- Updates tab -->
<div id="t-updates" class="tab-pane">
<h3>specsmith Version</h3>
<div class="ver-grid">
  <span class="ver-lbl">Installed</span><span class="ver-val">${data.installedVersion ?? '—'}</span>
  <span class="ver-lbl">Available</span><span class="ver-val" id="ver-avail">${data.availableVersion ?? '(not checked)'}</span>
  <span class="ver-lbl">Last check</span><span class="ver-lbl" id="last-check">${data.lastUpdateCheck ?? 'never'}</span>
</div>
<div class="btn-row">
  <button class="btn" id="chk-btn" onclick="chkVer()">🔍 Check for Updates</button>
  ${upd ? '<button class="btn btn-upd" onclick="installUpd()">⬆ Install Update</button>' : ''}
</div>
<h3 style="margin-top:16px">System Info</h3>
<div id="sys-load" class="dim">Loading…</div>
<div id="sys-grid" class="sys-grid" style="display:none"></div>
<div style="margin-top:8px"><button class="btn-sm" onclick="getSys()">↺ Refresh</button></div>
</div>

<!-- Actions tab -->
<div id="t-actions" class="tab-pane">
<h3>Quick Actions</h3>
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
<h3>AI Prompt Palette</h3>
${prompts}
</div>
</div><!-- scroll -->

<script>
const vscode=acquireVsCodeApi();
const LANGUAGES=${JSON.stringify(LANGUAGES)};
const FPGA_TOOLS=${JSON.stringify(FPGA_TOOLS)};

function sw(id){
  const tabs=['project','tools','files','updates','actions'];
  document.querySelectorAll('.tab').forEach((t,i)=>t.classList.toggle('active',tabs[i]===id));
  document.querySelectorAll('.tab-pane').forEach(p=>p.classList.toggle('active',p.id==='t-'+id));
  if(id==='updates')getSys();
}
function refresh(){vscode.postMessage({command:'refresh'})}
function runCmd(cmd){vscode.postMessage({command:'runCommand',cmd})}
function sendToAgent(p){vscode.postMessage({command:'sendToAgent',prompt:p})}
function openFile(f){vscode.postMessage({command:'openFile',file:f})}
function addFile(t){vscode.postMessage({command:'addFile',addType:t})}
function detectLang(){vscode.postMessage({command:'detectLanguages'})}
function chkVer(){document.getElementById('chk-btn').textContent='⌛…';vscode.postMessage({command:'checkVersion'})}
function installUpd(){vscode.postMessage({command:'installUpdate'})}
function getSys(){
  document.getElementById('sys-load').style.display='';
  document.getElementById('sys-grid').style.display='none';
  vscode.postMessage({command:'getSysInfo'});
}
function save(){
  vscode.postMessage({command:'saveScaffold',scaffold:{
    name:document.getElementById('name').value,
    type:document.getElementById('type').value,
    description:document.getElementById('desc').value,
    vcs_platform:document.getElementById('vcs').value,
    languages:[...document.querySelectorAll('input[name=language]:checked')].map(e=>e.value),
    integrations:[...document.querySelectorAll('input[name=integration]:checked')].map(e=>e.value),
    platforms:[...document.querySelectorAll('input[name=platform]:checked')].map(e=>e.value),
    fpga_tools:[...document.querySelectorAll('input[name=fpga_tool]:checked')].map(e=>e.value),
  }});
}
function filt(inp,name){
  const q=inp.value.toLowerCase();
  document.querySelectorAll('input[name='+name+']').forEach(cb=>{
    const c=cb.closest('.chip');if(c)c.style.display=(!q||cb.value.toLowerCase().includes(q))?'':'none';
  });
}
document.querySelectorAll('.chip').forEach(c=>{
  c.addEventListener('click',()=>c.classList.toggle('sel',c.querySelector('input').checked));
});
window.addEventListener('message',({data})=>{
  if(data.type==='versionInfo'){
    document.getElementById('chk-btn').textContent='🔍 Check for Updates';
    if(data.error){document.getElementById('ver-avail').textContent='Error — try again';}
    else if(data.available){
      document.getElementById('ver-avail').textContent=data.available;
      document.getElementById('last-check').textContent=new Date().toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
    }
  }
  if(data.type==='sysInfo'){
    const g=document.getElementById('sys-grid');
    const labels={os:'OS',cpu:'CPU',cores:'Cores',ram:'RAM',gpu:'GPU',disk:'Disk'};
    g.innerHTML=Object.entries(labels).filter(([k])=>data.info[k])
      .map(([k,l])=>\`<span class="sys-lbl">\${l}</span><span class="sys-val">\${data.info[k]}</span>\`).join('');
    document.getElementById('sys-load').style.display='none';
    g.style.display='grid';
  }
});
</script>
</body></html>`;
}
