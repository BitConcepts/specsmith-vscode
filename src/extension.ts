// SPDX-License-Identifier: MIT
// Copyright (c) 2026 BitConcepts, LLC. All rights reserved.
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionPanel, onSessionStatusChange } from './SessionPanel';
import {
  ProjectTreeProvider, ProjectItem,
  fileNewFile, fileNewFolder, fileDelete, fileRename,
} from './ProjectTree';
import { EpistemicBar } from './EpistemicBar';
import { ApiKeyManager } from './ApiKeyManager';
import { showHelp } from './HelpPanel';
import { showGovernancePanel } from './GovernancePanel';
import { fetchModels } from './ModelRegistry';
import { OllamaManager, TASK_SUGGESTIONS } from './OllamaManager';
import { SessionStatus } from './types';

// ── Activation ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {

  // ── Sidebar: unified Projects (includes file tree + governance) ───────────
  const projectTree = new ProjectTreeProvider(context);
  const projectView = vscode.window.createTreeView('specsmith.projects', {
    treeDataProvider: projectTree,
    showCollapseAll:  true,
  });

  // ── Sidebar: Sessions ────────────────────────────────────────────────────
  const sessionTree = new SessionTreeProvider();
  const sessionView = vscode.window.createTreeView('specsmith.sessions', {
    treeDataProvider: sessionTree,
  });

  // ── Status bar ────────────────────────────────────────────────────────────
  const epistemicBar = new EpistemicBar(context);

  // ── Session status → session tree ────────────────────────────────────────
  context.subscriptions.push(
    onSessionStatusChange((_panel: SessionPanel, _status: SessionStatus) => {
      sessionTree.refresh();
    }),
  );

  // ── Helpers ───────────────────────────────────────────────────────────────

  function defaultCfg() {
    const cfg = vscode.workspace.getConfiguration('specsmith');
    return {
      provider: cfg.get<string>('defaultProvider', 'anthropic'),
      model:    cfg.get<string>('defaultModel', ''),
    };
  }

  async function openSession(projectDir: string): Promise<void> {
    const d = defaultCfg();
    const { provider, hasKeys } = await ApiKeyManager.getDefaultProvider(context.secrets, d.provider);

    if (!hasKeys) {
      const action = await vscode.window.showWarningMessage(
        'specsmith: No API keys configured. The agent won\'t be able to call any LLM.',
        'Set API Key Now',
        'Continue Anyway',
      );
      if (action === 'Set API Key Now') {
        await ApiKeyManager.promptSetKey(context.secrets);
      }
    }

    await SessionPanel.create(context, projectDir, provider, d.model);
    sessionTree.refresh();
    projectTree.addProject(projectDir);
  }

  // ── Commands: Sessions ───────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('specsmith.newSession', async () => {
      const choices = (vscode.workspace.workspaceFolders ?? []).map((f) => ({
        label: f.name, description: f.uri.fsPath, detail: 'Workspace folder',
      }));
      let picked: string | undefined;
      if (choices.length === 1) {
        picked = choices[0].description;
      } else if (choices.length > 1) {
        const sel = await vscode.window.showQuickPick(
          [...choices, { label: '$(folder-opened) Browse…', description: '__browse__' }],
          { placeHolder: 'Select project folder for this session' },
        );
        if (!sel) { return; }
        picked = sel.description === '__browse__' ? undefined : sel.description;
      }
      if (!picked) {
        const uri = await vscode.window.showOpenDialog({
          canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
          openLabel: 'Open as specsmith Project',
        });
        if (!uri?.[0]) { return; }
        picked = uri[0].fsPath;
      }
      if (picked) { await openSession(picked); }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('specsmith.newSessionFromProject', async (item?: ProjectItem) => {
      const dir = item?.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (dir) { await openSession(dir); }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('specsmith.deleteSession', (item?: SessionItem) => {
      item?.panel.dispose();
      sessionTree.refresh();
    }),
  );

  // ── Commands: Projects ───────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('specsmith.openProject', async () => {
      const uri = await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        openLabel: 'Add as specsmith Project',
      });
      if (uri?.[0]) { projectTree.addProject(uri[0].fsPath); }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('specsmith.createProject', async () => {
      const name = await vscode.window.showInputBox({ prompt: 'New project name', placeHolder: 'my-project' });
      if (!name) { return; }
      const uri = await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        openLabel: 'Create project here',
      });
      if (!uri?.[0]) { return; }
      const cfg  = vscode.workspace.getConfiguration('specsmith');
      const exec = cfg.get<string>('executablePath', 'specsmith');
      const term = vscode.window.createTerminal('specsmith init');
      term.sendText(`${exec} init --name "${name}" --project-dir "${uri[0].fsPath}"`);
      term.show();
      projectTree.addProject(uri[0].fsPath);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('specsmith.importProject', async () => {
      const uri = await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        openLabel: 'Import this project',
      });
      if (!uri?.[0]) { return; }
      const cfg  = vscode.workspace.getConfiguration('specsmith');
      const exec = cfg.get<string>('executablePath', 'specsmith');
      const term = vscode.window.createTerminal('specsmith import');
      term.sendText(`${exec} import --project-dir "${uri[0].fsPath}"`);
      term.show();
      projectTree.addProject(uri[0].fsPath);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('specsmith.removeProject', (item?: ProjectItem) => {
      if (item?.fsPath) { projectTree.removeProject(item.fsPath); }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('specsmith.refreshProjects', () => projectTree.refresh()),
  );

  // ── Commands: File operations (tree context menu) ────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('specsmith.newFile', (item?: ProjectItem) => {
      if (item) { void fileNewFile(item).then(() => projectTree.refresh()); }
    }),
    vscode.commands.registerCommand('specsmith.newFolder', (item?: ProjectItem) => {
      if (item) { void fileNewFolder(item).then(() => projectTree.refresh()); }
    }),
    vscode.commands.registerCommand('specsmith.deleteFile', (item?: ProjectItem) => {
      if (item) { void fileDelete(item).then(() => projectTree.refresh()); }
    }),
    vscode.commands.registerCommand('specsmith.renameFile', (item?: ProjectItem) => {
      if (item) { void fileRename(item).then(() => projectTree.refresh()); }
    }),
    vscode.commands.registerCommand('specsmith.copyFilePath', (item?: ProjectItem) => {
      if (item?.fsPath) { void vscode.env.clipboard.writeText(item.fsPath); }
    }),
    vscode.commands.registerCommand('specsmith.revealInExplorer', (item?: ProjectItem) => {
      if (item?.fsPath) {
        void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(item.fsPath));
      }
    }),
  );

  // ── Commands: API keys ───────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('specsmith.setApiKey', async () => {
      await ApiKeyManager.promptSetKey(context.secrets);
      // After saving, verify the key and broadcast fresh model list to open sessions
      void _verifyAndBroadcast(context);
    }),
    vscode.commands.registerCommand('specsmith.clearApiKey', () => {
      void ApiKeyManager.promptClearKey(context.secrets);
    }),
    vscode.commands.registerCommand('specsmith.apiKeyStatus', () => {
      void ApiKeyManager.showStatus(context.secrets);
    }),
  );

  // Startup: fetch models, update check, and auto-open governance panel
  void _startupFetchModels(context);
  void _checkForSpecsmithUpdate(context);
  void _autoOpenGovernancePanel(context, openSession);

  // Keep governance panel in sync when workspace folders change
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      // If the panel is open and the project dir changed, it will be refreshed on next focus
    }),
  );

  // ── Commands: specsmith tools ────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('specsmith.runAudit', () => {
      const s = SessionPanel.current();
      if (s) { s.sendCommand('audit'); epistemicBar.refresh(); }
      else { void vscode.window.showInformationMessage('specsmith: open a session first.'); }
    }),
    vscode.commands.registerCommand('specsmith.runValidate', () => SessionPanel.current()?.sendCommand('validate')),
    vscode.commands.registerCommand('specsmith.runDoctor',   () => SessionPanel.current()?.sendCommand('doctor')),
  );

  // ── Commands: Requirements + governance UI ────────────────────────────────

  // Quick-add a requirement to REQUIREMENTS.md
  context.subscriptions.push(
    vscode.commands.registerCommand('specsmith.addRequirement', async () => {
      const session = SessionPanel.current();
      const projectDir = session?.projectDir
        ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!projectDir) {
        void vscode.window.showWarningMessage('specsmith: no project open.');
        return;
      }

      const reqFile = _findReqFile(projectDir);
      if (!reqFile) {
        void vscode.window.showWarningMessage('No REQUIREMENTS.md found. Create one first.');
        return;
      }

      const id = await vscode.window.showInputBox({
        prompt: 'Requirement ID (e.g. REQ-UI-001)',
        placeHolder: 'REQ-XXX-001',
        validateInput: (v) => /^[A-Z][A-Z0-9-]+$/.test(v) ? undefined : 'Use format: REQ-CAT-001',
      });
      if (!id) { return; }

      const desc = await vscode.window.showInputBox({
        prompt: 'Requirement description',
        placeHolder: 'The system shall…',
      });
      if (!desc) { return; }

      const priority = await vscode.window.showQuickPick(
        ['P1 — Must Have', 'P2 — Should Have', 'P3 — Nice to Have'],
        { placeHolder: 'Priority' },
      );
      if (!priority) { return; }

      const pLevel = priority.split(' ')[0]; // 'P1', 'P2', 'P3'
      const entry  = `\n### ${id}\n**Priority**: ${pLevel}\n**Description**: ${desc}\n**Status**: Draft\n`;

      fs.appendFileSync(reqFile, entry, 'utf8');
      void vscode.window.showTextDocument(vscode.Uri.file(reqFile)).then((ed) => {
        const lastLine = ed.document.lineCount - 1;
        ed.revealRange(new vscode.Range(lastLine, 0, lastLine, 0));
      });
      void vscode.window.showInformationMessage(`Added ${id} to ${path.basename(reqFile)}`);
      projectTree.refresh();
    }),
  );

  // Open scaffold.yml
  context.subscriptions.push(
    vscode.commands.registerCommand('specsmith.openScaffold', async () => {
      const session = SessionPanel.current();
      const projectDir = session?.projectDir
        ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!projectDir) { void vscode.window.showWarningMessage('specsmith: no project open.'); return; }

      const candidates = ['scaffold.yml', 'scaffold.yaml', '.specsmith/config.yml'];
      const found = candidates.map((c) => path.join(projectDir, c)).find(fs.existsSync);
      if (found) {
        await vscode.window.showTextDocument(vscode.Uri.file(found));
      } else {
        void vscode.window.showWarningMessage('scaffold.yml not found. Run specsmith init first.');
      }
    }),
  );

  // Navigate all requirements (quick pick)
  context.subscriptions.push(
    vscode.commands.registerCommand('specsmith.navigateRequirements', async () => {
      const session = SessionPanel.current();
      const projectDir = session?.projectDir ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!projectDir) { void vscode.window.showWarningMessage('specsmith: no project open.'); return; }

      const reqFile = _findReqFile(projectDir);
      if (!reqFile) { void vscode.window.showWarningMessage('No REQUIREMENTS.md found.'); return; }

      const content = fs.readFileSync(reqFile, 'utf8');
      const matches = [...content.matchAll(/^###\s+(REQ-[A-Z0-9-]+)(.*)/gm)];
      if (!matches.length) { void vscode.window.showInformationMessage('No requirements found.'); return; }

      const items = matches.map((m, i) => ({
        label:       m[1],
        description: m[2].trim(),
        lineNumber:  content.slice(0, m.index).split('\n').length - 1,
      }));

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: `${items.length} requirements in ${path.basename(reqFile)}`,
        matchOnDescription: true,
      });
      if (!picked) { return; }

      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(reqFile));
      const ed  = await vscode.window.showTextDocument(doc);
      const pos = new vscode.Position(picked.lineNumber, 0);
      ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      ed.selection = new vscode.Selection(pos, pos);
    }),
  );

  // ── Commands: Install / Upgrade specsmith ───────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('specsmith.installOrUpgrade', async () => {
      const cfg      = vscode.workspace.getConfiguration('specsmith');
      const execPath = cfg.get<string>('executablePath', 'specsmith');

      // Probe current version (try configured path + pipx bin fallback)
      const version = _probeVersion(execPath);

      const isInstalled = version !== null;
      const items: vscode.QuickPickItem[] = isInstalled
        ? [
            { label: '$(arrow-up) Upgrade specsmith via pipx', description: `current: ${version}` },
            { label: '$(arrow-up) Upgrade specsmith via pip', description: 'pip install --upgrade specsmith' },
            { label: '$(info) Copy install path to clipboard', description: execPath },
          ]
        : [
            { label: '$(cloud-download) Install via pipx (recommended)', description: 'pipx install specsmith[anthropic]' },
            { label: '$(cloud-download) Install via pip',                 description: 'pip install specsmith[anthropic]' },
          ];

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: isInstalled
          ? `specsmith ${version} installed — upgrade?`
          : 'specsmith not found — choose install method',
      });
      if (!picked) { return; }

      if (picked.label.includes('clipboard')) {
        await vscode.env.clipboard.writeText(execPath);
        void vscode.window.showInformationMessage(`Copied: ${execPath}`);
        return;
      }

      const term = vscode.window.createTerminal({ name: 'specsmith install', shellPath: _shellPath() });
      term.show();

      if (picked.label.includes('pipx') && isInstalled) {
        term.sendText('pipx upgrade specsmith');
      } else if (picked.label.includes('pipx')) {
        term.sendText('pipx install "specsmith[anthropic]"');
      } else {
        const flag = isInstalled ? '--upgrade' : '--user';
        term.sendText(`pip install ${flag} "specsmith[anthropic]"`);
      }

      void vscode.window.showInformationMessage(
        'specsmith install/upgrade running in the terminal below. ' +
        'Reload the window after it completes.',
        'Reload Now',
      ).then((a) => {
        if (a === 'Reload Now') {
          void vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      });
    }),
  );

  // ── Commands: Chat history ──────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('specsmith.clearHistory', () => {
      const s = SessionPanel.current();
      if (s) { s.clearHistoryExternal(); }
      else { void vscode.window.showInformationMessage('specsmith: no active session.'); }
    }),
    vscode.commands.registerCommand('specsmith.clearAllHistory', async () => {
      const sessions = SessionPanel.all();
      if (!sessions.length) {
        void vscode.window.showInformationMessage('specsmith: no open sessions.');
        return;
      }
      const ans = await vscode.window.showWarningMessage(
        `Clear display and history files for all ${sessions.length} open session(s)?`,
        { modal: true }, 'Clear All',
      );
      if (ans === 'Clear All') {
        for (const s of sessions) { s.clearHistoryExternal(); }
        void vscode.window.showInformationMessage(`${sessions.length} session(s) cleared.`);
      }
    }),
  );

  // ── Commands: Ollama (download + task-based model selection) ────────────

  context.subscriptions.push(
    // Called when user selects a 'dl:' prefixed model from the dropdown
    vscode.commands.registerCommand('specsmith.downloadModel', async (modelId: string) => {
      if (!modelId) { return; }

      // Confirm before downloading
      const catalog = (await import('./OllamaManager')).OLLAMA_CATALOG.find((c) => c.id === modelId);
      const detail  = catalog ? `${catalog.sizeGb}GB — ${catalog.notes}` : 'unknown size';

      const ans = await vscode.window.showInformationMessage(
        `Download "${modelId}"?`,
        { detail, modal: true },
        'Download',
        'Cancel',
      );
      if (ans !== 'Download') { return; }

      const cts = new vscode.CancellationTokenSource();
      const ok  = await OllamaManager.download(modelId, cts.token);
      cts.dispose();

      if (ok) {
        // Refresh Ollama model list in all open sessions
        const models = await fetchModels('ollama');
        for (const panel of SessionPanel.all()) {
          panel.postModels('ollama', models);
        }
        // Switch the active session to the newly downloaded model
        const current = SessionPanel.current();
        if (current) { current.setModelExternal(modelId); }
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('specsmith.selectModelForTask', async () => {
      // Step 1: pick task type
      const taskItems = Object.keys(TASK_SUGGESTIONS).map((k) => ({
        label: k,
        description: TASK_SUGGESTIONS[k].join(', '),
      }));

      const taskPick = await vscode.window.showQuickPick(taskItems, {
        placeHolder: 'What do you need the model for?',
        matchOnDescription: true,
      });
      if (!taskPick) { return; }

      // Gather available info
      const [installedIds, vramGb] = await Promise.all([
        OllamaManager.getInstalledIds(),
        OllamaManager.getVramGb(),
      ]);
      const suggestions = await OllamaManager.suggestForTask(taskPick.label, installedIds, vramGb);

      if (!suggestions.length) {
        void vscode.window.showInformationMessage(`No local models match task "${taskPick.label}". Consider downloading one.`);
        return;
      }

      // Step 2: pick a specific model
      const modelItems: vscode.QuickPickItem[] = suggestions.map((s) => ({
        label:       s.installed ? `✓ ${s.name}` : `⬇ ${s.name}`,
        description: s.installed
          ? 'Installed — ready'
          : `${s.sizeGb?.toFixed(1) ?? '?'}GB — click to download`,
        detail:      s.notes,
      }));

      const modelPick = await vscode.window.showQuickPick(modelItems, {
        placeHolder:  `Best models for "${taskPick.label}" (✓ = installed, ⬇ = download needed)`,
        matchOnDetail: true,
      });
      if (!modelPick) { return; }

      const selected = suggestions[modelItems.indexOf(modelPick)];
      if (!selected) { return; }

      if (selected.installed) {
        // Just switch the current session
        const cur = SessionPanel.current();
        if (cur) {
          cur.setModelExternal(selected.id);
          void vscode.window.showInformationMessage(`✓ Switched to ${selected.name}`);
        } else {
          void vscode.window.showInformationMessage(`Open a session first, then select: ${selected.id}`);
        }
      } else {
        // Trigger download
        void vscode.commands.executeCommand('specsmith.downloadModel', selected.id);
      }
    }),
  );

  // ── Commands: Governance panel ─────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('specsmith.showGovernance', () => {
      const session    = SessionPanel.current();
      const projectDir = session?.projectDir
        ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!projectDir) {
        void vscode.window.showWarningMessage('specsmith: open a session or workspace first.');
        return;
      }
      showGovernancePanel(
        context,
        projectDir,
        // sendToSession: uses current session or last opened
        (text) => { SessionPanel.current()?.sendCommand(text); },
        // openSession: auto-creates a session for this project
        async () => { await openSession(projectDir); },
      );
    }),
  );

  // ── Commands: Help ──────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('specsmith.showHelp', () => showHelp(context)),
  );

  // ── Workspace folder sync ────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const added of e.added) { projectTree.addProject(added.uri.fsPath); }
      projectTree.refresh();
    }),
  );

  // ── Disposables ───────────────────────────────────────────────────────────
  context.subscriptions.push(projectView, sessionView, projectTree, epistemicBar);
}

export function deactivate(): void { /* context.subscriptions handles cleanup */ }

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Synchronously probe the specsmith executable. Tries the configured path
 * first, then common pipx/pip bin locations. Returns the version string or
 * null if specsmith cannot be found or executed.
 */
function _probeVersion(configured: string): string | null {
  const candidates = [configured];

  if (process.platform === 'win32') {
    const local   = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    const roaming = process.env.APPDATA       ?? path.join(os.homedir(), 'AppData', 'Roaming');
    candidates.push(
      path.join(local,   'pipx', 'bin', 'specsmith.exe'),
      path.join(local,   'pipx', 'bin', 'specsmith.bat'),
      path.join(local,   'Programs', 'Python', 'Scripts', 'specsmith.exe'),
      path.join(roaming, 'Python', 'Scripts', 'specsmith.exe'),
    );
  } else {
    candidates.push(
      path.join(os.homedir(), '.local', 'bin', 'specsmith'),
      '/usr/local/bin/specsmith',
    );
  }

  for (const c of candidates) {
    try {
      const result = cp.spawnSync(c, ['--version'], { timeout: 5000, encoding: 'utf8' });
      if (result.status === 0) {
        return (result.stdout ?? '').trim().split('\n')[0];
      }
    } catch { /* not found, try next */ }
  }
  return null;
}

/** Return the user's default shell path for a terminal. */
function _shellPath(): string | undefined {
  if (process.platform === 'win32') {
    return process.env.ComSpec ?? 'powershell.exe';
  }
  return process.env.SHELL;
}

/**
 * After an API key is set: verify it against the provider's models API,
 * show a notification, and push fresh models to all open session panels.
 */
async function _verifyAndBroadcast(context: vscode.ExtensionContext): Promise<void> {
  const PROVIDERS = ['anthropic', 'openai', 'gemini', 'mistral'] as const;
  for (const prov of PROVIDERS) {
    const key = await ApiKeyManager.getKey(context.secrets, prov);
    if (!key) { continue; }
    try {
      const models = await fetchModels(prov, key);
      if (models.length > 0) {
        void vscode.window.showInformationMessage(
          `✓ ${prov} API key verified — ${models.length} models available`,
        );
        // Push to any open session using this provider
        for (const panel of SessionPanel.all()) {
          panel.postModels(prov, models);
        }
      } else {
        void vscode.window.showWarningMessage(`${prov}: key accepted but no models returned`);
      }
    } catch (err) {
      void vscode.window.showWarningMessage(
        `${prov}: could not verify API key — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Check if a newer specsmith is available (once per day). Prompt to upgrade if so. */
async function _checkForSpecsmithUpdate(context: vscode.ExtensionContext): Promise<void> {
  const DAILY_MS = 24 * 60 * 60 * 1000;
  const lastCheck = context.globalState.get<number>('specsmith.lastUpdateCheck', 0);
  if (Date.now() - lastCheck < DAILY_MS) { return; }
  await context.globalState.update('specsmith.lastUpdateCheck', Date.now());

  await new Promise((r) => setTimeout(r, 5000)); // wait for startup
  try {
    const cfg      = vscode.workspace.getConfiguration('specsmith');
    const execPath = cfg.get<string>('executablePath', 'specsmith');
    const current  = _probeVersion(execPath);
    if (!current) { return; } // specsmith not installed

    // Fetch latest from PyPI
    const https = await import('https');
    const res = await new Promise<string>((resolve, reject) => {
      const req = https.get(
        'https://pypi.org/pypi/specsmith/json',
        { timeout: 8000 },
        (r) => { let d = ''; r.on('data', (c: Buffer) => { d += c; }); r.on('end', () => resolve(d)); },
      );
      req.on('error', reject);
    });
    const pypiData = JSON.parse(res) as { info?: { version?: string } };
    const latest   = pypiData.info?.version;
    if (!latest || latest === current.split(/\s/)[2]) { return; }

    const ans = await vscode.window.showInformationMessage(
      `specsmith update available: v${latest} (installed: ${current})`,
      'Upgrade Now',
      'Later',
    );
    if (ans === 'Upgrade Now') {
      void vscode.commands.executeCommand('specsmith.installOrUpgrade');
    }
  } catch { /* silent — don't crash startup */ }
}

/**
 * Auto-open the Governance panel when VS Code starts with a workspace.
 * Opens Beside the editor after a short delay so it doesn't block activation.
 * Respects a user setting to disable: specsmith.autoOpenGovernancePanel = false.
 */
async function _autoOpenGovernancePanel(
  context: vscode.ExtensionContext,
  openSession: (dir: string) => Promise<void>,
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('specsmith');
  if (cfg.get<boolean>('autoOpenGovernancePanel', true) === false) { return; }

  // Wait for VS Code to finish painting before we do anything
  await new Promise((r) => setTimeout(r, 1500));

  const workspaceDir =
    SessionPanel.current()?.projectDir
    ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  if (!workspaceDir) { return; }

  // Focus the specsmith sidebar first so the user sees it
  void vscode.commands.executeCommand('workbench.view.extension.specsmith');

  showGovernancePanel(
    context,
    workspaceDir,
    (text) => SessionPanel.current()?.sendCommand(text),
    async () => { await openSession(workspaceDir); },
  );
}

/** Silently warm the model cache at extension startup for all configured providers. */
async function _startupFetchModels(context: vscode.ExtensionContext): Promise<void> {
  // Delay so we don't slow down extension activation
  await new Promise((r) => setTimeout(r, 2000));
  const PROVIDERS = ['anthropic', 'openai', 'gemini', 'mistral'] as const;
  for (const prov of PROVIDERS) {
    const key = await ApiKeyManager.getKey(context.secrets, prov);
    if (key) {
      try { await fetchModels(prov, key); } catch { /* warm cache only, ignore errors */ }
    }
  }
}

function _findReqFile(projectDir: string): string | undefined {
  const candidates = [
    path.join(projectDir, 'REQUIREMENTS.md'),
    path.join(projectDir, 'docs', 'REQUIREMENTS.md'),
  ];
  return candidates.find(fs.existsSync);
}

// ── Sessions TreeDataProvider ─────────────────────────────────────────────────

class SessionItem extends vscode.TreeItem {
  constructor(public readonly panel: SessionPanel) {
    super(panel.label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'session';
    this.tooltip      = `${panel.projectDir}\nStarted: ${panel.startTime}`;
    this.description  = panel.startTime;
    this.iconPath     = _statusIcon(panel.status);
    this.command      = { command: 'specsmith.newSessionFromProject', title: 'Focus', arguments: [] };
  }
}

function _statusIcon(status: SessionStatus): vscode.ThemeIcon {
  switch (status) {
    case 'starting': return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.yellow'));
    case 'waiting':  return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
    case 'running':  return new vscode.ThemeIcon('loading~spin');
    case 'error':    return new vscode.ThemeIcon('warning'); // triangle ⚠ — visible at a glance
    default:         return new vscode.ThemeIcon('circle-outline');
  }
}

class SessionTreeProvider implements vscode.TreeDataProvider<SessionItem> {
  private readonly _change = new vscode.EventEmitter<SessionItem | undefined | void>();
  readonly onDidChangeTreeData = this._change.event;

  refresh(): void { this._change.fire(); }
  getTreeItem(el: SessionItem): vscode.TreeItem { return el; }
  getChildren(): SessionItem[] { return SessionPanel.all().map((p) => new SessionItem(p)); }
}
