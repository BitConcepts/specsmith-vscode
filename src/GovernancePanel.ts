// SPDX-License-Identifier: MIT
// Copyright (c) 2026 BitConcepts, LLC. All rights reserved.
/**
 * GovernancePanel v3 — 6-tab Settings panel.
 *
 * Tabs:  Project | Tools | Files | Updates & System | Actions & AI | Execution
 */
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { augmentedEnv, findSpecsmith } from './bridge';

let _panel: vscode.WebviewPanel | undefined;
let _ctx: vscode.ExtensionContext | undefined;
let _projectDir: string | undefined;
let _sendFn: ((t: string) => void) | undefined;
let _openFn: (() => Promise<void>) | undefined;

// Augmented process env with Python Scripts dirs prepended — fixes version
// detection when VS Code extension host PATH doesn't include pipx/pip bins.
const _ENV: NodeJS.ProcessEnv = augmentedEnv(process.env);

/** Dispose the Settings panel — called when all sessions for a project close. */
export function closeGovernancePanel(): void {
  _panel?.dispose();
}

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
    '⚙ Settings',
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

/** Semver comparison: returns true if version a is strictly newer than b. */
function _isNewerVersion(a: string, b: string): boolean {
  const parse = (v: string) => v.split('.').map((n) => parseInt(n, 10) || 0);
  const [aMaj, aMin, aPatch] = parse(a);
  const [bMaj, bMin, bPatch] = parse(b);
  if (aMaj !== bMaj) { return aMaj > bMaj; }
  if (aMin !== bMin) { return aMin > bMin; }
  return aPatch > bPatch;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ScaffoldData {
  name?: string; type?: string; description?: string; vcs_platform?: string; spec_version?: string;
  languages?: string[]; integrations?: string[]; platforms?: string[];
  fpga_tools?: string[]; auxiliary_disciplines?: string[];
  execution_profile?: string;
  custom_allowed_commands?: string[];
  custom_blocked_commands?: string[];
  custom_blocked_tools?: string[];
}
interface GovFile { rel: string; label: string; exists: boolean; lines?: number; addCmd?: string; }
interface AEEPhaseInfo {
  key:   string;
  emoji: string;
  label: string;
  desc:  string;
  pct:   number;   // 0–100 readiness
  ready: boolean;
  next:  string | null;
}
interface ProjectData {
  projectDir: string; scaffold: ScaffoldData; govFiles: GovFile[];
  installedVersion: string | null; availableVersion: string | null; lastUpdateCheck: string | null;
  phase: AEEPhaseInfo;
  releaseChannel: string;  // 'stable' | 'pre-release'
}
interface GovMsg {
  command:
    | 'saveScaffold' | 'runCommand' | 'sendToAgent' | 'openFile' | 'refresh'
    | 'addFile' | 'checkVersion' | 'installUpdate' | 'getSysInfo' | 'detectLanguages'
    | 'phaseNext' | 'phaseSet'
    | 'getOllamaModels' | 'ollamaRemoveModel' | 'ollamaUpdateModel' | 'ollamaUpdateAll'
    | 'checkOllamaVersion' | 'ollamaUpgrade' | 'scanProject'
    | 'saveExecution' | 'scanTools' | 'toolInstall'
    | 'reloadWindow' | 'detectTools' | 'detectDisciplines' | 'setReleaseChannel';
  scaffold?: ScaffoldData; cmd?: string; prompt?: string; file?: string; addType?: string;
  phaseKey?: string; modelId?: string;
  profileName?: string; customAllowed?: string; customBlocked?: string; customBlockedTools?: string;
  toolKey?: string;
  channel?: string;  // for setReleaseChannel
}

// ── Constants ─────────────────────────────────────────────────────────────────

// Full language list — display names from languages.py (single source of truth)
const LANGUAGES = [
  // Systems
  'C', 'C++', 'Rust', 'Go', 'Nim', 'Zig',
  // Managed
  'Python', 'C#', 'VB.NET', 'Java', 'Kotlin', 'Scala', 'Groovy',
  // Web / JS
  'JavaScript', 'TypeScript', 'Vue', 'Svelte',
  // Mobile
  'Swift', 'Dart', 'Objective-C',
  // HDL / FPGA  (Verilog ≠ SystemVerilog — IEEE 1364 vs IEEE 1800)
  'VHDL', 'Verilog', 'SystemVerilog',
  // Scripting
  'Bash', 'PowerShell', 'Cmd / Batch', 'Lua', 'Ruby', 'PHP', 'Perl',
  // Functional
  'Haskell', 'OCaml', 'Elixir', 'Erlang', 'Clojure',
  // Config / Data
  'YAML', 'TOML', 'JSON', 'SQL', 'Terraform / HCL', 'Protobuf', 'GraphQL',
  // Build
  'CMake', 'Makefile',
  // Embedded / Linux
  'BitBake', 'DeviceTree',
  // Documentation
  'Markdown', 'LaTeX', 'reStructuredText', 'AsciiDoc',
  // Hardware / EDA
  'KiCad',
  // Data Science
  'R', 'Julia', 'MATLAB', 'Jupyter Notebook',
];

const VCS_PLATFORMS = ['github','gitlab','bitbucket','azure-devops','gitea','none'];

// Grouped project types — values must match Python ProjectType enum exactly
const PROJECT_TYPE_GROUPS: Array<{ group: string; types: Array<{ value: string; label: string }> }> = [
  { group: 'Python', types: [
    { value: 'cli-python',              label: 'CLI tool (Python)' },
    { value: 'library-python',          label: 'Library / SDK (Python)' },
    { value: 'backend-frontend',        label: 'Python backend + web frontend' },
    { value: 'backend-frontend-tray',   label: 'Python backend + frontend + tray' },
  ]},
  { group: 'Systems / C/C++/Rust/Go', types: [
    { value: 'cli-rust',                label: 'CLI tool (Rust)' },
    { value: 'library-rust',            label: 'Library / crate (Rust)' },
    { value: 'cli-go',                  label: 'CLI tool (Go)' },
    { value: 'cli-c',                   label: 'CLI tool (C/C++)' },
    { value: 'library-c',               label: 'Library (C/C++)' },
  ]},
  { group: 'Web / JS / .NET', types: [
    { value: 'web-frontend',            label: 'Web frontend (SPA)' },
    { value: 'fullstack-js',            label: 'Fullstack JS/TS' },
    { value: 'dotnet-app',              label: '.NET / C# application' },
    { value: 'mobile-app',              label: 'Mobile app (iOS/Android/Flutter)' },
    { value: 'browser-extension',       label: 'Browser extension' },
  ]},
  { group: 'Hardware / FPGA', types: [
    { value: 'fpga-rtl',                label: 'FPGA / RTL (generic / OSS)' },
    { value: 'fpga-rtl-amd',             label: 'FPGA / RTL — AMD Adaptive Computing (Vivado)' },
    { value: 'fpga-rtl-xilinx',          label: 'FPGA / RTL — AMD (legacy fpga-rtl-xilinx id)' },
    { value: 'fpga-rtl-intel',          label: 'FPGA / RTL — Intel Altera (Quartus)' },
    { value: 'fpga-rtl-lattice',        label: 'FPGA / RTL — Lattice (Diamond)' },
    { value: 'mixed-fpga-embedded',     label: 'Mixed: FPGA + Embedded C/C++' },
    { value: 'mixed-fpga-firmware',     label: 'Mixed: FPGA + Python/C verification' },
    { value: 'embedded-hardware',       label: 'Embedded / hardware (C/C++)' },
    { value: 'yocto-bsp',               label: 'Yocto / embedded Linux BSP' },
    { value: 'pcb-hardware',            label: 'PCB / hardware design (KiCad)' },
  ]},
  { group: 'DevOps / Data', types: [
    { value: 'devops-iac',              label: 'DevOps / IaC (Terraform etc.)' },
    { value: 'data-ml',                 label: 'Data / ML pipeline' },
    { value: 'microservices',           label: 'Microservices' },
    { value: 'monorepo',                label: 'Monorepo (multi-package)' },
  ]},
  { group: 'Documents', types: [
    { value: 'spec-document',           label: 'Technical specification' },
    { value: 'user-manual',             label: 'User manual / documentation' },
    { value: 'research-paper',          label: 'Research paper / white paper' },
    { value: 'api-specification',       label: 'API specification' },
    { value: 'requirements-mgmt',       label: 'Requirements management' },
  ]},
  { group: 'Business / Legal', types: [
    { value: 'business-plan',           label: 'Business plan / proposal' },
    { value: 'patent-application',      label: 'Patent application' },
    { value: 'legal-compliance',        label: 'Legal / compliance' },
  ]},
  { group: 'AEE Research', types: [
    { value: 'epistemic-pipeline',      label: 'Epistemic pipeline (AEE)' },
    { value: 'knowledge-engineering',   label: 'Knowledge engineering' },
    { value: 'aee-research',            label: 'AEE research project' },
  ]},
];

// Auxiliary disciplines for mixed projects
const AUXILIARY_DISCIPLINES = [
  { value: 'cli-python',          label: 'Python scripting / verification' },
  { value: 'embedded-c',         label: 'Embedded C driver' },
  { value: 'embedded-hardware',   label: 'Embedded C/C++ (full)' },
  { value: 'cli-rust',            label: 'Rust component' },
  { value: 'web-frontend',        label: 'Web frontend / HMI' },
  { value: 'yocto-bsp',           label: 'Yocto BSP / Linux' },
  { value: 'devops-iac',          label: 'DevOps / CI/CD' },
  { value: 'data-ml',             label: 'Data analysis / ML' },
  { value: 'fpga-rtl',            label: 'FPGA RTL core' },
];

// INTEGRATIONS intentionally not shown in UI — VS Code extension IS the agent integration.
// const INTEGRATIONS = [...];
const PLATFORMS    = ['linux','windows','macos','embedded','cloud','wasm','amd-fpga','intel-fpga','lattice-fpga'];

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
      for (const field of ['integrations','platforms','languages','fpga_tools','auxiliary_disciplines','custom_allowed_commands','custom_blocked_commands','custom_blocked_tools']) {
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
    // Skip lowercase architecture.md if uppercase exists
    if (rel === 'docs/architecture.md' && fs.existsSync(path.join(projectDir, 'docs/ARCHITECTURE.md'))) { return []; }
    // docs/REQUIREMENTS.md is canonical — skip root REQUIREMENTS.md if docs/ version exists.
    // Source of truth: docs/REQUIREMENTS.md (matches specsmith scaffold template).
    if (rel === 'REQUIREMENTS.md' && fs.existsSync(path.join(projectDir, 'docs/REQUIREMENTS.md'))) { return []; }
    const fp = path.join(projectDir, rel);
    const exists = fs.existsSync(fp);
    let lines: number | undefined;
    if (exists) { try { lines = fs.readFileSync(fp, 'utf8').split('\n').length; } catch { /* ignore */ } }
    return [{ rel, label, exists, lines, addCmd: addType } as GovFile];
  });

  let installedVersion: string | null = null;
  try {
    const exec = vscode.workspace.getConfiguration('specsmith').get<string>('executablePath', 'specsmith');
    // Use the SAME findSpecsmith logic as bridge.ts: iterates through the augmented
    // PATH and verifies the binary is >= 0.3.1. This guarantees parity between the
    // session (bridge) and the Settings panel version display.
    const resolved = findSpecsmith(exec, _ENV.PATH ?? '');
    const r = cp.spawnSync(resolved, ['--version'], { timeout: 3000, encoding: 'utf8' });
    if (r.status === 0) { const m = (r.stdout ?? '').match(/(\d+\.\d+\.\d+)/); installedVersion = m?.[1] ?? null; }
  } catch { /* ignore */ }

  const avail     = context.globalState.get<string>('specsmith.availableVersion', '');
  const checkMs   = context.globalState.get<number>('specsmith.lastVersionCheck', 0);
  const lastCheck = checkMs ? new Date(checkMs).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;

  // Read AEE phase from scaffold.yml
  const phase = _readPhase(projectDir);

  // Release channel from VS Code settings
  const releaseChannel = vscode.workspace.getConfiguration('specsmith').get<string>('releaseChannel', 'stable');

  return { projectDir, scaffold, govFiles, installedVersion, availableVersion: avail || null, lastUpdateCheck: lastCheck, phase, releaseChannel };
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
      // Don't reload — webview JS updates via versionInfo message type without losing active tab
      await _checkVersion(_ctx);
      break;

    case 'installUpdate': {
      const channel = vscode.workspace.getConfiguration('specsmith').get<string>('releaseChannel', 'stable');
      const isPre   = channel === 'pre-release';
      const upgradeCmd = isPre
        ? 'pipx install specsmith --pip-args="--pre" --force || pip install --pre --upgrade specsmith'
        : 'pipx upgrade specsmith || pip install --upgrade specsmith';
      const term = vscode.window.createTerminal({ name: 'specsmith upgrade', shellPath: _shellPath() });
      term.sendText(upgradeCmd);
      term.show();
      // Tell webview to swap Install→Reload button so user can reload when done
      _panel?.webview.postMessage({ type: 'installStarted' });
      break;
    }

    case 'reloadWindow':
      void vscode.commands.executeCommand('workbench.action.reloadWindow');
      break;

    case 'getSysInfo':
      void _sendSysInfo();
      break;

    case 'getOllamaModels':
      void _sendOllamaModels();
      break;

    case 'ollamaRemoveModel': {
      if (!msg.modelId) { break; }
      const exec = vscode.workspace.getConfiguration('specsmith').get<string>('executablePath', 'specsmith');
      const term = vscode.window.createTerminal({ name: 'ollama remove', cwd: _projectDir });
      term.sendText(`${exec} ollama remove "${msg.modelId}" --yes`);
      term.show();
      break;
    }

    case 'ollamaUpdateModel': {
      if (!msg.modelId) { break; }
      // Use 'ollama pull' directly — bypasses specsmith CLI for compatibility
      const term2 = vscode.window.createTerminal({ name: 'ollama update' });
      term2.sendText(`ollama pull "${msg.modelId}"`);
      term2.show();
      break;
    }

    case 'ollamaUpdateAll': {
      // Bypass specsmith CLI — use 'ollama pull' directly so this works even
      // with older installed specsmith versions that don't have the ollama group.
      const { OllamaManager: _OM2 } = await import('./OllamaManager');
      const installedIds = await _OM2.getInstalledIds();
      if (!installedIds.length) {
        void vscode.window.showInformationMessage('No Ollama models installed.');
        break;
      }
      const term3 = vscode.window.createTerminal({ name: 'ollama update-all' });
      term3.sendText(installedIds.map((m) => `ollama pull "${m}"`).join(' && '));
      term3.show();
      break;
    }

    case 'checkOllamaVersion':
      void _checkOllamaVersion();
      break;

    case 'ollamaUpgrade': {
      // Use platform-specific upgrade command directly — bypasses specsmith CLI
      const upgradeCmd = process.platform === 'win32'
        ? 'winget upgrade --id Ollama.Ollama'
        : process.platform === 'darwin'
          ? 'brew upgrade ollama'
          : 'curl -fsSL https://ollama.ai/install.sh | sh';
      const term4 = vscode.window.createTerminal({ name: 'ollama upgrade', shellPath: _shellPath() });
      term4.sendText(upgradeCmd);
      term4.show();
      break;
    }

    case 'scanProject':
      void _runScanProject();
      break;

    case 'saveExecution': {
      if (!msg.profileName) { break; }
      _saveExecutionSettings(_projectDir, msg.profileName, msg.customAllowed ?? '', msg.customBlocked ?? '', msg.customBlockedTools ?? '');
      break;
    }

    case 'scanTools':
      void _runToolsScan();
      break;

    case 'detectTools':
      void _runDetectTools();
      break;

    case 'setReleaseChannel': {
      if (!msg.channel) { break; }
      const cfg = vscode.workspace.getConfiguration('specsmith');
      void cfg.update('releaseChannel', msg.channel, vscode.ConfigurationTarget.Global);
      // Auto-refresh version check so pre-release versions show immediately
      void _checkVersion(_ctx);
      break;
    }

    case 'detectDisciplines': {
      const suggestions = _suggestDisciplines(
        msg.scaffold?.type ?? '',
        msg.scaffold?.languages ?? [],
      );
      _panel?.webview.postMessage({ type: 'disciplinesSuggested', disciplines: suggestions });
      break;
    }

    case 'toolInstall': {
      if (!msg.toolKey) { break; }
      const exec5 = vscode.workspace.getConfiguration('specsmith').get<string>('executablePath', 'specsmith');
      const term5 = vscode.window.createTerminal({ name: `install ${msg.toolKey}`, cwd: _projectDir });
      term5.sendText(`${exec5} tools install "${msg.toolKey}"`);
      term5.show();
      break;
    }

    case 'phaseNext': {
      const exec = vscode.workspace.getConfiguration('specsmith').get<string>('executablePath', 'specsmith');
      const term = vscode.window.createTerminal({ name: 'specsmith phase', cwd: _projectDir });
      term.sendText(`${exec} phase next --project-dir "${_projectDir}"`);
      term.show();
      // Reload after short delay
      await new Promise<void>((r) => setTimeout(r, 1500));
      _reload();
      break;
    }

    case 'phaseSet': {
      if (!msg.phaseKey) { break; }
      const exec2 = vscode.workspace.getConfiguration('specsmith').get<string>('executablePath', 'specsmith');
      const r2    = cp.spawnSync(exec2, ['phase', 'set', msg.phaseKey, '--force', '--project-dir', _projectDir], { encoding: 'utf8', timeout: 5000 });
      if (r2.status === 0) {
        void vscode.window.showInformationMessage(`AEE phase set to: ${msg.phaseKey}`);
      } else {
        void vscode.window.showWarningMessage(`phase set failed: ${(r2.stderr ?? '').slice(0, 200)}`);
      }
      _reload();
      break;
    }
  }
}

// ── Version helpers ────────────────────────────────────────────────────────────

/** Parse a PEP 440 version to a numeric tuple for comparison.
 *  Returns [major, minor, patch, pre] where stable releases have pre=999999 (highest). */
function _parseVer(v: string): [number, number, number, number] {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:\.dev(\d+)|a(\d+)|b(\d+)|rc(\d+))?/);
  if (!m) { return [0, 0, 0, 0]; }
  let pre = 999999;  // stable > all pre-releases
  if (m[4] !== undefined)      { pre = parseInt(m[4], 10); }         // .devN (lowest)
  else if (m[5] !== undefined) { pre = 10000 + parseInt(m[5], 10); } // aN
  else if (m[6] !== undefined) { pre = 20000 + parseInt(m[6], 10); } // bN
  else if (m[7] !== undefined) { pre = 30000 + parseInt(m[7], 10); } // rcN
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10), pre];
}

/** Compare two PEP 440 version strings. Returns <0/0/>0 like Array.sort. */
function _cmpVer(a: string, b: string): number {
  const av = _parseVer(a), bv = _parseVer(b);
  for (let i = 0; i < 4; i++) {
    const d = av[i] - bv[i];
    if (d !== 0) { return d; }
  }
  return 0;
}

// ── Version check ──────────────────────────────────────────────────────────────

async function _checkVersion(context: vscode.ExtensionContext): Promise<void> {
  const channel = vscode.workspace.getConfiguration('specsmith').get<string>('releaseChannel', 'stable');
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
    const pypiData = JSON.parse(raw) as {
      info?: { version?: string };
      releases?: Record<string, Array<{ yanked?: boolean }>>;
    };

    let latest: string;
    if (channel === 'pre-release') {
      // Find the highest version across ALL releases (including devN / alpha / beta / rc)
      const candidates = Object.entries(pypiData.releases ?? {})
        .filter(([, files]) => files.length > 0 && !files.every(f => f.yanked))
        .map(([v]) => v);
      candidates.sort(_cmpVer);
      latest = candidates[candidates.length - 1] ?? pypiData.info?.version ?? '';
    } else {
      // Stable channel: use the latest stable version from PyPI info
      latest = pypiData.info?.version ?? '';
    }

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

// ── Ollama model list ──────────────────────────────────────────────────

async function _sendOllamaModels(): Promise<void> {
  if (!_panel) { return; }
  try {
    const { OllamaManager } = await import('./OllamaManager');
    const detail = await OllamaManager.getInstalledIds();
    // Try to get richer detail via the API
    const http = await import('http');
    const models = await new Promise<Array<{ name: string; size: number; modified_at: string }>>(
      (resolve) => {
        let data = '';
        http.get('http://localhost:11434/api/tags', (r) => {
          r.on('data', (c: Buffer) => { data += c.toString(); });
          r.on('end', () => {
            try {
              const j = JSON.parse(data) as { models?: Array<{ name: string; size: number; modified_at: string }> };
              resolve(j.models ?? []);
            } catch { resolve([]); }
          });
        }).on('error', () => resolve(detail.map((n) => ({ name: n, size: 0, modified_at: '' }))));
      },
    );
    _panel.webview.postMessage({ type: 'ollamaModels', models });
  } catch {
    _panel.webview.postMessage({ type: 'ollamaModels', models: [] });
  }
}

// ── Ollama version check ────────────────────────────────────────────

async function _checkOllamaVersion(): Promise<void> {
  if (!_panel) { return; }
  // Get local version from Ollama API
  let installed: string | null = null;
  try {
    const http = await import('http');
    installed = await new Promise<string | null>((resolve) => {
      let d = '';
      http.get('http://localhost:11434/api/version', (r) => {
        r.on('data', (c: Buffer) => { d += c.toString(); });
        r.on('end', () => {
          try { resolve((JSON.parse(d) as { version?: string }).version ?? null); }
          catch { resolve(null); }
        });
      }).on('error', () => resolve(null));
    });
  } catch { /* ignore */ }

  // Get latest from GitHub releases
  let latest: string | null = null;
  try {
    const httpsM = await import('https');
    latest = await new Promise<string | null>((resolve, reject) => {
      const req = httpsM.get(
        'https://api.github.com/repos/ollama/ollama/releases/latest',
        { headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'specsmith-vscode' } },
        (r) => {
          let d = '';
          r.on('data', (c: Buffer) => { d += c; });
          r.on('end', () => {
            try {
              const tag = (JSON.parse(d) as { tag_name?: string }).tag_name ?? '';
              resolve(tag.replace(/^v/, '') || null);
            } catch { resolve(null); }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
  } catch { /* ignore */ }

  _panel.webview.postMessage({ type: 'ollamaVersionInfo', installed, latest });
}

// ── Project scanner ───────────────────────────────────────────────

async function _runDetectTools(): Promise<void> {
  if (!_panel || !_projectDir) { return; }
  const exec = vscode.workspace.getConfiguration('specsmith').get<string>('executablePath', 'specsmith');
  // Map tool executable names (scan output) back to FPGA_TOOLS chip values
  const EXE_TO_CHIP: Record<string, string> = {
    'vivado': 'vivado', 'quartus_sh': 'quartus', 'radiantlsp': 'radiant',
    'diamondc': 'diamond', 'gw_sh': 'gowin', 'ghdl': 'ghdl',
    'iverilog': 'iverilog', 'verilator': 'verilator', 'vsim': 'modelsim',
    'xsim': 'xsim', 'gtkwave': 'gtkwave', 'surfer': 'surfer', 'vsg': 'vsg',
    'verible-verilog-lint': 'verible', 'svlint': 'svlint', 'sby': 'symbiyosys',
    'yosys': 'yosys', 'nextpnr-ecp5': 'nextpnr', 'openFPGALoader': 'openFPGALoader',
  };
  const r = cp.spawnSync(
    exec,
    ['tools', 'scan', '--project-dir', _projectDir, '--json', '--fpga'],
    { encoding: 'utf8', timeout: 15000, env: _ENV },
  );
  let chipValues: string[] = [];
  if (r.status === 0 && r.stdout.trim()) {
    try {
      const parsed = JSON.parse(r.stdout.trim()) as { tools?: Array<{ name: string; installed: boolean }> };
      chipValues = (parsed.tools ?? [])
        .filter(t => t.installed)
        .map(t => EXE_TO_CHIP[t.name] ?? t.name)
        .filter(v => FPGA_TOOLS.includes(v));
    } catch { /* ignore */ }
  }
  _panel.webview.postMessage({ type: 'toolsDetected', chipValues });
}

/** Suggest auxiliary disciplines based on primary project type + detected languages. */
function _suggestDisciplines(projectType: string, languages: string[]): string[] {
  const suggestions: string[] = [];
  const langs = new Set(languages.map(l => l.toLowerCase()));
  const isHDL = projectType.startsWith('fpga') || projectType.startsWith('mixed-fpga');
  const isEmbedded = projectType === 'embedded-hardware';
  const isYocto = projectType === 'yocto-bsp';

  if (isHDL) {
    if (langs.has('c') || langs.has('c++')) { suggestions.push('embedded-c', 'embedded-hardware'); }
    if (langs.has('python'))                { suggestions.push('cli-python'); }
    if (langs.has('rust'))                  { suggestions.push('cli-rust'); }
    if (langs.has('javascript') || langs.has('typescript')) { suggestions.push('web-frontend'); }
    if (langs.has('bitbake') || langs.has('devicetree'))    { suggestions.push('yocto-bsp'); }
  } else if (isEmbedded || isYocto) {
    if (langs.has('vhdl') || langs.has('verilog') || langs.has('systemverilog')) {
      suggestions.push('fpga-rtl');
    }
    if (langs.has('python')) { suggestions.push('cli-python'); }
  }
  // Deduplicate and keep only valid AUXILIARY_DISCIPLINES values
  const valid = new Set(AUXILIARY_DISCIPLINES.map(d => d.value));
  return [...new Set(suggestions)].filter(s => valid.has(s));
}

async function _runScanProject(): Promise<void> {
  if (!_panel || !_projectDir) { return; }
  const exec = vscode.workspace.getConfiguration('specsmith').get<string>('executablePath', 'specsmith');
  const r    = cp.spawnSync(
    exec,
    ['scan', '--project-dir', _projectDir, '--json'],
    { encoding: 'utf8', timeout: 15000, env: _ENV },
  );
  if (r.status !== 0 || !r.stdout.trim()) {
    const detail = ((r.stderr ?? '') + (r.stdout ?? '')).trim().slice(0, 300);
    const hint   = detail.includes('No such command') || detail.includes('Error: No such')
      ? 'specsmith scan not available — upgrade to v0.3.3+: Ctrl+Shift+P → specsmith: Install or Upgrade'
      : `specsmith scan failed: ${detail || 'empty output'}. Ensure specsmith v0.3.3+ is installed.`;
    void vscode.window.showWarningMessage(hint);
    return;
  }
  try {
    const result = JSON.parse(r.stdout.trim()) as {
      name?: string; type?: string; languages?: string[];
      fpga_tools?: string[]; auxiliary_disciplines?: string[];
      vcs_platform?: string;
    };
    _panel.webview.postMessage({ type: 'scanResult', result });
  } catch { /* ignore */ }
}

// ── scaffold helpers ───────────────────────────────────────────────

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

function _saveExecutionSettings(
  projectDir: string,
  profileName: string,
  customAllowed: string,
  customBlocked: string,
  customBlockedTools: string,
): void {
  const p = path.join(projectDir, 'scaffold.yml');
  if (!fs.existsSync(p)) { void vscode.window.showWarningMessage('scaffold.yml not found'); return; }
  let lines = fs.readFileSync(p, 'utf8').split('\n');
  if (profileName) { lines = _replaceYamlSection(lines, 'execution_profile', profileName); }
  const toList = (s: string) => s.split(/[,\n]/).map(x => x.trim()).filter(Boolean);
  const allowed = toList(customAllowed);
  const blocked = toList(customBlocked);
  const blockedTools = toList(customBlockedTools);
  if (allowed.length) { lines = _replaceYamlSection(lines, 'custom_allowed_commands', allowed); }
  if (blocked.length) { lines = _replaceYamlSection(lines, 'custom_blocked_commands', blocked); }
  if (blockedTools.length) { lines = _replaceYamlSection(lines, 'custom_blocked_tools', blockedTools); }
  fs.writeFileSync(p, lines.join('\n'), 'utf8');
  void vscode.window.showInformationMessage('Execution settings saved to scaffold.yml.');
}

async function _runToolsScan(): Promise<void> {
  if (!_panel || !_projectDir) { return; }
  const exec = vscode.workspace.getConfiguration('specsmith').get<string>('executablePath', 'specsmith');
  const r = cp.spawnSync(
    exec,
    ['tools', 'scan', '--project-dir', _projectDir, '--json', '--fpga'],
    { encoding: 'utf8', timeout: 15000, env: _ENV },
  );
  let tools: Array<{ name: string; category: string; installed: boolean; version: string }> = [];
  if (r.status === 0 && r.stdout.trim()) {
    try {
      const parsed = JSON.parse(r.stdout.trim()) as { tools?: typeof tools };
      tools = parsed.tools ?? [];
    } catch { /* ignore */ }
  }
  _panel.webview.postMessage({ type: 'toolsScanResult', tools });
}

function _saveScaffold(projectDir: string, scaffold: ScaffoldData): void {
  const p = path.join(projectDir, 'scaffold.yml');
  if (!fs.existsSync(p)) { void vscode.window.showWarningMessage('scaffold.yml not found — run specsmith init first'); return; }
  let lines = fs.readFileSync(p, 'utf8').split('\n');
  for (const [k, v] of Object.entries({ name: scaffold.name ?? '', type: scaffold.type ?? '', description: scaffold.description ?? '', vcs_platform: scaffold.vcs_platform ?? '' })) {
    if (v) { lines = _replaceYamlSection(lines, k, v); }
  }
  for (const [k, v] of Object.entries({
    languages: scaffold.languages ?? [],
    integrations: scaffold.integrations ?? [],
    platforms: scaffold.platforms ?? [],
    fpga_tools: scaffold.fpga_tools ?? [],
    auxiliary_disciplines: scaffold.auxiliary_disciplines ?? [],
  })) {
    if (v.length) { lines = _replaceYamlSection(lines, k, v); }
  }
  fs.writeFileSync(p, lines.join('\n'), 'utf8');
  void vscode.window.showInformationMessage('scaffold.yml saved.');
}

// ── Language detection ─────────────────────────────────────────────────────────

// EXT_LANG mirrors languages.py EXT_LANG (single source of truth — Verilog ≠ SystemVerilog)
const EXT_LANG: Record<string, string> = {
  // Systems
  '.c':'C', '.h':'C', '.cpp':'C++', '.cc':'C++', '.cxx':'C++', '.hpp':'C++',
  '.rs':'Rust', '.go':'Go', '.nim':'Nim', '.zig':'Zig',
  // Managed
  '.py':'Python', '.pyw':'Python', '.cs':'C#', '.java':'Java',
  '.kt':'Kotlin', '.scala':'Scala', '.vb':'VB.NET',
  // Web / JS
  '.js':'JavaScript', '.mjs':'JavaScript', '.jsx':'JavaScript',
  '.ts':'TypeScript', '.tsx':'TypeScript',
  '.vue':'Vue', '.svelte':'Svelte',
  // Mobile
  '.swift':'Swift', '.dart':'Dart',
  // HDL / FPGA  (IEEE 1364 Verilog ≠ IEEE 1800 SystemVerilog)
  '.vhd':'VHDL', '.vhdl':'VHDL',
  '.v':'Verilog',               // IEEE 1364 — legacy .v files
  '.sv':'SystemVerilog',        // IEEE 1800 — design files
  '.svh':'SystemVerilog',       // IEEE 1800 — header/interface files
  // Scripting
  '.sh':'Bash', '.bash':'Bash', '.ps1':'PowerShell', '.cmd':'Cmd / Batch', '.bat':'Cmd / Batch',
  '.lua':'Lua', '.rb':'Ruby', '.php':'PHP', '.pl':'Perl',
  // Functional
  '.hs':'Haskell', '.ml':'OCaml', '.ex':'Elixir', '.erl':'Erlang', '.clj':'Clojure',
  // Config / Data
  '.yml':'YAML', '.yaml':'YAML', '.toml':'TOML', '.sql':'SQL',
  '.tf':'Terraform / HCL', '.tfvars':'Terraform / HCL',
  '.proto':'Protobuf', '.graphql':'GraphQL', '.gql':'GraphQL',
  // Build
  '.cmake':'CMake',
  // Embedded / Linux
  '.bb':'BitBake', '.bbappend':'BitBake', '.bbclass':'BitBake',
  '.dts':'DeviceTree', '.dtsi':'DeviceTree',
  // Documentation
  '.md':'Markdown', '.tex':'LaTeX', '.rst':'reStructuredText', '.adoc':'AsciiDoc',
  // Hardware / EDA
  '.kicad_pcb':'KiCad', '.kicad_sch':'KiCad', '.kicad_pro':'KiCad',
  // Data science
  '.r':'R', '.rmd':'R', '.jl':'Julia', '.ipynb':'Jupyter Notebook',
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

// ── Phase reading ────────────────────────────────────────────────────────

const PHASE_CATALOG: Record<string, { emoji: string; label: string; desc: string; next: string | null }> = {
  inception:      { emoji: '\uD83C\uDF31', label: 'Inception',        desc: 'Governance scaffold, project type, AGENTS.md',           next: 'architecture'   },
  architecture:   { emoji: '\uD83C\uDFD7', label: 'Architecture',     desc: 'ARCHITECTURE.md, components, key decisions sealed',       next: 'requirements'   },
  requirements:   { emoji: '\uD83D\uDCCB', label: 'Requirements',     desc: 'REQUIREMENTS.md, stress-tested, equilibrium reached',     next: 'test_spec'      },
  test_spec:      { emoji: '\u2705',        label: 'Test Spec',        desc: 'TEST_SPEC.md covering all P1 requirements (≥80 %)',       next: 'implementation' },
  implementation: { emoji: '\u2699',        label: 'Implementation',   desc: 'Code → commit → audit → ledger cycle',                    next: 'verification'   },
  verification:   { emoji: '\uD83D\uDD2C', label: 'Verification',     desc: 'Epistemic audit passes, trace vault sealed',              next: 'release'        },
  release:        { emoji: '\uD83D\uDE80', label: 'Release',           desc: 'CHANGELOG updated, tag created, compliance report filed', next: null             },
};
const PHASE_ORDER = ['inception','architecture','requirements','test_spec','implementation','verification','release'];

function _readPhase(projectDir: string): AEEPhaseInfo {
  // 1. Read key from scaffold.yml
  let key = 'inception';
  const sp = path.join(projectDir, 'scaffold.yml');
  if (fs.existsSync(sp)) {
    try {
      const m = fs.readFileSync(sp, 'utf8').match(/^aee_phase:\s*(\S+)/m);
      if (m && PHASE_CATALOG[m[1]]) { key = m[1]; }
    } catch { /* ignore */ }
  }

  // 2. Quick readiness estimate (count governance files present)
  const checks: Array<() => boolean> = [
    () => fs.existsSync(path.join(projectDir, 'scaffold.yml')),
    () => fs.existsSync(path.join(projectDir, 'AGENTS.md')),
    () => fs.existsSync(path.join(projectDir, 'LEDGER.md')),
    () => fs.existsSync(path.join(projectDir, 'docs', 'ARCHITECTURE.md')),
    () => fs.existsSync(path.join(projectDir, 'REQUIREMENTS.md')) || fs.existsSync(path.join(projectDir, 'docs', 'REQUIREMENTS.md')),
    () => fs.existsSync(path.join(projectDir, 'docs', 'TEST_SPEC.md')),
    () => fs.existsSync(path.join(projectDir, '.specsmith', 'trace-vault.jsonl')),
    () => fs.existsSync(path.join(projectDir, 'CHANGELOG.md')),
  ];
  const passed  = checks.filter((fn) => { try { return fn(); } catch { return false; } }).length;
  const pct     = Math.round((passed / checks.length) * 100);
  const cat     = PHASE_CATALOG[key];

  return { key, emoji: cat.emoji, label: cat.label, desc: cat.desc, pct, ready: pct === 100, next: cat.next };
}

// ── HTML ──────────────────────────────────────────────────────────────────────

function _html(data: ProjectData): string {
  const s     = data.scaffold;
  const activeChannel = data.releaseChannel ?? 'stable';
  const ood   = s.spec_version && data.installedVersion && s.spec_version < data.installedVersion;
  // Only show 'update available' when PyPI version is STRICTLY NEWER than installed
  const upd = data.availableVersion && data.installedVersion
    && _isNewerVersion(data.availableVersion, data.installedVersion);

  const selL = s.languages ?? [], selI = s.integrations ?? [], selP = s.platforms ?? [],
        selF = s.fpga_tools ?? [], selAux = s.auxiliary_disciplines ?? [];

  // Grouped project type options with human-readable labels
  const typeOpts = PROJECT_TYPE_GROUPS.map(g =>
    `<optgroup label="${g.group}">` +
    g.types.map(t =>
      `<option value="${t.value}"${s.type === t.value ? ' selected' : ''}>${t.label}</option>`
    ).join('') + '</optgroup>'
  ).join('');
  const vcsOpts = VCS_PLATFORMS.map(v => `<option${s.vcs_platform === v ? ' selected' : ''}>${v}</option>`).join('');

  const chips = (arr: string[], sel: string[], name: string) =>
    arr.map(x =>
      `<label class="chip${sel.includes(x) ? ' sel' : ''}">` +
      `<input type="checkbox" name="${name}" value="${x}"${sel.includes(x) ? ' checked' : ''}> ${x}</label>`
    ).join('');

  // Auxiliary disciplines — use label from AUXILIARY_DISCIPLINES for display
  const auxChips = AUXILIARY_DISCIPLINES.map(d =>
    `<label class="chip${selAux.includes(d.value) ? ' sel' : ''}">` +
    `<input type="checkbox" name="aux_disc" value="${d.value}"${selAux.includes(d.value) ? ' checked' : ''}> ${d.label}</label>`
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
  .btn-sm{background:rgba(255,255,255,.04);border:1px solid var(--br);color:var(--fg);
          border-radius:3px;padding:3px 10px;cursor:pointer;font-size:11px;opacity:.9}
  .btn-sm:hover{border-color:var(--teal);color:var(--teal);opacity:1;background:rgba(78,201,176,.06)}
  .btn-upd{background:#4ec94e;color:#000;font-weight:700;opacity:1}
  .btn-rel{background:rgba(78,201,176,.18);border:1px solid var(--teal);color:var(--teal);
           border-radius:3px;padding:3px 10px;cursor:pointer;font-size:11px;font-weight:600}
  .btn-rel:hover{background:rgba(78,201,176,.32)}
  .tb{background:rgba(255,255,255,.03);border:1px solid var(--br);border-radius:3px;
      color:var(--fg);padding:2px 8px;cursor:pointer;font-size:10px;opacity:.85}
  .tb:hover{border-color:var(--teal);color:var(--teal);opacity:1;background:rgba(78,201,176,.06)}
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
  .qa-btn{background:rgba(255,255,255,.03);border:1px solid var(--br);border-radius:4px;
          color:var(--fg);padding:4px 7px;cursor:pointer;font-size:11px;text-align:left;opacity:.9}
  .qa-btn:hover{border-color:var(--teal);color:var(--teal);opacity:1;background:rgba(78,201,176,.06)}
  .pb{background:var(--sf);border:1px solid var(--br);border-radius:4px;color:var(--fg);
      padding:5px 9px;cursor:pointer;font-size:12px;text-align:left;display:block;width:100%;margin-bottom:3px}
  .pb:hover{border-color:var(--teal);background:rgba(78,201,176,.06)}
  .warn-banner{background:rgba(206,145,120,.1);border:1px solid var(--amb);border-radius:4px;
               padding:6px 10px;font-size:11px;color:var(--amb);margin-bottom:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .upd-banner{background:rgba(78,201,176,.08);border:1px solid rgba(78,201,176,.4);border-radius:4px;
              padding:6px 10px;font-size:11px;color:var(--teal);margin-bottom:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
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
  /* Phase bar */
  .phase-bar{display:flex;align-items:center;gap:8px;padding:5px 12px;
             background:rgba(78,201,176,.06);border-bottom:1px solid rgba(78,201,176,.18);flex-shrink:0}
  .phase-pill{display:inline-flex;align-items:center;gap:4px;background:rgba(78,201,176,.15);
              border:1px solid var(--teal);border-radius:12px;padding:2px 9px;
              font-size:11px;font-weight:700;color:var(--teal);white-space:nowrap}
  .phase-desc{font-size:10px;color:var(--dim);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .phase-prog{font-size:10px;color:var(--dim);white-space:nowrap}
  .phase-sel{background:none;border:1px solid var(--br);border-radius:3px;color:var(--dim);
             font-size:10px;padding:1px 4px;cursor:pointer}
  .phase-sel:hover{border-color:var(--teal);color:var(--teal)}
</style></head>
<body>
<div class="topbar">
    <span class="title">⚙ Settings</span>
  <div style="display:flex;gap:5px">
    <button class="btn-sm" title="Reload panel" onclick="refresh()">↺ Refresh</button>
    <button class="btn-sm" title="Start agent session" onclick="sendToAgent('Run the session start protocol: sync, load AGENTS.md, check LEDGER.md.')">🤖 Agent</button>
  </div>
</div>
${(() => {
    const p         = data.phase;
    const phaseIdx  = PHASE_ORDER.indexOf(p.key);
    const phaseOpts = PHASE_ORDER.map((k) => {
      const c = PHASE_CATALOG[k];
      return `<option value="${k}"${k === p.key ? ' selected' : ''}>${c.emoji} ${c.label}</option>`;
    }).join('');
    return `<div class="phase-bar">
  <span class="phase-pill">${p.emoji} ${p.label}</span>
  <span class="phase-desc" title="${p.desc}">${p.desc}</span>
  <span class="phase-prog">${p.pct}% ready · step ${phaseIdx + 1}/7</span>
  ${p.next ? `<button class="tb" onclick="phaseNext()" title="Advance to ${p.next}">→ ${p.next}</button>` : ''}
  <select class="phase-sel" onchange="phaseSet(this.value)">${phaseOpts}</select>
</div>`;
  })()}
${ood ? `<div class="warn-banner">⚠ scaffold.yml spec_version <b>${s.spec_version}</b> older than installed <b>${data.installedVersion}</b> — <button class="tb" onclick="runCmd('upgrade')">↑ upgrade spec</button></div>` : ''}
${upd ? `<div class="upd-banner">⬆ specsmith <b>${data.availableVersion}</b> available (installed <b>${data.installedVersion}</b>) — <button class="tb" style="border-color:var(--teal);color:var(--teal)" onclick="sw('updates')">View Update</button></div>` : ''}
<div class="tab-bar">
  <button class="tab active" onclick="sw('project')">📁 Project</button>
  <button class="tab" onclick="sw('tools')">🔧 Tools</button>
  <button class="tab" onclick="sw('files')">📋 Files</button>
  <button class="tab" onclick="sw('updates')">🆙 Updates${upd ? '<span class="badge">NEW</span>' : ''}</button>
  <button class="tab" onclick="sw('actions')">⚡ Actions</button>
  <button class="tab" onclick="sw('execution')">🛡 Execution</button>
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
  <button class="btn-sm" onclick="scanProj()" title="Run specsmith scan to auto-suggest name, type & languages">🔭 Scan Project</button>
  <button class="btn-sm" onclick="runCmd('upgrade')">↑ Upgrade spec</button>
</div>
</div>

<!-- Tools tab -->
<div id="t-tools" class="tab-pane">
<div class="info-box">Record which FPGA/HDL tools your project uses. specsmith uses this for CI/CD adapters, AGENTS.md guidance, and AI tool context rules.</div>
<h3>FPGA / HDL Tools</h3>
<div class="chips">${chips(FPGA_TOOLS, selF, 'fpga_tool')}</div>
<div class="btn-row" style="margin-top:5px;margin-bottom:2px">
  <button class="btn-sm" onclick="detectToolsNow()" title="Scan PATH for installed FPGA/HDL tools and auto-select them">🔍 Detect Installed Tools</button>
</div>
<h3 style="margin-top:14px">🔀 Mixed Disciplines</h3>
<div class="info-box" style="font-size:10px;margin-bottom:5px">For projects that span multiple disciplines (e.g. FPGA + embedded C + Python), select additional types. specsmith generates CI jobs and tool rules for each.</div>
<div class="chips">${auxChips}</div>
<div class="btn-row" style="margin-top:5px;margin-bottom:2px">
  <button class="btn-sm" onclick="suggestDisciplines()" title="Suggest disciplines based on current project type and detected languages">💡 Suggest by Languages</button>
</div>
<h3 title="Platforms this project is built/tested for in CI/CD — not the host OS running VS Code">CI/CD Build Platforms</h3>
<div class="chips">${chips(PLATFORMS, selP, 'platform')}</div>
<h3 style="margin-top:12px">🗂 Installed Ollama Models</h3>
<div id="ollama-mdl-load" class="dim" style="margin:4px 0">Click Refresh to load installed models</div>
<table id="ollama-mdl-table" style="display:none;font-size:11px">
  <thead><tr><td><b>Model</b></td><td class="dim">Size</td><td></td></tr></thead>
  <tbody id="ollama-mdl-body"></tbody>
</table>
<div class="btn-row">
  <button class="btn" onclick="save()">💾 Save</button>
  <button class="btn-sm" onclick="loadOllamaModels()">↺ Refresh Models</button>
  <button class="btn-sm" onclick="ollamaUpdateAll()">⬆ Update All Models</button>
</div>
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
  <span class="ver-lbl">Channel</span>
  <select id="release-ch" onchange="saveReleaseChannel(this.value)" style="width:auto;background:var(--ib);color:var(--if);border:1px solid var(--br);border-radius:3px;padding:2px 5px;font-size:11px;font-family:var(--fn)">
    <option value="stable"${activeChannel === 'stable' ? ' selected' : ''}>stable (recommended)</option>
    <option value="pre-release"${activeChannel === 'pre-release' ? ' selected' : ''}>pre-release (dev builds)</option>
  </select>
</div>
<div class="btn-row">
  <button class="btn" id="chk-btn" onclick="chkVer()">🔍 Check for Updates</button>
  ${upd ? '<button class="btn btn-upd" onclick="installUpd()">⬆ Install Update</button>' : ''}
</div>
<h3 style="margin-top:16px">Ollama</h3>
<div class="ver-grid">
  <span class="ver-lbl">Installed</span><span class="ver-val" id="ollama-ver">—</span>
  <span class="ver-lbl">Available</span><span class="ver-val" id="ollama-latest">—</span>
</div>
<div class="btn-row" style="margin-bottom:12px">
  <button class="btn" id="ollama-chk-btn" onclick="chkOllamaVer()">🔍 Check Ollama</button>
  <button class="btn-sm" onclick="ollamaUpgrade()">⬆ Upgrade Ollama</button>
</div>
<h3 style="margin-top:4px">System Info</h3>
<div id="sys-load" class="dim">Loading…</div>
<div id="sys-grid" class="sys-grid" style="display:none"></div>
<div style="margin-top:8px"><button class="btn-sm" onclick="getSys()">↺ Refresh</button></div>
</div>

<!-- Execution tab -->
${(() => {
  const execProfile = s.execution_profile ?? 'standard';
  const EXEC_PROFILES = [
    { value: 'safe',     label: '🔒 Safe',     desc: 'Read-only. No shell, no file writes. Inspection only.' },
    { value: 'standard',label: '⚙ Standard', desc: 'Default. specsmith, git, build tools. Blocks sudo/rm-rf.' },
    { value: 'open',     label: '🔓 Open',     desc: 'Almost all commands. Only blocks catastrophic disk ops.' },
    { value: 'admin',    label: '⚠ Admin',    desc: 'No restrictions. Use only in trusted/sandbox environments.' },
  ];
  const profileOpts = EXEC_PROFILES.map(p =>
    `<option value="${p.value}"${execProfile === p.value ? ' selected' : ''}>${p.label}</option>`
  ).join('');
  const profileDescs = JSON.stringify(Object.fromEntries(EXEC_PROFILES.map(p => [p.value, p.desc])));
  const joinOrEmpty = (arr?: string[]) => (arr ?? []).join('\n');
  return `<div id="t-execution" class="tab-pane">
<div class="info-box">Controls what the AI agent is allowed to do during agentic sessions.
Profile is stored in <b>scaffold.yml</b> as <code>execution_profile</code>.</div>
<h3>Execution Profile</h3>
<div class="fg">
  <label class="fl">Profile</label>
  <select id="exec-profile" onchange="execProfileChanged()">${profileOpts}</select>
</div>
<div id="exec-profile-desc" class="info-box" style="font-size:11px;margin-top:4px">${EXEC_PROFILES.find(p=>p.value===execProfile)?.desc??''}</div>
<h3>Custom Overrides</h3>
<div class="fg"><label class="fl">Additional allowed command prefixes (one per line or comma-separated)</label>
  <textarea id="exec-allowed" rows="3" style="width:100%;background:var(--ib);color:var(--if);border:1px solid var(--br);border-radius:4px;padding:4px 7px;font-size:11px;font-family:var(--fn);resize:vertical">${joinOrEmpty(s.custom_allowed_commands)}</textarea>
</div>
<div class="fg"><label class="fl">Additional blocked command prefixes (one per line or comma-separated)</label>
  <textarea id="exec-blocked" rows="3" style="width:100%;background:var(--ib);color:var(--if);border:1px solid var(--br);border-radius:4px;padding:4px 7px;font-size:11px;font-family:var(--fn);resize:vertical">${joinOrEmpty(s.custom_blocked_commands)}</textarea>
</div>
<div class="fg"><label class="fl">Blocked agent tools (comma-separated, e.g. run_command,write_file)</label>
  <textarea id="exec-blocked-tools" rows="2" style="width:100%;background:var(--ib);color:var(--if);border:1px solid var(--br);border-radius:4px;padding:4px 7px;font-size:11px;font-family:var(--fn);resize:vertical">${joinOrEmpty(s.custom_blocked_tools)}</textarea>
</div>
<div class="btn-row">
  <button class="btn" onclick="saveExec()">💾 Save</button>
</div>
<h3 style="margin-top:16px">Tool Installer</h3>
<div class="info-box" style="font-size:11px">Scan your project tools and install missing ones. Install commands use your platform's preferred package manager.</div>
<div id="tools-scan-load" class="dim">Click Scan to check installed tools</div>
<table id="tools-scan-table" style="display:none;font-size:11px">
  <thead><tr><td></td><td><b>Tool</b></td><td class="dim">Category</td><td class="dim">Version</td><td></td></tr></thead>
  <tbody id="tools-scan-body"></tbody>
</table>
<div class="btn-row" style="margin-top:8px">
  <button class="btn-sm" onclick="scanToolsNow()">🔍 Scan Tools</button>
  <button class="btn-sm" onclick="runCmd('tools install --list')">📋 All Installable Tools</button>
</div>
<div id="exec-profile-descs" style="display:none">${JSON.stringify(Object.fromEntries(EXEC_PROFILES.map(p=>[p.value,p.desc])))}</div>
</div>`;
})()}

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
  <button class="qa-btn" onclick="runCmd('tools scan --fpga')">🔧 tools scan</button>
  <button class="qa-btn" onclick="runCmd('phase')">🌱 phase status</button>
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
  const tabs=['project','tools','files','updates','actions','execution'];
  document.querySelectorAll('.tab').forEach((t,i)=>t.classList.toggle('active',tabs[i]===id));
  document.querySelectorAll('.tab-pane').forEach(p=>p.classList.toggle('active',p.id==='t-'+id));
  if(id==='updates')getSys();
  if(id==='execution')scanToolsNow();
}
function execProfileChanged(){
  const sel=document.getElementById('exec-profile');
  const descEl=document.getElementById('exec-profile-desc');
  const rawDescs=document.getElementById('exec-profile-descs');
  if(!sel||!descEl||!rawDescs)return;
  try{const descs=JSON.parse(rawDescs.textContent||'{}');descEl.textContent=descs[sel.value]||'';}catch(e){}
}
function saveExec(){
  vscode.postMessage({command:'saveExecution',
    profileName:document.getElementById('exec-profile').value,
    customAllowed:document.getElementById('exec-allowed').value,
    customBlocked:document.getElementById('exec-blocked').value,
    customBlockedTools:document.getElementById('exec-blocked-tools').value,
  });
}
function scanToolsNow(){
  const load=document.getElementById('tools-scan-load');
  const tbl=document.getElementById('tools-scan-table');
  if(load)load.textContent='Scanning…';
  if(load)load.style.display='';
  if(tbl)tbl.style.display='none';
  vscode.postMessage({command:'scanTools'});
}
function installTool(key){vscode.postMessage({command:'toolInstall',toolKey:key});}
function detectToolsNow(){
  vscode.postMessage({command:'detectTools'});
}
function saveReleaseChannel(ch){vscode.postMessage({command:'setReleaseChannel',channel:ch});}
function suggestDisciplines(){
  const type=document.getElementById('type')?.value||'';
  const langs=[...document.querySelectorAll('input[name=language]:checked')].map(e=>e.value);
  vscode.postMessage({command:'detectDisciplines',scaffold:{type:type,languages:langs}});
}
function refresh(){vscode.postMessage({command:'refresh'})}
function runCmd(cmd){vscode.postMessage({command:'runCommand',cmd})}
function sendToAgent(p){vscode.postMessage({command:'sendToAgent',prompt:p})}
function openFile(f){vscode.postMessage({command:'openFile',file:f})}
function addFile(t){vscode.postMessage({command:'addFile',addType:t})}
function detectLang(){vscode.postMessage({command:'detectLanguages'})}
function chkVer(){
  const btn=document.getElementById('chk-btn');
  btn.textContent='⌛ Checking…';btn.disabled=true;
  vscode.postMessage({command:'checkVersion'});
}
function installUpd(){
  const btn=document.querySelector('.btn-upd');
  if(btn){btn.textContent='Installing…';btn.disabled=true;}
  vscode.postMessage({command:'installUpdate'});
}
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
    // integrations not saved from UI (VS Code IS the agent integration)
    platforms:[...document.querySelectorAll('input[name=platform]:checked')].map(e=>e.value),
    fpga_tools:[...document.querySelectorAll('input[name=fpga_tool]:checked')].map(e=>e.value),
    auxiliary_disciplines:[...document.querySelectorAll('input[name=aux_disc]:checked')].map(e=>e.value),
  }});
}
function scanProj(){vscode.postMessage({command:'scanProject'})}
function loadOllamaModels(){
  document.getElementById('ollama-mdl-load').style.display='';
  document.getElementById('ollama-mdl-load').textContent='Loading…';
  document.getElementById('ollama-mdl-table').style.display='none';
  vscode.postMessage({command:'getOllamaModels'});
}
function ollamaUpdateAll(){vscode.postMessage({command:'ollamaUpdateAll'})}
function chkOllamaVer(){
  document.getElementById('ollama-chk-btn').textContent='⌛…';
  vscode.postMessage({command:'checkOllamaVersion'});
}
function ollamaUpgrade(){vscode.postMessage({command:'ollamaUpgrade'})}
function filt(inp,name){
  const q=inp.value.toLowerCase();
  document.querySelectorAll('input[name='+name+']').forEach(cb=>{
    const c=cb.closest('.chip');if(c)c.style.display=(!q||cb.value.toLowerCase().includes(q))?'':'none';
  });
}
function phaseNext(){vscode.postMessage({command:'phaseNext'})}
function phaseSet(key){if(key)vscode.postMessage({command:'phaseSet',phaseKey:key})}
document.querySelectorAll('.chip').forEach(c=>{
  c.addEventListener('click',()=>c.classList.toggle('sel',c.querySelector('input').checked));
});
window.addEventListener('message',({data})=>{
    if(data.type==='versionInfo'){
    const btn=document.getElementById('chk-btn');
    btn.textContent='🔍 Check for Updates';btn.disabled=false;
    if(data.error){document.getElementById('ver-avail').textContent='Error — try again';}
    else if(data.available){
      document.getElementById('ver-avail').textContent=data.available;
      document.getElementById('last-check').textContent=new Date().toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
      // Compare semver: only show Install Update if PyPI version is NEWER than installed
      const instEl=document.querySelector('.ver-val');
      const installed=(instEl&&instEl.textContent&&instEl.textContent!=='\u2014')?instEl.textContent.trim():'';
      function semverGt(a,b){
        const p=s=>s.split('.').map(n=>parseInt(n)||0);
        const av=p(a),bv=p(b);
        for(let i=0;i<3;i++){if((av[i]||0)>(bv[i]||0))return true;if((av[i]||0)<(bv[i]||0))return false;}
        return false;
      }
      if(installed&&semverGt(data.available,installed)){
        const row=btn.closest('.btn-row');
        if(row&&!row.querySelector('.btn-upd')){
          const upd=document.createElement('button');
          upd.className='btn btn-upd';upd.textContent='⬆ Install Update';
          upd.onclick=()=>vscode.postMessage({command:'installUpdate'});
          row.appendChild(upd);
        }
      } else if(installed) {
        // Show 'up to date or newer' message
        const avEl=document.getElementById('ver-avail');
        if(avEl)avEl.textContent=data.available+' ✓ (installed version is current)';
      }
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
  if(data.type==='ollamaModels'){
    const tbody=document.getElementById('ollama-mdl-body');
    const load=document.getElementById('ollama-mdl-load');
    const tbl=document.getElementById('ollama-mdl-table');
    tbody.innerHTML=(data.models||[]).map(m=>{
      const gb=(m.size>0?(m.size/1073741824).toFixed(1)+'GB':'');
      const mod=(m.modified_at||'').slice(0,10);
      return \`<tr><td>\${m.name}</td><td class="dim">\${gb}\${mod?' ['+mod+']':''}</td>
        <td style="display:flex;gap:3px">
          <button class="tb" onclick="vscode.postMessage({command:'ollamaUpdateModel',modelId:'\${m.name}'})">\u2b06 Update</button>
          <button class="tb" style="color:var(--red)" onclick="vscode.postMessage({command:'ollamaRemoveModel',modelId:'\${m.name}'})">\u2717 Remove</button>
        </td></tr>\`;
    }).join('');
    load.style.display='none';
    tbl.style.display=data.models&&data.models.length?'':'none';
    if(!data.models||!data.models.length){load.textContent='No models installed';load.style.display='';}
  }
  if(data.type==='installStarted'){
    // Upgrade terminal opened — swap Install button to Reload
    const row=document.getElementById('chk-btn')?.closest('.btn-row');
    if(row){
      const old=row.querySelector('.btn-upd,button[disabled]');
      if(old)old.remove();
      const rel=document.createElement('button');
      rel.className='btn btn-rel';rel.textContent='↺ Reload Window';
      rel.onclick=()=>vscode.postMessage({command:'reloadWindow'});
      row.appendChild(rel);
    }
  }
  if(data.type==='ollamaVersionInfo'){
    document.getElementById('ollama-chk-btn').textContent='🔍 Check Ollama';
    document.getElementById('ollama-ver').textContent=data.installed||'(not running)';
    document.getElementById('ollama-latest').textContent=data.latest
      ? (data.installed&&data.latest!==data.installed
        ? data.latest+' ← update available'
        : data.latest+' ✓ up to date')
      : '(could not check)';
  }
  if(data.type==='toolsScanResult'){
    const load=document.getElementById('tools-scan-load');
    const tbody=document.getElementById('tools-scan-body');
    const tbl=document.getElementById('tools-scan-table');
    if(!tbody||!tbl||!load)return;
    const tools=data.tools||[];
    if(!tools.length){load.textContent='No tools found — does scaffold.yml exist?';load.style.display='';return;}
    tbody.innerHTML=tools.map(t=>{
      const ok=t.installed;
      const icon=ok?'<span class="ok">\u2713</span>':'<span class="miss">\u2717</span>';
      const ver=t.version?\`<span class="dim">\${t.version}</span>\`:'<span class="dim">—</span>';
      const btn=ok?'':\`<button class="tb" onclick="installTool('\${t.name}')">Install</button>\`;
      return \`<tr><td>\${icon}</td><td>\${t.name}</td><td class="dim">\${t.category}</td><td>\${ver}</td><td>\${btn}</td></tr>\`;
    }).join('');
    load.style.display='none';
    tbl.style.display='';
  }
  if(data.type==='toolsDetected'){
    // Auto-check FPGA tool chips for tools detected on PATH
    const installed=new Set(data.chipValues||[]);
    document.querySelectorAll('input[name=fpga_tool]').forEach(cb=>{
      if(installed.has(cb.value)){
        cb.checked=true;
        cb.closest('.chip')?.classList.add('sel');
      }
    });
    if(data.chipValues?.length){
      const count=data.chipValues.length;
      // Brief flash on the h3 to confirm
      const h3=document.querySelector('#t-tools h3');
      if(h3){const orig=h3.textContent;h3.textContent='\u2713 Detected '+(count)+' tool'+(count!==1?'s':'')+': '+(data.chipValues.join(', '));setTimeout(()=>h3.textContent=orig,4000);}
    }
  }
  if(data.type==='disciplinesSuggested'){
    // Auto-check suggested auxiliary discipline chips
    const suggested=new Set(data.disciplines||[]);
    document.querySelectorAll('input[name=aux_disc]').forEach(cb=>{
      if(suggested.has(cb.value)){
        cb.checked=true;
        cb.closest('.chip')?.classList.add('sel');
      }
    });
  }
  if(data.type==='scanResult'){
    const r=data.result;
    if(r.name)document.getElementById('name').value=r.name;
    if(r.vcs_platform){const v=document.getElementById('vcs');for(const o of v.options)if(o.value===r.vcs_platform)o.selected=true;}
    // Set type: find matching option
    if(r.type){const t=document.getElementById('type');for(const o of t.options)if(o.value===r.type){o.selected=true;break;}}
    // Check language chips
    if(r.languages&&r.languages.length){
      document.querySelectorAll('input[name=language]').forEach(cb=>{
        cb.checked=r.languages.includes(cb.value);
        cb.closest('.chip')?.classList.toggle('sel',cb.checked);
      });
    }
    // Check fpga_tools chips
    if(r.fpga_tools&&r.fpga_tools.length){
      document.querySelectorAll('input[name=fpga_tool]').forEach(cb=>{
        cb.checked=r.fpga_tools.includes(cb.value);
        cb.closest('.chip')?.classList.toggle('sel',cb.checked);
      });
    }
    // Check aux disciplines chips
    if(r.auxiliary_disciplines&&r.auxiliary_disciplines.length){
      document.querySelectorAll('input[name=aux_disc]').forEach(cb=>{
        cb.checked=r.auxiliary_disciplines.includes(cb.value);
        cb.closest('.chip')?.classList.toggle('sel',cb.checked);
      });
    }
  }
});
</script>
</body></html>`;
}
