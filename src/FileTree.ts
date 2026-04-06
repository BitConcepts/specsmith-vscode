// SPDX-License-Identifier: MIT
// Copyright (c) 2026 BitConcepts, LLC. All rights reserved.
/**
 * FileTree — shows the file system of the active session's project directory.
 *
 * Registered as the `specsmith.files` tree view. Updates automatically
 * when the active session changes.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// Directories/patterns to always skip
const SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv',
  '.tox', 'dist', 'build', '.mypy_cache', '.pytest_cache',
  '.ruff_cache', 'out', '.vscode-test',
]);

// ── Tree item ─────────────────────────────────────────────────────────────────

export class FileItem extends vscode.TreeItem {
  public readonly kind: 'dir' | 'file';

  constructor(
    public readonly fsPath: string,
    private readonly _isDir: boolean,
  ) {
    const label = path.basename(fsPath);
    super(
      label,
      _isDir
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    this.kind         = _isDir ? 'dir' : 'file';
    this.resourceUri  = vscode.Uri.file(fsPath);
    this.contextValue = _isDir ? 'fileDir' : 'fileItem';

    if (!_isDir) {
      this.command = {
        command:   'vscode.open',
        title:     'Open File',
        arguments: [vscode.Uri.file(fsPath)],
      };
    }
  }
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class FileTreeProvider
  implements vscode.TreeDataProvider<FileItem>, vscode.Disposable {

  private readonly _change = new vscode.EventEmitter<FileItem | undefined | void>();
  readonly onDidChangeTreeData = this._change.event;

  private _root: string | undefined;

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Called when active session changes — updates the tree root. */
  setRoot(dirPath: string | undefined): void {
    this._root = dirPath;
    this._change.fire();
  }

  refresh(): void { this._change.fire(); }

  dispose(): void { this._change.dispose(); }

  // ── TreeDataProvider ───────────────────────────────────────────────────────

  getTreeItem(element: FileItem): vscode.TreeItem { return element; }

  getChildren(element?: FileItem): FileItem[] {
    const dir = element?.fsPath ?? this._root;

    if (!dir) {
      // No active session — show placeholder
      const placeholder = new FileItem(
        '',  // unused path
        false,
      );
      placeholder.label       = 'Open an agent session to browse files';
      placeholder.description = '';
      placeholder.iconPath    = new vscode.ThemeIcon('info');
      placeholder.command     = undefined;
      placeholder.contextValue = '';
      return [placeholder];
    }

    if (!element && !this._root) { return []; }

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const dirs:  FileItem[] = [];
      const files: FileItem[] = [];

      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.specsmith') { continue; }
        if (SKIP_DIRS.has(entry.name)) { continue; }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          dirs.push(new FileItem(full, true));
        } else {
          files.push(new FileItem(full, false));
        }
      }

      // Dirs first, then files, both alphabetical
      return [
        ...dirs.sort((a, b) => a.fsPath.localeCompare(b.fsPath)),
        ...files.sort((a, b) => a.fsPath.localeCompare(b.fsPath)),
      ];
    } catch {
      return [];
    }
  }
}

// ── Context menu commands (registered externally in extension.ts) ─────────────

export async function newFile(item: FileItem): Promise<void> {
  const dir = item.kind === 'dir' ? item.fsPath : path.dirname(item.fsPath);
  const name = await vscode.window.showInputBox({ prompt: 'New file name', placeHolder: 'file.txt' });
  if (!name) { return; }
  const full = path.join(dir, name);
  fs.writeFileSync(full, '');
  await vscode.window.showTextDocument(vscode.Uri.file(full));
}

export async function newFolder(item: FileItem): Promise<void> {
  const dir = item.kind === 'dir' ? item.fsPath : path.dirname(item.fsPath);
  const name = await vscode.window.showInputBox({ prompt: 'New folder name', placeHolder: 'folder' });
  if (!name) { return; }
  fs.mkdirSync(path.join(dir, name), { recursive: true });
}

export async function deleteFileItem(item: FileItem): Promise<void> {
  const ans = await vscode.window.showWarningMessage(
    `Delete ${path.basename(item.fsPath)}?`, { modal: true }, 'Delete',
  );
  if (ans !== 'Delete') { return; }
  await vscode.workspace.fs.delete(vscode.Uri.file(item.fsPath), { recursive: true, useTrash: true });
}

export async function renameFileItem(item: FileItem): Promise<void> {
  const oldName = path.basename(item.fsPath);
  const newName = await vscode.window.showInputBox({ prompt: 'Rename to', value: oldName });
  if (!newName || newName === oldName) { return; }
  const newPath = path.join(path.dirname(item.fsPath), newName);
  fs.renameSync(item.fsPath, newPath);
}
