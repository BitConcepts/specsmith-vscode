// SPDX-License-Identifier: MIT
// Copyright (c) 2026 BitConcepts, LLC. All rights reserved.
/**
 * specsmith VS Code Extension — activation entry point.
 *
 * Registers:
 *  - Activity Bar sidebar (Projects + Sessions tree views)
 *  - WebviewPanel-based agent sessions (one per project tab)
 *  - Epistemic health status bar item
 *  - Commands accessible from the Command Palette and sidebar menus
 */
import * as vscode from 'vscode';
import { SessionPanel } from './SessionPanel';
import { ProjectTreeProvider, ProjectItem } from './ProjectTree';
import { EpistemicBar } from './EpistemicBar';

// ── Activation ───────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  // ── Sidebar trees ─────────────────────────────────────────────────────────
  const projectTree = new ProjectTreeProvider(context);

  const projectView = vscode.window.createTreeView('specsmith.projects', {
    treeDataProvider: projectTree,
    showCollapseAll:  true,
  });

  const sessionTree = new SessionTreeProvider();
  const sessionView = vscode.window.createTreeView('specsmith.sessions', {
    treeDataProvider: sessionTree,
  });

  // ── Status bar ────────────────────────────────────────────────────────────
  const epistemicBar = new EpistemicBar(context);

  // ── Helper: get default session settings ─────────────────────────────────
  function defaults(): { provider: string; model: string } {
    const cfg = vscode.workspace.getConfiguration('specsmith');
    return {
      provider: cfg.get<string>('defaultProvider', 'anthropic'),
      model:    cfg.get<string>('defaultModel', ''),
    };
  }

  function openSession(projectDir: string): void {
    const d = defaults();
    SessionPanel.create(context, projectDir, d.provider, d.model);
    sessionTree.refresh();
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  // New session: opens a quick-pick dialog to choose the project folder
  context.subscriptions.push(
    vscode.commands.registerCommand('specsmith.newSession', async () => {
      const choices: vscode.QuickPickItem[] = [];

      // Current workspace folders
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        choices.push({
          label:       folder.name,
          description: folder.uri.fsPath,
          detail:      'Workspace folder',
        });
      }

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
          canSelectFolders: true,
          canSelectFiles:   false,
          canSelectMany:    false,
          openLabel:        'Open as specsmith Project',
        });
        if (!uri?.[0]) { return; }
        picked = uri[0].fsPath;
      }

      if (picked) { openSession(picked); }
    }),
  );

  // Open agent session directly from a project item in the tree
  context.subscriptions.push(
    vscode.commands.registerCommand('specsmith.newSessionFromProject', (item?: ProjectItem) => {
      const dir = item?.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (dir) { openSession(dir); }
    }),
  );

  // Add a project folder to the sidebar
  context.subscriptions.push(
    vscode.commands.registerCommand('specsmith.openProject', async () => {
      const uri = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles:   false,
        canSelectMany:    false,
        openLabel:        'Add as specsmith Project',
      });
      if (uri?.[0]) {
        projectTree.addProject(uri[0].fsPath);
      }
    }),
  );

  // Remove a project from the sidebar
  context.subscriptions.push(
    vscode.commands.registerCommand('specsmith.removeProject', (item?: ProjectItem) => {
      if (item?.fsPath) {
        projectTree.removeProject(item.fsPath);
      }
    }),
  );

  // Refresh projects tree
  context.subscriptions.push(
    vscode.commands.registerCommand('specsmith.refreshProjects', () => {
      projectTree.refresh();
    }),
  );

  // Run specsmith tool in the active session
  context.subscriptions.push(
    vscode.commands.registerCommand('specsmith.runAudit', () => {
      const s = SessionPanel.current();
      if (s) { s.sendCommand('audit'); epistemicBar.refresh(); }
      else   { vscode.window.showInformationMessage('specsmith: no active agent session. Open one first.'); }
    }),
    vscode.commands.registerCommand('specsmith.runValidate', () => {
      SessionPanel.current()?.sendCommand('validate');
    }),
    vscode.commands.registerCommand('specsmith.runDoctor', () => {
      SessionPanel.current()?.sendCommand('doctor');
    }),
  );

  // ── Workspace folder changes → add to projects tree ───────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const added of e.added) {
        projectTree.addProject(added.uri.fsPath);
      }
      projectTree.refresh();
    }),
  );

  // ── Disposables ───────────────────────────────────────────────────────────
  context.subscriptions.push(
    projectView,
    sessionView,
    projectTree,
    epistemicBar,
  );
}

export function deactivate(): void {
  // All resources disposed via context.subscriptions
}

// ── Sessions TreeDataProvider ────────────────────────────────────────────────

class SessionItem extends vscode.TreeItem {
  constructor(public readonly panel: SessionPanel) {
    super(panel.label, vscode.TreeItemCollapsibleState.None);
    this.contextValue  = 'session';
    this.iconPath      = new vscode.ThemeIcon('comment-discussion');
    this.tooltip       = panel.projectDir;
    this.command       = {
      command:   'specsmith.newSessionFromProject',
      title:     'Focus',
      arguments: [],
    };
  }
}

class SessionTreeProvider implements vscode.TreeDataProvider<SessionItem> {
  private readonly _change = new vscode.EventEmitter<SessionItem | undefined | void>();
  readonly onDidChangeTreeData = this._change.event;

  refresh(): void { this._change.fire(); }

  getTreeItem(element: SessionItem): vscode.TreeItem { return element; }

  getChildren(): SessionItem[] {
    return SessionPanel.all().map((p) => new SessionItem(p));
  }
}
