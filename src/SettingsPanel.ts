// SPDX-License-Identifier: MIT
// Copyright (c) 2026 BitConcepts, LLC. All rights reserved.
/**
 * SettingsPanel — Global (non-project) specsmith settings.
 *
 * Tabs:  Environment | Ollama | System
 *
 * Environment: specsmith venv management + version/update check.
 * Ollama:      installed models table, version check, upgrade.
 * System:      OS / CPU / RAM / GPU / disk info.
 *
 * This panel is independent of any project and can be opened at any time.
 * Project-specific settings live in GovernancePanel ("Project Settings").
 */
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { augmentedEnv, findSpecsmith } from './bridge';
import {
  getGlobalVenvDir, venvExists, getVenvSpecsmith,
  getVenvSpecsmithVersion, buildCreateVenvCommands, buildUpdateVenvCommand, buildDeleteVenvCommands,
} from './VenvManager';

let _panel: vscode.WebviewPanel | undefined;
let _ctx: vscode.ExtensionContext | undefined;

/** Reuse a single terminal for all specsmith operations to avoid terminal sprawl. */
function _getTerminal(_name: string): vscode.Terminal {
  const existing = vscode.window.terminals.find(t => t.name === 'specsmith');
  if (existing) {
    existing.show();
    return existing;
  }
  const term = vscode.window.createTerminal({ name: 'specsmith', shellPath: _shellPath() });
  term.show();
  return term;
}

const _ENV: NodeJS.ProcessEnv = augmentedEnv(process.env);

export function closeSettingsPanel(): void { _panel?.dispose(); }

export function showSettingsPanel(context: vscode.ExtensionContext): void {
  _ctx = context;
  if (_panel) { _panel.reveal(vscode.ViewColumn.Two); _reload(); return; }

  _panel = vscode.window.createWebviewPanel(
    'specsmithSettings',
    '\u2699 Global Settings',
    vscode.ViewColumn.Two,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  _reload();
  // Auto-check for specsmith updates when the panel first opens so the
  // update badge and version info are current without manual action.
  setTimeout(() => { if (_ctx && _panel) { void _checkVersion(_ctx); void _sendApiKeyStatus(); } }, 2000);
  // Auto-check Ollama version + model updates on open (respects setting)
  const autoOllama = vscode.workspace.getConfiguration('specsmith').get<boolean>('checkOllamaOnStart', true);
  if (autoOllama) {
    setTimeout(() => {
      if (_panel) {
        void _checkOllamaVersion();
        void _sendOllamaModels();
      }
    }, 3000);
  }
  _panel.webview.onDidReceiveMessage((msg: Msg) => void _handleMsg(msg), null, context.subscriptions);
  _panel.onDidDispose(() => { _panel = undefined; _ctx = undefined; }, null, context.subscriptions);
}

function _reload(): void {
  if (!_panel || !_ctx) { return; }
  _panel.webview.html = _html(_loadData(_ctx));
}

// ── Data ──────────────────────────────────────────────────────────────────────

interface SettingsData {
  installedVersion: string | null;
  availableVersion: string | null;
  lastUpdateCheck: string | null;
  releaseChannel: string;
  venvVersion: string | null;
  venvActive: boolean;
  apiKeys: Array<{ id: string; label: string; hasKey: boolean }>;
  defaultProvider: string;
  defaultModel: string;
}

function _loadData(context: vscode.ExtensionContext): SettingsData {
  const venvVersion = getVenvSpecsmithVersion();
  let installedVersion: string | null = venvVersion;
  if (!installedVersion) {
    try {
      const exec = vscode.workspace.getConfiguration('specsmith').get<string>('executablePath', 'specsmith');
      const resolved = findSpecsmith(exec, _ENV.PATH ?? '');
      const r = cp.spawnSync(resolved, ['--version'], { timeout: 3000, encoding: 'utf8' });
      if (r.status === 0) {
        const m = (r.stdout ?? '').match(/(\d+\.\d+\.\d+(?:\.dev\d+|a\d+|b\d+|rc\d+)?)/);
        installedVersion = m?.[1] ?? null;
      }
    } catch { /* ignore */ }
  }
  const avail = context.globalState.get<string>('specsmith.availableVersion', '');
  const checkMs = context.globalState.get<number>('specsmith.lastVersionCheck', 0);
  const lastCheck = checkMs ? new Date(checkMs).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;
  const releaseChannel = vscode.workspace.getConfiguration('specsmith').get<string>('releaseChannel', 'stable');
  const defaultProvider = vscode.workspace.getConfiguration('specsmith').get<string>('defaultProvider', 'ollama');
  const defaultModel = vscode.workspace.getConfiguration('specsmith').get<string>('defaultModel', '');
  // API key status is loaded async — start with empty, filled by _sendApiKeyStatus()
  return { installedVersion, availableVersion: avail || null, lastUpdateCheck: lastCheck, releaseChannel, venvVersion, venvActive: venvExists(), apiKeys: [], defaultProvider, defaultModel };
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface Msg {
  command:
    | 'refresh' | 'checkVersion' | 'installUpdate' | 'reloadWindow' | 'setReleaseChannel'
    | 'createVenv' | 'updateVenv' | 'deleteVenv' | 'rebuildVenv'
    | 'removeOtherInstalls'
    | 'getSysInfo' | 'getOllamaModels'
    | 'ollamaRemoveModel' | 'ollamaUpdateModel' | 'ollamaUpdateAll'
    | 'checkOllamaVersion' | 'ollamaUpgrade'
    | 'setApiKey' | 'verifyApiKey' | 'getApiKeyStatus' | 'setDefaultProvider'
    | 'getGpuInfo' | 'setOllamaCtx' | 'setDefaultOllamaModel';
  channel?: string;
  modelId?: string;
  provider?: string;
  value?: string;
}

// ── Message handler ────────────────────────────────────────────────────────────

async function _handleMsg(msg: Msg): Promise<void> {
  if (!_ctx) { return; }

  switch (msg.command) {
    case 'refresh': _reload(); break;

    case 'checkVersion': await _checkVersion(_ctx); break;

    case 'installUpdate': {
      const ch = vscode.workspace.getConfiguration('specsmith').get<string>('releaseChannel', 'stable') as 'stable' | 'pre-release';
      const term = _getTerminal("specsmith");
      term.sendText(buildUpdateVenvCommand(ch));
      term.show();
      _panel?.webview.postMessage({ type: 'showRestartBanner', message: '\u2713 Updating specsmith\u2026 Restart VS Code when terminal finishes.', needsRestart: true });
      break;
    }

    case 'reloadWindow':
      void vscode.commands.executeCommand('workbench.action.reloadWindow');
      break;

    case 'setReleaseChannel': {
      if (!msg.channel) { break; }
      void vscode.workspace.getConfiguration('specsmith').update('releaseChannel', msg.channel, vscode.ConfigurationTarget.Global);
      void _checkVersion(_ctx);
      break;
    }

    case 'createVenv': {
      const ch = vscode.workspace.getConfiguration('specsmith').get<string>('releaseChannel', 'stable') as 'stable' | 'pre-release';
      const { ApiKeyManager } = await import('./ApiKeyManager');
      const provPkg: Record<string, string> = { anthropic: 'anthropic', openai: 'openai', gemini: 'google-generativeai', mistral: 'mistralai' };
      const providers: string[] = [];
      for (const [p, pkg] of Object.entries(provPkg)) {
        if (await ApiKeyManager.getKey(_ctx.secrets, p)) { providers.push(pkg); }
      }
      const cmds = buildCreateVenvCommands(ch, providers);
      const term = _getTerminal("specsmith");
      term.sendText(cmds.join('; '));
      term.show();
      // Show persistent restart banner in the panel instead of a transient popup
      _panel?.webview.postMessage({ type: 'showRestartBanner', message: '\u2713 Creating environment\u2026 Restart VS Code when terminal finishes.', needsRestart: true });
      break;
    }

    case 'updateVenv': {
      const ch2 = vscode.workspace.getConfiguration('specsmith').get<string>('releaseChannel', 'stable') as 'stable' | 'pre-release';
      const term2 = _getTerminal("specsmith");
      term2.sendText(buildUpdateVenvCommand(ch2));
      term2.show();
      _panel?.webview.postMessage({ type: 'showRestartBanner', message: '\u2713 Updating specsmith\u2026 Restart VS Code when terminal finishes.', needsRestart: true });
      break;
    }

    case 'deleteVenv': {
      const confirm = await vscode.window.showWarningMessage(
        'Delete the global specsmith environment (~/.specsmith/venv)?  This will break all sessions until recreated.',
        { modal: true }, 'Delete',
      );
      if (confirm !== 'Delete') { break; }
      const delTerm = _getTerminal("specsmith");
      delTerm.sendText(buildDeleteVenvCommands().join('; '));
      delTerm.show();
      _panel?.webview.postMessage({ type: 'showRestartBanner', message: '\u26a0 Environment deleted. Restart VS Code to apply.', needsRestart: true });
      break;
    }

    case 'rebuildVenv': {
      const confirmRb = await vscode.window.showWarningMessage(
        'Rebuild the global specsmith environment?  This deletes ~/.specsmith/venv and reinstalls from scratch.',
        { modal: true }, 'Rebuild',
      );
      if (confirmRb !== 'Rebuild') { break; }
      const chRb = vscode.workspace.getConfiguration('specsmith').get<string>('releaseChannel', 'stable') as 'stable' | 'pre-release';
      const { ApiKeyManager: AKM } = await import('./ApiKeyManager');
      const provPkgRb: Record<string, string> = { anthropic: 'anthropic', openai: 'openai', gemini: 'google-generativeai', mistral: 'mistralai' };
      const providersRb: string[] = [];
      for (const [p, pkg] of Object.entries(provPkgRb)) {
        if (await AKM.getKey(_ctx.secrets, p)) { providersRb.push(pkg); }
      }
      const rbTerm = _getTerminal("specsmith");
      rbTerm.sendText([...buildDeleteVenvCommands(), ...buildCreateVenvCommands(chRb, providersRb)].join('; '));
      rbTerm.show();
      _panel?.webview.postMessage({ type: 'showRestartBanner', message: '\u2713 Rebuilding environment\u2026 Restart VS Code when terminal finishes.', needsRestart: true });
      break;
    }

    case 'removeOtherInstalls': {
      const confirmRm = await vscode.window.showWarningMessage(
        'Remove all system-wide specsmith installs (pipx + pip) except the environment at ~/.specsmith/venv?\n\nThis runs: pipx uninstall specsmith; python -m pip uninstall -y specsmith',
        { modal: true }, 'Remove System Installs',
      );
      if (confirmRm !== 'Remove System Installs') { break; }
      const cleanCmd = process.platform === 'win32'
        ? [
            "Write-Host 'Removing specsmith from pipx...';",
            'pipx uninstall specsmith 2>&1 | Out-Null;',
            "Write-Host 'Removing specsmith from pip (user/system)...';",
            'python -m pip uninstall -y specsmith 2>&1 | Out-Null;',
            `Write-Host 'Done. Only the venv at ${getGlobalVenvDir()} is preserved.'`,
          ].join(' ')
        : [
            "echo 'Removing specsmith from pipx...'",
            'pipx uninstall specsmith 2>/dev/null',
            "echo 'Removing specsmith from pip...'",
            'python3 -m pip uninstall -y specsmith 2>/dev/null',
            `echo 'Done. Only the venv at ${getGlobalVenvDir()} is preserved.'`,
          ].join('; ');
      const rmTerm = _getTerminal("specsmith");
      rmTerm.sendText(cleanCmd);
      rmTerm.show();
      _panel?.webview.postMessage({ type: 'showRestartBanner', message: '\u2713 System installs removed. No restart needed.', needsRestart: false });
      break;
    }

    case 'getSysInfo': void _sendSysInfo(); break;
    case 'getOllamaModels': void _sendOllamaModels(); break;
    case 'checkOllamaVersion': void _checkOllamaVersion(); break;

    case 'getGpuInfo': {
      void (async () => {
        const { OllamaManager } = await import('./OllamaManager');
        const vram = await OllamaManager.getVramGb();
        let rec = '4K';
        if (vram >= 16) { rec = '32K'; }
        else if (vram >= 8) { rec = '16K'; }
        else if (vram >= 4) { rec = '8K'; }
        const cur = vscode.workspace.getConfiguration('specsmith').get<number>('ollamaContextLength', 0);
        _panel?.webview.postMessage({ type: 'gpuInfo', vram: vram.toFixed(1), rec, currentCtx: cur });
      })();
      break;
    }

    case 'setDefaultOllamaModel': {
      const mdl = msg.value ?? '';
      void vscode.workspace.getConfiguration('specsmith').update('defaultModel', mdl, vscode.ConfigurationTarget.Global);
      break;
    }

    case 'setOllamaCtx': {
      const val = parseInt(msg.value ?? '0', 10);
      void vscode.workspace.getConfiguration('specsmith').update('ollamaContextLength', val, vscode.ConfigurationTarget.Global);
      break;
    }

    case 'setApiKey': {
      if (!msg.provider) { break; }
      const { ApiKeyManager } = await import('./ApiKeyManager');
      const def = (['anthropic', 'openai', 'gemini', 'mistral'] as const).find(p => p === msg.provider);
      if (!def) { break; }
      const labels: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Google Gemini', mistral: 'Mistral AI' };
      const envVars: Record<string, string> = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GOOGLE_API_KEY', mistral: 'MISTRAL_API_KEY' };
      const existing = await ApiKeyManager.getKey(_ctx.secrets, def);
      const value = await vscode.window.showInputBox({
        title: `specsmith — ${labels[def]} API Key`,
        prompt: `Enter your ${envVars[def]}. Stored in OS credential store.`,
        value: existing ?? '', password: true, ignoreFocusOut: true,
      });
      if (value === undefined) { break; }
      if (value === '') {
        await _ctx.secrets.delete(`specsmith.key.${def}`);
      } else {
        await ApiKeyManager.setKey(_ctx.secrets, def, value);
      }
      void _sendApiKeyStatus();
      break;
    }

    case 'verifyApiKey': {
      if (!msg.provider) { break; }
      const { ApiKeyManager: AKM2 } = await import('./ApiKeyManager');
      const key2 = await AKM2.getKey(_ctx.secrets, msg.provider);
      if (!key2) {
        _panel?.webview.postMessage({ type: 'apiKeyVerified', provider: msg.provider, ok: false, error: 'No key set' });
        break;
      }
      try {
        const { fetchModels } = await import('./ModelRegistry');
        const models = await fetchModels(msg.provider, key2);
        _panel?.webview.postMessage({ type: 'apiKeyVerified', provider: msg.provider, ok: true, models: models.length });
      } catch (err) {
        _panel?.webview.postMessage({ type: 'apiKeyVerified', provider: msg.provider, ok: false, error: String(err) });
      }
      break;
    }

    case 'getApiKeyStatus': void _sendApiKeyStatus(); break;

    case 'setDefaultProvider': {
      if (!msg.provider) { break; }
      void vscode.workspace.getConfiguration('specsmith').update('defaultProvider', msg.provider, vscode.ConfigurationTarget.Global);
      break;
    }

    case 'ollamaRemoveModel': {
      if (!msg.modelId) { break; }
      const term3 = _getTerminal("specsmith");
      term3.sendText(`ollama rm "${msg.modelId}"`);
      term3.show();
      _panel?.webview.postMessage({ type: 'showRestartBanner', message: `\u2713 Removing ${msg.modelId}\u2026 No restart needed.`, needsRestart: false });
      break;
    }

    case 'ollamaUpdateModel': {
      if (!msg.modelId) { break; }
      const term4 = _getTerminal("specsmith");
      term4.sendText(`ollama pull "${msg.modelId}"`);
      term4.show();
      _panel?.webview.postMessage({ type: 'showRestartBanner', message: `\u2713 Updating ${msg.modelId}\u2026 No restart needed.`, needsRestart: false });
      break;
    }

    case 'ollamaUpdateAll': {
      const { OllamaManager } = await import('./OllamaManager');
      const ids = await OllamaManager.getInstalledIds();
      if (!ids.length) { void vscode.window.showInformationMessage('No Ollama models installed.'); break; }
      const term5 = _getTerminal("specsmith");
      term5.sendText(ids.map((m) => `ollama pull "${m}"`).join('; '));
      term5.show();
      break;
    }

    case 'ollamaUpgrade': {
      let upgradeCmd: string;
      if (process.platform === 'win32') {
        upgradeCmd = [
          'winget upgrade --id Ollama.Ollama',
          "if ($LASTEXITCODE -ne 0) {",
          "  Write-Host 'winget has no Ollama update yet — package may lag GitHub releases.';",
          "  Write-Host 'Opening https://ollama.ai/download in your browser...';",
          "  Start-Process 'https://ollama.ai/download'",
          '}',
        ].join(' ; ');
      } else if (process.platform === 'darwin') {
        upgradeCmd = 'brew upgrade ollama';
      } else {
        upgradeCmd = 'curl -fsSL https://ollama.ai/install.sh | sh';
      }
      const term6 = _getTerminal("specsmith");
      term6.sendText(upgradeCmd);
      term6.show();
      break;
    }
  }
}

// ── Version check ─────────────────────────────────────────────────────────────

function _parseVer(v: string): [number, number, number, number] {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:\.dev(\d+)|a(\d+)|b(\d+)|rc(\d+))?/);
  if (!m) { return [0, 0, 0, 0]; }
  let pre = 999999;
  if (m[4] !== undefined)      { pre = parseInt(m[4], 10); }
  else if (m[5] !== undefined) { pre = 10000 + parseInt(m[5], 10); }
  else if (m[6] !== undefined) { pre = 20000 + parseInt(m[6], 10); }
  else if (m[7] !== undefined) { pre = 30000 + parseInt(m[7], 10); }
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10), pre];
}

function _cmpVer(a: string, b: string): number {
  const av = _parseVer(a), bv = _parseVer(b);
  for (let i = 0; i < 4; i++) { const d = av[i] - bv[i]; if (d !== 0) { return d; } }
  return 0;
}

async function _checkVersion(context: vscode.ExtensionContext): Promise<void> {
  const channel = vscode.workspace.getConfiguration('specsmith').get<string>('releaseChannel', 'stable');
  await context.globalState.update('specsmith.lastVersionCheck', Date.now());
  try {
    const httpsM = await import('https');
    const raw = await new Promise<string>((resolve, reject) => {
      const req = httpsM.get('https://pypi.org/pypi/specsmith/json', { timeout: 8000 }, (r) => {
        let d = ''; r.on('data', (c: Buffer) => { d += c; }); r.on('end', () => resolve(d));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
    const pypiData = JSON.parse(raw) as { info?: { version?: string }; releases?: Record<string, Array<{ yanked?: boolean }>> };
    let latest: string;
    if (channel === 'pre-release') {
      const candidates = Object.entries(pypiData.releases ?? {})
        .filter(([, files]) => files.length > 0 && !files.every(f => f.yanked))
        .map(([v]) => v);
      candidates.sort(_cmpVer);
      latest = candidates[candidates.length - 1] ?? pypiData.info?.version ?? '';
    } else {
      latest = pypiData.info?.version ?? '';
    }
    await context.globalState.update('specsmith.availableVersion', latest);
    _panel?.webview.postMessage({ type: 'versionInfo', available: latest });
  } catch (err) {
    _panel?.webview.postMessage({ type: 'versionInfo', error: String(err) });
  }
}

// ── System info ───────────────────────────────────────────────────────────────

async function _sendSysInfo(): Promise<void> {
  if (!_panel) { return; }
  const GB = 1073741824;
  const info: Record<string, string> = {
    os:    `${os.type()} ${os.release()} (${os.arch()})`,
    cpu:   os.cpus()[0]?.model ?? 'Unknown',
    cores: String(os.cpus().length),
    ram:   `${(os.totalmem() / GB).toFixed(1)} GB total, ${(os.freemem() / GB).toFixed(1)} GB free`,
  };
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
  try {
    if (process.platform === 'win32') {
      const r = cp.spawnSync('wmic', ['logicaldisk', 'get', 'caption,freespace,size', '/format:csv'], { timeout: 4000, encoding: 'utf8' });
      if (r.status === 0) {
        info.disk = r.stdout.trim().split('\n').slice(1)
          .filter(l => l.trim() && !l.startsWith('Node'))
          .map(row => { const [, caption, free, size] = row.split(','); if (!caption || !size) { return ''; } return `${caption.trim()} ${(Number(free) / GB).toFixed(1)}/${(Number(size) / GB).toFixed(1)} GB`; })
          .filter(Boolean).join('  ') || 'N/A';
      }
    } else {
      const r = cp.spawnSync('df', ['-h', '-P', '/'], { timeout: 3000, encoding: 'utf8' });
      if (r.status === 0) { const p = r.stdout.split('\n')[1]?.split(/\s+/) ?? []; if (p[3]) { info.disk = `${p[0]}: ${p[3]} free / ${p[1]}`; } }
    }
  } catch { /* ignore */ }
  if (!info.disk) { info.disk = 'N/A'; }
  _panel.webview.postMessage({ type: 'sysInfo', info });
}

// ── Ollama ────────────────────────────────────────────────────────────────────

async function _sendOllamaModels(): Promise<void> {
  if (!_panel) { return; }
  try {
    const http = await import('http');
    const models = await new Promise<Array<{ name: string; size: number; modified_at: string }>>((resolve) => {
      let data = '';
      http.get('http://localhost:11434/api/tags', (r) => {
        r.on('data', (c: Buffer) => { data += c.toString(); });
        r.on('end', () => { try { const j = JSON.parse(data) as { models?: Array<{ name: string; size: number; modified_at: string }> }; resolve(j.models ?? []); } catch { resolve([]); } });
      }).on('error', () => resolve([]));
    });
    _panel.webview.postMessage({ type: 'ollamaModels', models });
  } catch {
    _panel.webview.postMessage({ type: 'ollamaModels', models: [] });
  }
}

async function _checkOllamaVersion(): Promise<void> {
  if (!_panel) { return; }
  let installed: string | null = null;
  try {
    const http = await import('http');
    installed = await new Promise<string | null>((resolve) => {
      let d = '';
      http.get('http://localhost:11434/api/version', (r) => {
        r.on('data', (c: Buffer) => { d += c.toString(); });
        r.on('end', () => { try { resolve((JSON.parse(d) as { version?: string }).version ?? null); } catch { resolve(null); } });
      }).on('error', () => resolve(null));
    });
  } catch { /* ignore */ }
  let latest: string | null = null;
  try {
    const httpsM = await import('https');
    latest = await new Promise<string | null>((resolve, reject) => {
      const req = httpsM.get(
        'https://api.github.com/repos/ollama/ollama/releases/latest',
        { headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'specsmith-vscode' } },
        (r) => { let d = ''; r.on('data', (c: Buffer) => { d += c; }); r.on('end', () => { try { const tag = (JSON.parse(d) as { tag_name?: string }).tag_name ?? ''; resolve(tag.replace(/^v/, '') || null); } catch { resolve(null); } }); },
      );
      req.on('error', reject);
    });
  } catch { /* ignore */ }
  _panel.webview.postMessage({ type: 'ollamaVersionInfo', installed, latest });
}

// ── API key status ──────────────────────────────────────────────────────────────────

async function _sendApiKeyStatus(): Promise<void> {
  if (!_panel || !_ctx) { return; }
  const { ApiKeyManager, PROVIDERS } = await import('./ApiKeyManager');
  const keys: Array<{ id: string; label: string; hasKey: boolean }> = [];
  for (const p of PROVIDERS) {
    const k = await ApiKeyManager.getKey(_ctx.secrets, p.id);
    keys.push({ id: p.id, label: p.label, hasKey: !!k });
  }
  _panel.webview.postMessage({ type: 'apiKeyStatus', keys });
}

// ── Shell path helper ─────────────────────────────────────────────────────────────────

function _shellPath(): string | undefined {
  if (process.platform === 'win32') { return 'powershell.exe'; }
  return process.env.SHELL;
}

// ── HTML ──────────────────────────────────────────────────────────────────────

function _html(data: SettingsData): string {
  const INST_VER = JSON.stringify(data.installedVersion ?? '');
  const activeChannel = data.releaseChannel ?? 'stable';
  const upd = data.availableVersion && data.installedVersion
    && _cmpVer(data.availableVersion, data.installedVersion) > 0;
  const venvPath = getGlobalVenvDir();

  return /* html */`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>Global Settings</title>
<style>
  :root{--bg:var(--vscode-editor-background);--fg:var(--vscode-editor-foreground);
    --sf:var(--vscode-panel-background,#1e1e2e);--br:var(--vscode-panel-border,#313244);
    --ib:var(--vscode-input-background);--if:var(--vscode-input-foreground);
    --bb:var(--vscode-button-background);--bf:var(--vscode-button-foreground);
    --teal:#4ec9b0;--red:#f44747;--grn:#4ec94e;--amb:#ce9178;
    --dim:var(--vscode-descriptionForeground,#9d9d9d);
    --fn:var(--vscode-font-family,'Segoe UI',system-ui,sans-serif);}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--fg);font-family:var(--fn);font-size:13px;display:flex;flex-direction:column;height:100vh;overflow:hidden}
  .topbar{display:flex;align-items:center;justify-content:space-between;padding:7px 12px;background:var(--sf);border-bottom:1px solid var(--br);flex-shrink:0}
  .title{font-size:13px;color:var(--teal);font-weight:700}
  .tab-bar{display:flex;background:var(--sf);border-bottom:2px solid var(--br);flex-shrink:0}
  .tab{background:none;border:none;border-bottom:2px solid transparent;margin-bottom:-2px;padding:6px 14px;cursor:pointer;color:var(--dim);font-size:11px;font-family:var(--fn)}
  .tab:hover:not(.active){color:var(--fg)}
  .tab.active{border-bottom-color:var(--teal);color:var(--teal);font-weight:600}
  .scroll{flex:1;overflow-y:auto;padding:12px 14px}
  .tab-pane{display:none}.tab-pane.active{display:block}
  h3{color:var(--teal);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin:14px 0 5px;border-bottom:1px solid var(--br);padding-bottom:3px}
  h3:first-child{margin-top:0}
  .btn{background:var(--bb);color:var(--bf);border:none;border-radius:4px;padding:5px 12px;cursor:pointer;font-size:12px;font-weight:600}
  .btn:hover{opacity:.85}
  .btn-sm{background:rgba(255,255,255,.04);border:1px solid var(--br);color:var(--fg);border-radius:3px;padding:3px 10px;cursor:pointer;font-size:11px;opacity:.9}
  .btn-sm:hover{border-color:var(--teal);color:var(--teal);opacity:1;background:rgba(78,201,176,.06)}
  .btn-upd{background:#4ec94e;color:#000;font-weight:700}
  .btn-rel{background:rgba(78,201,176,.18);border:1px solid var(--teal);color:var(--teal);border-radius:3px;padding:3px 10px;cursor:pointer;font-size:11px;font-weight:600}
  .btn-rel:hover{background:rgba(78,201,176,.32)}
  .tb{background:rgba(255,255,255,.03);border:1px solid var(--br);border-radius:3px;color:var(--fg);padding:2px 8px;cursor:pointer;font-size:10px;opacity:.85}
  .tb:hover{border-color:var(--teal);color:var(--teal);opacity:1}
  .tb-red{color:var(--red)!important;border-color:var(--red)!important;background:rgba(244,71,71,.08)!important}
  .ver-grid{display:grid;grid-template-columns:100px 1fr;gap:4px 8px;font-size:12px;margin-bottom:10px}
  .ver-lbl{color:var(--dim)}.ver-val{font-weight:600;color:var(--fg)}
  .sys-grid{display:grid;grid-template-columns:80px 1fr;gap:3px 8px;font-size:11px;margin-top:6px}
  .sys-lbl{color:var(--dim)}.sys-val{color:var(--fg);font-family:var(--vscode-editor-font-family,'Cascadia Code',monospace)}
  .badge{display:inline-block;background:rgba(78,201,176,.2);color:var(--teal);border-radius:10px;padding:1px 7px;font-size:9px;font-weight:700;margin-left:4px}
  .info-box{background:rgba(78,201,176,.06);border:1px solid rgba(78,201,176,.25);border-radius:4px;padding:7px 10px;font-size:11px;color:var(--teal);margin-bottom:8px}
  .warn-box{background:rgba(244,71,71,.08);border:1px solid rgba(244,71,71,.3);border-radius:4px;padding:7px 10px;font-size:11px;color:var(--red);margin-bottom:8px}
  .btn-row{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;margin-bottom:14px}
  table{width:100%;border-collapse:collapse;font-size:12px}
  td{padding:3px 7px;border-bottom:1px solid var(--br)}
  .dim{color:var(--dim);font-size:11px}
  select{background:var(--ib);color:var(--if);border:1px solid var(--br);border-radius:3px;padding:2px 5px;font-size:11px;font-family:var(--fn)}
  /* Persistent restart banner */
  #restart-banner{display:none;align-items:center;justify-content:space-between;gap:10px;
    padding:8px 12px;background:rgba(78,201,176,.12);border-bottom:2px solid var(--teal);
    font-size:11px;color:var(--teal);flex-shrink:0;flex-wrap:wrap}
  #restart-banner.show{display:flex}
  #restart-banner button{background:var(--teal);color:#000;border:none;border-radius:3px;
    padding:3px 9px;cursor:pointer;font-size:11px;font-weight:700;white-space:nowrap}
  #restart-banner .dismiss{background:none;border:1px solid var(--br);color:var(--dim);font-weight:400}
  #restart-banner .dismiss:hover{border-color:var(--teal);color:var(--teal)}
</style></head>
<body>
<div class="topbar">
  <span class="title">\u2699 Global Settings</span>
  <button class="btn-sm" onclick="refresh()">&#x21BA; Refresh</button>
</div>
<!-- Persistent restart banner — shown after env operations instead of a dismissible popup -->
<div id="restart-banner">
  <span id="restart-msg">✓ Operation complete. Restart VS Code to apply changes.</span>
  <div style="display:flex;gap:6px">
    <button id="restart-btn" onclick="vscode.postMessage({command:'reloadWindow'})">\u21BA Restart VS Code</button>
    <button class="dismiss" onclick="document.getElementById('restart-banner').classList.remove('show')">Dismiss</button>
  </div>
</div>
<div class="tab-bar">
  <button class="tab active" onclick="sw('env')">&#x1f527; Environment</button>
  <button class="tab" onclick="sw('ollama')">&#x1f916; Ollama</button>
  <button class="tab" onclick="sw('system')">&#x1f4bb; System</button>
</div>
<div class="scroll">

<!-- Environment tab -->
<div id="t-env" class="tab-pane active">
<h3>specsmith Environment</h3>
<div class="${data.venvActive ? 'info-box' : 'warn-box'}" style="font-size:11px">
  ${data.venvActive
    ? '\u2713 Active &mdash; all sessions and terminal commands use this environment.'
    : '\u2717 Not installed &mdash; create the environment to enable agent sessions. Nothing will work until it is ready.'}
</div>
<div class="ver-grid">
  <span class="ver-lbl">Status</span>
  <span class="ver-val" style="color:${data.venvActive ? 'var(--grn)' : 'var(--red)'}">${data.venvActive ? '\u2713 Active' : '\u2717 Not installed'}</span>
  ${data.venvVersion ? `<span class="ver-lbl">Version</span><span class="ver-val">${data.venvVersion}</span>` : ''}
  <span class="ver-lbl">Location</span><span class="dim" title="${venvPath}">${venvPath.replace(/\\/g, '/')}</span>
</div>
<div class="btn-row">
  ${data.venvActive
    ? `<button class="btn-sm" onclick="rebuildVenv()" title="Delete and recreate from scratch">\uD83D\uDD04 Rebuild</button>
       <button class="btn-sm tb-red" onclick="deleteVenv()" title="Delete environment">\uD83D\uDDD1 Delete</button>
       <button class="btn-sm" style="margin-left:8px;border-color:var(--amb);color:var(--amb)" onclick="removeOtherInstalls()" title="Remove specsmith from pipx/pip, keeping only this environment">\uD83E\uDDF9 Remove System Installs</button>`
    : `<button class="btn btn-upd" onclick="createVenv()">\uD83D\uDD12 Create Environment</button>`
  }
</div>

<h3>specsmith Version</h3>
<div class="ver-grid">
  <span class="ver-lbl">Installed</span><span class="ver-val" id="ver-installed">${data.installedVersion ?? '&mdash;'}</span>
  <span class="ver-lbl">Available</span><span class="ver-val" id="ver-avail">${data.availableVersion ?? '(not checked)'}</span>
  <span class="ver-lbl">Last check</span><span class="dim" id="last-check">${data.lastUpdateCheck ?? 'never'}</span>
  <span class="ver-lbl">Channel</span>
  <select id="release-ch" onchange="saveChannel(this.value)">
    <option value="stable"${activeChannel === 'stable' ? ' selected' : ''}>stable (recommended)</option>
    <option value="pre-release"${activeChannel === 'pre-release' ? ' selected' : ''}>pre-release (dev builds)</option>
  </select>
</div>
<div class="btn-row">
  <button class="btn" id="chk-btn" onclick="chkVer()">&#x1f50d; Check for Updates</button>
  ${upd ? '<button class="btn btn-upd" onclick="installUpd()">\u2b06 Install Update</button>' : ''}
  ${data.venvActive && !upd ? '<button class="btn-sm" onclick="updateVenv()">\u2b06 Update to Latest</button>' : ''}
</div>
<h3>\uD83D\uDD11 API Keys</h3>
<div class="info-box" style="font-size:10px">Keys are stored in your OS credential store (Windows Credential Manager / macOS Keychain). Never written to settings.json.</div>
<table id="api-key-table" style="font-size:11px">
  <thead><tr><td><b>Provider</b></td><td>Status</td><td></td></tr></thead>
  <tbody id="api-key-body">
    <tr><td colspan="3" class="dim">Loading\u2026</td></tr>
  </tbody>
</table>
<div class="ver-grid" style="margin-top:8px">
  <span class="ver-lbl">Default</span>
  <select id="def-prov" onchange="vscode.postMessage({command:'setDefaultProvider',provider:this.value})">
    <option value="ollama"${data.defaultProvider === 'ollama' ? ' selected' : ''}>Ollama (local — no key needed)</option>
    <option value="anthropic"${data.defaultProvider === 'anthropic' ? ' selected' : ''}>Anthropic (Claude)</option>
    <option value="openai"${data.defaultProvider === 'openai' ? ' selected' : ''}>OpenAI (GPT)</option>
    <option value="gemini"${data.defaultProvider === 'gemini' ? ' selected' : ''}>Google Gemini</option>
    <option value="mistral"${data.defaultProvider === 'mistral' ? ' selected' : ''}>Mistral AI</option>
  </select>
</div>
</div>

<!-- Ollama tab -->
<div id="t-ollama" class="tab-pane">
<h3>Ollama Version</h3>
<div class="ver-grid">
  <span class="ver-lbl">Installed</span><span class="ver-val" id="ollama-ver">&mdash;</span>
  <span class="ver-lbl">Available</span><span class="ver-val" id="ollama-latest">&mdash;</span>
</div>
<div class="btn-row">
  <button class="btn" id="ollama-chk-btn" onclick="chkOllama()">&#x1f50d; Check Ollama</button>
  <button class="btn-sm" onclick="ollamaUpgrade()">\u2b06 Upgrade Ollama</button>
</div>
<h3>Installed Models</h3>
<div id="ollama-mdl-load" class="dim" style="margin:4px 0">Checking models\u2026</div>
<table id="ollama-mdl-table" style="display:none;font-size:11px">
  <thead><tr><td><b>Model</b></td><td class="dim">Size</td><td class="dim">Digest</td><td class="dim">Last pulled</td><td></td></tr></thead>
  <tbody id="ollama-mdl-body"></tbody>
</table>
<div class="btn-row">
  <button class="btn-sm" onclick="loadModels()">&#x21BA; Refresh Models</button>
  <button class="btn-sm" onclick="vscode.postMessage({command:'ollamaUpdateAll'})">\u2b06 Update All</button>
</div>
<h3>Default Model</h3>
<div class="info-box" style="font-size:10px">Select which Ollama model to use by default for new sessions. Auto-selects the only model if just one is installed.</div>
<div class="ver-grid">
  <span class="ver-lbl">Model</span>
  <select id="ollama-def-model" data-saved="${data.defaultModel}" onchange="vscode.postMessage({command:'setDefaultOllamaModel',value:this.value})">
    <option value="">(auto — first installed)</option>
  </select>
</div>
<h3>Context Window</h3>
<div class="info-box" style="font-size:10px">Controls how much text the model can process per turn. Auto uses GPU VRAM to select the best size. Larger windows use more VRAM.</div>
<div class="ver-grid">
  <span class="ver-lbl">Size</span>
  <select id="ollama-ctx" onchange="vscode.postMessage({command:'setOllamaCtx',value:this.value})">
    <option value="0">Auto (detect from GPU)</option>
    <option value="4096">4K tokens</option>
    <option value="8192">8K tokens</option>
    <option value="16384">16K tokens</option>
    <option value="32768">32K tokens</option>
    <option value="65536">64K tokens</option>
    <option value="131072">128K tokens</option>
  </select>
  <span class="ver-lbl">Detected GPU</span>
  <span class="ver-val" id="ollama-gpu">checking\u2026</span>
  <span class="ver-lbl">Recommended</span>
  <span class="ver-val" id="ollama-rec">\u2014</span>
</div>
</div>

<!-- System tab -->
<div id="t-system" class="tab-pane">
<h3>System Info</h3>
<div id="sys-load" class="dim">Loading&hellip;</div>
<div id="sys-grid" class="sys-grid" style="display:none"></div>
<div style="margin-top:8px"><button class="btn-sm" onclick="getSys()">&#x21BA; Refresh</button></div>
</div>

</div><!-- scroll -->
<script>
const vscode=acquireVsCodeApi();
const INST_VER=${INST_VER};
function sw(id){
  ['env','ollama','system'].forEach((t,i)=>{
    document.querySelectorAll('.tab')[i].classList.toggle('active',t===id);
    document.getElementById('t-'+t).classList.toggle('active',t===id);
  });
  if(id==='ollama'){loadModels();vscode.postMessage({command:'getGpuInfo'});}
  if(id==='system')getSys();
}
function refresh(){vscode.postMessage({command:'refresh'})}
function createVenv(){vscode.postMessage({command:'createVenv'})}
function updateVenv(){vscode.postMessage({command:'updateVenv'})}
function deleteVenv(){vscode.postMessage({command:'deleteVenv'})}
function rebuildVenv(){vscode.postMessage({command:'rebuildVenv'})}
function removeOtherInstalls(){vscode.postMessage({command:'removeOtherInstalls'})}
function saveChannel(ch){vscode.postMessage({command:'setReleaseChannel',channel:ch})}
function chkVer(){
  const btn=document.getElementById('chk-btn');
  btn.textContent='\u23f3 Checking\u2026';btn.disabled=true;
  vscode.postMessage({command:'checkVersion'});
}
function installUpd(){
  const btn=document.querySelector('.btn-upd');
  if(btn){btn.textContent='Installing\u2026';btn.disabled=true;}
  vscode.postMessage({command:'installUpdate'});
}
function getSys(){
  document.getElementById('sys-load').style.display='';
  document.getElementById('sys-grid').style.display='none';
  vscode.postMessage({command:'getSysInfo'});
}
function loadModels(){
  const load=document.getElementById('ollama-mdl-load');
  const tbl=document.getElementById('ollama-mdl-table');
  load.textContent='Loading\u2026';load.style.display='';
  if(tbl)tbl.style.display='none';
  vscode.postMessage({command:'getOllamaModels'});
}
function chkOllama(){
  document.getElementById('ollama-chk-btn').textContent='\u23f3\u2026';
  vscode.postMessage({command:'checkOllamaVersion'});
}
function ollamaUpgrade(){vscode.postMessage({command:'ollamaUpgrade'})}
window.addEventListener('message',({data})=>{
  if(data.type==='versionInfo'){
    const btn=document.getElementById('chk-btn');
    btn.textContent='\uD83D\uDD0D Check for Updates';btn.disabled=false;
    if(data.error){document.getElementById('ver-avail').textContent='Error \u2014 try again';}
    else if(data.available){
      document.getElementById('ver-avail').textContent=data.available;
      document.getElementById('last-check').textContent=new Date().toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
      const installed=INST_VER||document.getElementById('ver-installed')?.textContent?.trim()||'';
      function semverGt(a,b){
        function pv(v){const m=v.match(/^(\d+)\.(\d+)\.(\d+)(?:\.(dev)(\d+)|a(\d+)|b(\d+)|rc(\d+))?/);if(!m)return[0,0,0,0];let pre=999999;if(m[4]!==undefined&&m[5]!==undefined)pre=parseInt(m[5])||0;else if(m[6]!==undefined)pre=10000+(parseInt(m[6])||0);else if(m[7]!==undefined)pre=20000+(parseInt(m[7])||0);else if(m[8]!==undefined)pre=30000+(parseInt(m[8])||0);return[parseInt(m[1])||0,parseInt(m[2])||0,parseInt(m[3])||0,pre];}
        const av=pv(a),bv=pv(b);for(let i=0;i<4;i++){if(av[i]>bv[i])return true;if(av[i]<bv[i])return false;}return false;
      }
      if(installed&&semverGt(data.available,installed)){
        const row=btn.closest('.btn-row');
        if(row&&!row.querySelector('.btn-upd')){const upd=document.createElement('button');upd.className='btn btn-upd';upd.textContent='\u2b06 Install Update';upd.onclick=()=>vscode.postMessage({command:'installUpdate'});row.appendChild(upd);}
      }else if(installed){document.getElementById('ver-avail').textContent=data.available+' \u2713 (current)';}
    }
  }
  if(data.type==='installStarted'){
    const row=document.getElementById('chk-btn')?.closest('.btn-row');
    if(row){const old=row.querySelector('.btn-upd,button[disabled]');if(old)old.remove();const rel=document.createElement('button');rel.className='btn-rel';rel.textContent='\u21BA Reload Window';rel.onclick=()=>vscode.postMessage({command:'reloadWindow'});row.appendChild(rel);}
  }
  if(data.type==='sysInfo'){
    const g=document.getElementById('sys-grid');
    const labels={os:'OS',cpu:'CPU',cores:'Cores',ram:'RAM',gpu:'GPU',disk:'Disk'};
    g.innerHTML=Object.entries(labels).filter(([k])=>data.info[k]).map(([k,l])=>\`<span class="sys-lbl">\${l}</span><span class="sys-val">\${data.info[k]}</span>\`).join('');
    document.getElementById('sys-load').style.display='none';g.style.display='grid';
  }
  if(data.type==='ollamaModels'){
    const tbody=document.getElementById('ollama-mdl-body');
    const load=document.getElementById('ollama-mdl-load');
    const tbl=document.getElementById('ollama-mdl-table');
    const now=Date.now();
    const STALE_MS=30*24*60*60*1000; // 30 days
    tbody.innerHTML=(data.models||[]).map(m=>{
      const gb=(m.size>0?(m.size/1073741824).toFixed(1)+'GB':'');
      const mod=(m.modified_at||'').slice(0,10);
      const modMs=m.modified_at?new Date(m.modified_at).getTime():0;
      const stale=modMs>0&&(now-modMs)>STALE_MS;
      const dateStyle=stale?'color:var(--amb);font-weight:600':'color:var(--dim)';
      const staleTag=stale?' \u26a0':'';  // ⚠ indicator
      var dg=(m.digest||'').slice(0,12);
      return \`<tr><td>\${m.name}</td><td class="dim">\${gb}</td>
        <td class="dim" style="font-family:var(--mn);font-size:9px">\${dg}</td>
        <td style="\${dateStyle}">\${mod}\${staleTag}</td>
        <td style="display:flex;gap:3px">
          <button class="tb" onclick="vscode.postMessage({command:'ollamaUpdateModel',modelId:'\${m.name}'})">\u2b06 Update</button>
          <button class="tb tb-red" onclick="vscode.postMessage({command:'ollamaRemoveModel',modelId:'\${m.name}'})">\u2717 Remove</button>
        </td></tr>\`;
    }).join('');
    load.style.display=data.models&&data.models.length?'none':'';
    tbl.style.display=data.models&&data.models.length?'':'none';
    if(!data.models||!data.models.length){load.textContent='No Ollama models installed';}
    /* Populate default model dropdown */
    var defMdlSel=document.getElementById('ollama-def-model');
    if(defMdlSel&&data.models){
      var savedDef=defMdlSel.dataset.saved||'';
      defMdlSel.innerHTML='<option value="">(auto \u2014 first installed)</option>';
      for(var mi of data.models){
        var oi=document.createElement('option');oi.value=mi.name;oi.textContent=mi.name;
        if(mi.name===savedDef)oi.selected=true;
        defMdlSel.appendChild(oi);
      }
    }
  }
  if(data.type==='gpuInfo'){
    var ge=document.getElementById('ollama-gpu');
    var re2=document.getElementById('ollama-rec');
    var cs=document.getElementById('ollama-ctx');
    if(ge)ge.textContent=data.vram>0?data.vram+' GB VRAM':'No GPU detected';
    if(re2)re2.textContent=data.rec+' tokens (based on '+data.vram+' GB VRAM)';
    if(cs&&data.currentCtx!==undefined)cs.value=String(data.currentCtx);
  }
  if(data.type==='ollamaVersionInfo'){
    document.getElementById('ollama-chk-btn').textContent='\uD83D\uDD0D Check Ollama';
    document.getElementById('ollama-ver').textContent=data.installed||'(not running)';
    document.getElementById('ollama-latest').textContent=data.latest?(data.installed&&data.latest!==data.installed?data.latest+' \u2190 update available':data.latest+' \u2713 up to date'):'(could not check)';
  }
  if(data.type==='apiKeyStatus'){
    const tbody=document.getElementById('api-key-body');
    if(tbody&&data.keys){
      tbody.innerHTML=data.keys.map(k=>{
        const icon=k.hasKey?'<span style="color:var(--grn);font-weight:700">\u2713</span>':'<span style="color:var(--dim)">\u2014</span>';
        const label=k.hasKey?'set':'not set';
        return \`<tr><td>\${k.label}</td><td>\${icon} \${label}</td>
          <td style="display:flex;gap:3px">
            <button class="tb" onclick="setKey('\${k.id}')">\${k.hasKey?'\u270E Edit':'\uD83D\uDD11 Set'}</button>
            \${k.hasKey?\`<button class="tb" id="vk-\${k.id}" onclick="verKey(this,'\${k.id}')">\u2705 Verify</button>\`:''}
          </td></tr>\`;
      }).join('');
    }
  }
  if(data.type==='apiKeyVerified'){
    const btn=document.getElementById('vk-'+data.provider);
    if(btn){
      if(data.ok){btn.textContent='\u2713 '+data.models+' models';btn.style.color='var(--grn)';}
      else{btn.textContent='\u2717 Failed';btn.style.color='var(--red)';}
      btn.disabled=false;
      setTimeout(()=>{if(btn){btn.textContent='\u2705 Verify';btn.style.color='';btn.disabled=false;}},4000);
    }
  }
  if(data.type==='showRestartBanner'){
    var banner=document.getElementById('restart-banner');
    var bmsg=document.getElementById('restart-msg');
    var rbtn=document.getElementById('restart-btn');
    if(banner&&bmsg){
      bmsg.textContent=data.message||'\u2713 Operation complete.';
      if(rbtn)rbtn.style.display=data.needsRestart?'':'none';
      banner.classList.add('show');
      if(!data.needsRestart)setTimeout(function(){banner.classList.remove('show');},5000);
    }
  }
});
function setKey(prov){vscode.postMessage({command:'setApiKey',provider:prov})}
function verKey(btn,prov){btn.textContent='\u23f3\u2026';btn.disabled=true;vscode.postMessage({command:'verifyApiKey',provider:prov})}
// Auto-load sys info on open
getSys();
vscode.postMessage({command:'getApiKeyStatus'});
</script>
</body></html>`;
}
