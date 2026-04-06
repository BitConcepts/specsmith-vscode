// SPDX-License-Identifier: MIT
// Copyright (c) 2026 BitConcepts, LLC. All rights reserved.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// ── Tree item types ──────────────────────────────────────────────────────────

export class ProjectItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly kind: 'project' | 'doc' | 'session',
    public readonly fsPath?: string,
  ) {
    super(label, collapsibleState);
    this.contextValue = kind;
    if (fsPath) {
      this.resourceUri = vscode.Uri.file(fsPath);
    }
  }
}

// ── Project docs to surface under each project ───────────────────────────────

const PROJECT_DOCS: Array<{ rel: string; icon: string }> = [
  { rel: 'REQUIREMENTS.md',          icon: 'list-unordered'  },
  { rel: 'AGENTS.md',                icon: 'hubot'           },
  { rel: 'docs/architecture.md',     icon: 'file-code'       },
  { rel: 'docs/REQUIREMENTS.md',     icon: 'list-unordered'  },
  { rel: 'LEDGER.md',                icon: 'history'         },
  { rel: '.specsmith/config.yml',    icon: 'settings-gear'   },
];

// ── TreeDataProvider ─────────────────────────────────────────────────────────

export class ProjectTreeProvider
  implements vscode.TreeDataProvider<ProjectItem>, vscode.Disposable {

  private readonly _change = new vscode.EventEmitter<ProjectItem | undefined | void>();
  readonly onDidChangeTreeData = this._change.event;

  private _projects: string[];

  constructor(private readonly context: vscode.ExtensionContext) {
    // Persisted project list + current workspace folders
    const saved = context.globalState.get<string[]>('specsmith.projects', []);
    const wsFolders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const merged = [...new Set([...wsFolders, ...saved])];
    this._projects = merged.filter((p) => fs.existsSync(p));
    this._persist();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  addProject(dirPath: string): void {
    if (!this._projects.includes(dirPath)) {
      this._projects.push(dirPath);
      this._persist();
      this.refresh();
    }
  }

  removeProject(dirPath: string): void {
    this._projects = this._projects.filter((p) => p !== dirPath);
    this._persist();
    this.refresh();
  }

  refresh(): void {
    this._change.fire();
  }

  dispose(): void {
    this._change.dispose();
  }

  // ── TreeDataProvider impl ─────────────────────────────────────────────────

  getTreeItem(element: ProjectItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ProjectItem): ProjectItem[] {
    if (!element) {
      // Root level — list all projects
      return this._projects
        .filter((p) => fs.existsSync(p))
        .map((p) => {
          const item = new ProjectItem(
            path.basename(p),
            vscode.TreeItemCollapsibleState.Collapsed,
            'project',
            p,
          );
          item.description = p;
          item.iconPath = new vscode.ThemeIcon('folder');
          item.tooltip = p;
          return item;
        });
    }

    if (element.kind === 'project' && element.fsPath) {
      const dir = element.fsPath;
      const children: ProjectItem[] = [];

      for (const { rel, icon } of PROJECT_DOCS) {
        const filePath = path.join(dir, rel);
        if (fs.existsSync(filePath)) {
          const item = new ProjectItem(
            path.basename(rel),
            vscode.TreeItemCollapsibleState.None,
            'doc',
            filePath,
          );
          item.iconPath = new vscode.ThemeIcon(icon);
          item.description = rel.includes('/') ? path.dirname(rel) : undefined;
          item.command = {
            command: 'vscode.open',
            title:   'Open',
            arguments: [vscode.Uri.file(filePath)],
          };
          children.push(item);
        }
      }

      return children;
    }

    return [];
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _persist(): void {
    void this.context.globalState.update('specsmith.projects', this._projects);
  }
}
