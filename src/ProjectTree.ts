// SPDX-License-Identifier: MIT
// Copyright (c) 2026 BitConcepts, LLC. All rights reserved.
/**
 * ProjectTree — unified Projects + Files tree.
 *
 * Each project, when expanded, shows:
 *   📋 Governance   (key spec docs: REQUIREMENTS.md, AGENTS.md, etc.)
 *   ▶ src/          (full file system tree — dirs & files)
 *   ▶ docs/
 *   README.md
 *   scaffold.yml
 *   …
 *
 * Right-click context menu varies by item kind (project / governance / dir / file).
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// ── Item kinds ────────────────────────────────────────────────────────────────

// TODO(multi-domain): Projects with multiple technology domains (e.g. Yocto + Python + VHDL + C)
// can cause other VS Code extensions (e.g. BitBake/Yocto extension) to inject their own items
// into the right-click context menu (e.g. "Open recipe") when they detect relevant files.
// This is not a specsmith-vscode defect — it is caused by other extensions matching on project
// file patterns. Future work: implement domain-aware session configuration and consider gating
// specsmith tree contextValues so they don't collide with other extension context menu contributions.
// Track at: https://github.com/BitConcepts/specsmith-vscode/issues

export type ItemKind = 'project' | 'governance' | 'govdoc' | 'dir' | 'file';

// ── Dirs to skip in file tree ─────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv', '.tox',
  'dist', 'build', '.mypy_cache', '.pytest_cache', '.ruff_cache',
  'out', '.vscode-test',
]);

// Governance docs to surface under each project (in order)
const GOV_DOCS: Array<{ rel: string; icon: string }> = [
  { rel: 'REQUIREMENTS.md',       icon: 'list-unordered' },
  { rel: 'docs/REQUIREMENTS.md',  icon: 'list-unordered' },
  { rel: 'AGENTS.md',             icon: 'hubot'          },
  { rel: 'docs/architecture.md',  icon: 'file-code'      },
  { rel: 'docs/TEST_SPEC.md',     icon: 'beaker'         },
  { rel: 'LEDGER.md',             icon: 'history'        },
  { rel: 'scaffold.yml',          icon: 'settings-gear'  },
  { rel: '.specsmith/config.yml', icon: 'settings-gear'  },
];

// ── Tree item ─────────────────────────────────────────────────────────────────

export class ProjectItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly kind: ItemKind,
    public readonly fsPath?: string,
    public readonly projectRoot?: string, // root project dir (for dir/file items)
  ) {
    super(label, collapsibleState);
    this.contextValue = kind;
    if (fsPath) { this.resourceUri = vscode.Uri.file(fsPath); }
  }
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class ProjectTreeProvider
  implements vscode.TreeDataProvider<ProjectItem>, vscode.Disposable {

  private readonly _change = new vscode.EventEmitter<ProjectItem | undefined | void>();
  readonly onDidChangeTreeData = this._change.event;

  private _projects: string[];

  constructor(private readonly context: vscode.ExtensionContext) {
    const saved    = context.globalState.get<string[]>('specsmith.projects', []);
    const wsFolders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const merged    = [...new Set([...wsFolders, ...saved])];
    this._projects  = merged.filter((p) => fs.existsSync(p));
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

  refresh(): void { this._change.fire(); }
  dispose():  void { this._change.dispose(); }

  // ── TreeDataProvider ───────────────────────────────────────────────────────

  getTreeItem(el: ProjectItem): vscode.TreeItem { return el; }

  getChildren(element?: ProjectItem): ProjectItem[] {
    // ── Root: list projects ────────────────────────────────────────────────
    if (!element) {
      return this._projects
        .filter((p) => fs.existsSync(p))
        .map((p) => {
          const item = new ProjectItem(
            path.basename(p),
            vscode.TreeItemCollapsibleState.Collapsed,
            'project',
            p,
          );
          item.iconPath   = new vscode.ThemeIcon('folder');
          item.description = p;
          item.tooltip     = p;
          return item;
        });
    }

    // ── Project expanded: Governance folder + file tree ────────────────────
    if (element.kind === 'project' && element.fsPath) {
      const dir = element.fsPath;
      const children: ProjectItem[] = [];

      // Check if there are any governance docs before showing the folder
      const hasGovDocs = GOV_DOCS.some((d) => fs.existsSync(path.join(dir, d.rel)));
      if (hasGovDocs) {
        const gov = new ProjectItem(
          '📋 Governance',
          vscode.TreeItemCollapsibleState.Collapsed,
          'governance',
          dir,
        );
        gov.iconPath = new vscode.ThemeIcon('book');
        gov.tooltip  = 'Key spec docs: requirements, agents, architecture, ledger';
        children.push(gov);
      }

      children.push(...this._fileChildren(dir, dir));
      return children;
    }

    // ── Governance folder: key docs ────────────────────────────────────────
    if (element.kind === 'governance' && element.fsPath) {
      return GOV_DOCS
        .filter((d) => fs.existsSync(path.join(element.fsPath!, d.rel)))
        .map((d) => {
          const fp   = path.join(element.fsPath!, d.rel);
          const item = new ProjectItem(
            path.basename(d.rel),
            vscode.TreeItemCollapsibleState.None,
            'govdoc',
            fp,
            element.fsPath,
          );
          item.iconPath    = new vscode.ThemeIcon(d.icon);
          item.description = d.rel.includes('/') ? path.dirname(d.rel) : undefined;
          item.command     = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(fp)] };
          return item;
        });
    }

    // ── Directory: recurse file tree ───────────────────────────────────────
    if (element.kind === 'dir' && element.fsPath) {
      return this._fileChildren(element.fsPath, element.projectRoot ?? element.fsPath);
    }

    return [];
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _fileChildren(dir: string, projectRoot: string): ProjectItem[] {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const dirs:  ProjectItem[] = [];
      const files: ProjectItem[] = [];

      for (const entry of entries) {
        // Skip hidden (except .specsmith) and noise dirs
        if (entry.name.startsWith('.') && entry.name !== '.specsmith') { continue; }
        if (SKIP_DIRS.has(entry.name)) { continue; }
        const fp = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          const item = new ProjectItem(
            entry.name,
            vscode.TreeItemCollapsibleState.Collapsed,
            'dir',
            fp,
            projectRoot,
          );
          dirs.push(item);
        } else {
          const item = new ProjectItem(
            entry.name,
            vscode.TreeItemCollapsibleState.None,
            'file',
            fp,
            projectRoot,
          );
          item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(fp)] };
          files.push(item);
        }
      }

      return [
        ...dirs.sort((a, b)  => (a.fsPath ?? '').localeCompare(b.fsPath ?? '')),
        ...files.sort((a, b) => (a.fsPath ?? '').localeCompare(b.fsPath ?? '')),
      ];
    } catch { return []; }
  }

  private _persist(): void {
    void this.context.globalState.update('specsmith.projects', this._projects);
  }
}

// ── File operation helpers (called from extension.ts commands) ────────────────

export async function fileNewFile(item: ProjectItem): Promise<void> {
  const dir = item.kind === 'dir' ? item.fsPath! : path.dirname(item.fsPath!);
  const name = await vscode.window.showInputBox({ prompt: 'New file name', placeHolder: 'file.txt' });
  if (!name) { return; }
  const fp = path.join(dir, name);
  fs.writeFileSync(fp, '');
  await vscode.window.showTextDocument(vscode.Uri.file(fp));
}

export async function fileNewFolder(item: ProjectItem): Promise<void> {
  const dir = item.kind === 'dir' ? item.fsPath! : path.dirname(item.fsPath!);
  const name = await vscode.window.showInputBox({ prompt: 'New folder name', placeHolder: 'folder' });
  if (!name) { return; }
  fs.mkdirSync(path.join(dir, name), { recursive: true });
}

export async function fileDelete(item: ProjectItem): Promise<void> {
  const ans = await vscode.window.showWarningMessage(
    `Delete ${path.basename(item.fsPath!)}?`, { modal: true }, 'Delete',
  );
  if (ans !== 'Delete') { return; }
  await vscode.workspace.fs.delete(vscode.Uri.file(item.fsPath!), { recursive: true, useTrash: true });
}

export async function fileRename(item: ProjectItem): Promise<void> {
  const oldName = path.basename(item.fsPath!);
  const newName = await vscode.window.showInputBox({ prompt: 'Rename to', value: oldName });
  if (!newName || newName === oldName) { return; }
  fs.renameSync(item.fsPath!, path.join(path.dirname(item.fsPath!), newName));
}
