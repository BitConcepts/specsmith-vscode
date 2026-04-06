// SPDX-License-Identifier: MIT
// Copyright (c) 2026 BitConcepts, LLC. All rights reserved.
import * as vscode from 'vscode';
import { SessionPanel, onSessionStatusChange } from './SessionPanel';
import { ProjectTreeProvider, ProjectItem } from './ProjectTree';
import { FileTreeProvider, FileItem, newFile, newFolder, deleteFileItem, renameFileItem } from './FileTree';
import { EpistemicBar } from './EpistemicBar';
import { ApiKeyManager } from './ApiKeyManager';
import { showHelp } from './HelpPanel';
import { SessionStatus } from './types';

// ── Activation ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {

  // ── Sidebar: Projects ────────────────────────────────────────────────────
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

  // ── Sidebar: Files ───────────────────────────────────────────────────────
  const fileTree = new FileTreeProvider();
  const fileView = vscode.window.createTreeView('specsmith.files', {
    treeDataProvider: fileTree,
    showCollapseAll:  true,
  });

  // ── Status bar ────────────────────────────────────────────────────────────
  const epistemicBar = new EpistemicBar(context);

  // ── Session status → tree + file tree updates ────────────────────────────
  context.subscriptions.push(
    onSessionStatusChange((panel, _status: SessionStatus) => {
      sessionTree.refresh();
      // Update file tree to track the active session's directory
      const cur = SessionPanel.current();
      fileTree.setRoot(cur?.projectDir);
    }),
  );

  // ── Helpers ───────────────────────────────────────────────────────────────

  function defaults() {
    const cfg = vscode.workspace.getConfiguration('specsmith');
    return {
      provider: cfg.get<string>('defaultProvider', 'anthropic'),
      model:    cfg.get<string>('defaultModel', ''),
    };
  }

  async function openSession(projectDir: string): Promise<void> {
    const d = defaults();
    // Auto-select provider: if only 1 API key is set, use it; otherwise use setting
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

    const session = await SessionPanel.create(context, projectDir, provider, d.model);
    sessionTree.refresh();
    fileTree.setRoot(session.projectDir);
    projectTree.addProject(projectDir);
  }

  // ── Commands: Sessions ───────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('specsmith.newSession', async () => {
      const choices: vscode.QuickPickItem[] = (vscode.workspace.workspaceFolders ?? [])
        .map((f) => ({ label: f.name, description: f.uri.fsPath, detail: 'Workspace folder' }));

      let picked: string | undefined;
      if (choices.length === 1) {
        picked = choices[0].description;
      } else if (choices.length > 1) {
        const sel = await vscode.window.showQuickPick(
          [...choices, { label: '$(folder-opened) Browse…', description: '__browse__' }],
          { placeHolder: 'Select project folder for this agent session' },
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
      if (item?.panel) {
        item.panel.dispose();
        sessionTree.refresh();
        fileTree.setRoot(SessionPanel.current()?.projectDir);
      }
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
      const name = await vscode.window.showInputBox({
        prompt: 'New project name', placeHolder: 'my-project',
      });
      if (!name) { return; }
      const uri = await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        openLabel: 'Create project here',
      });
      if (!uri?.[0]) { return; }
      const cfg = vscode.workspace.getConfiguration('specsmith');
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
      const cfg = vscode.workspace.getConfiguration('specsmith');
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
    vscode.commands.registerCommand('specsmith.refreshProjects', () => {
      projectTree.refresh();
      fileTree.refresh();
    }),
  );

  // ── Commands: File tree ──────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('specsmith.refreshFiles', () => fileTree.refresh()),
    vscode.commands.registerCommand('specsmith.newFile', (item?: FileItem) => {
      if (item) { void newFile(item).then(() => fileTree.refresh()); }
    }),
    vscode.commands.registerCommand('specsmith.newFolder', (item?: FileItem) => {
      if (item) { void newFolder(item).then(() => fileTree.refresh()); }
    }),
    vscode.commands.registerCommand('specsmith.deleteFile', (item?: FileItem) => {
      if (item) { void deleteFileItem(item).then(() => fileTree.refresh()); }
    }),
    vscode.commands.registerCommand('specsmith.renameFile', (item?: FileItem) => {
      if (item) { void renameFileItem(item).then(() => fileTree.refresh()); }
    }),
    vscode.commands.registerCommand('specsmith.copyFilePath', (item?: FileItem) => {
      if (item?.fsPath) { void vscode.env.clipboard.writeText(item.fsPath); }
    }),
    vscode.commands.registerCommand('specsmith.revealInExplorer', (item?: FileItem) => {
      if (item?.fsPath) {
        void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(item.fsPath));
      }
    }),
  );

  // ── Commands: API keys ───────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('specsmith.setApiKey', () => {
      void ApiKeyManager.promptSetKey(context.secrets);
    }),
    vscode.commands.registerCommand('specsmith.clearApiKey', () => {
      void ApiKeyManager.promptClearKey(context.secrets);
    }),
    vscode.commands.registerCommand('specsmith.apiKeyStatus', () => {
      void ApiKeyManager.showStatus(context.secrets);
    }),
  );

  // ── Commands: Tools ──────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('specsmith.runAudit', () => {
      const s = SessionPanel.current();
      if (s) { s.sendCommand('audit'); epistemicBar.refresh(); }
      else { void vscode.window.showInformationMessage('specsmith: open a session first.'); }
    }),
    vscode.commands.registerCommand('specsmith.runValidate', () => {
      SessionPanel.current()?.sendCommand('validate');
    }),
    vscode.commands.registerCommand('specsmith.runDoctor', () => {
      SessionPanel.current()?.sendCommand('doctor');
    }),
  );

  // ── Commands: Help ───────────────────────────────────────────────────────

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

  context.subscriptions.push(projectView, sessionView, fileView, projectTree, fileTree, epistemicBar);
}

export function deactivate(): void { /* all cleaned up via context.subscriptions */ }

// ── Sessions TreeDataProvider (with colored status icons) ────────────────────

class SessionItem extends vscode.TreeItem {
  constructor(public readonly panel: SessionPanel) {
    super(panel.label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'session';
    this.tooltip      = panel.projectDir;
    this.iconPath     = _statusIcon(panel.status);
    this.command      = {
      command:   'specsmith.newSessionFromProject',
      title:     'Focus',
      arguments: [],
    };
  }
}

function _statusIcon(status: SessionStatus): vscode.ThemeIcon {
  switch (status) {
    case 'starting': return new vscode.ThemeIcon('circle-filled',
      new vscode.ThemeColor('charts.yellow'));
    case 'waiting':  return new vscode.ThemeIcon('circle-filled',
      new vscode.ThemeColor('charts.green'));
    case 'running':  return new vscode.ThemeIcon('loading~spin');
    case 'error':    return new vscode.ThemeIcon('circle-filled',
      new vscode.ThemeColor('charts.red'));
    case 'inactive': return new vscode.ThemeIcon('circle-outline');
    default:         return new vscode.ThemeIcon('circle-outline');
  }
}

class SessionTreeProvider implements vscode.TreeDataProvider<SessionItem> {
  private readonly _change = new vscode.EventEmitter<SessionItem | undefined | void>();
  readonly onDidChangeTreeData = this._change.event;

  refresh(): void { this._change.fire(); }
  getTreeItem(el: SessionItem): vscode.TreeItem { return el; }
  getChildren(): SessionItem[] {
    return SessionPanel.all().map((p) => new SessionItem(p));
  }
}
