// SPDX-License-Identifier: MIT
// Copyright (c) 2026 BitConcepts, LLC. All rights reserved.
import * as vscode from 'vscode';
import * as cp from 'child_process';

const POLL_MS = 120_000; // 2 minutes

export class EpistemicBar implements vscode.Disposable {
  private readonly _item: vscode.StatusBarItem;
  private _timer: ReturnType<typeof setInterval> | undefined;

  constructor(context: vscode.ExtensionContext) {
    this._item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this._item.text    = '🧠 —';
    this._item.tooltip = 'specsmith epistemic health — click to run Audit';
    this._item.command = 'specsmith.runAudit';
    this._item.show();

    context.subscriptions.push(this._item);

    // Initial check after a short delay (let specsmith load first)
    setTimeout(() => this._check(), 5000);
    this._timer = setInterval(() => this._check(), POLL_MS);
  }

  // ── Public ─────────────────────────────────────────────────────────────────

  /** Immediately refresh (call after an audit/validate run). */
  public refresh(): void {
    this._check();
  }

  dispose(): void {
    if (this._timer !== undefined) {
      clearInterval(this._timer);
      this._timer = undefined;
    }
    this._item.dispose();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _check(): void {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) { return; }

    const cfg      = vscode.workspace.getConfiguration('specsmith');
    const execPath = cfg.get<string>('executablePath', 'specsmith');
    const dir      = folders[0].uri.fsPath;

    const proc = cp.spawn(execPath, ['epistemic-audit', '--project-dir', dir, '--brief'], {
      timeout: 30_000,
      env: process.env,
    });

    let out = '';
    proc.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString(); });

    proc.on('exit', () => {
      const scoreMatch = out.match(/C=([\d.]+)/);
      const belowMatch = out.match(/(\d+)\s+low/);

      if (scoreMatch) {
        const score = parseFloat(scoreMatch[1]);
        const below = belowMatch ? parseInt(belowMatch[1], 10) : 0;

        if (below === 0) {
          this._item.text              = `🧠 C=${score.toFixed(2)} ✓`;
          this._item.backgroundColor   = undefined;
          this._item.tooltip           = `specsmith: epistemic health OK (C=${score.toFixed(2)})`;
        } else {
          this._item.text              = `🧠 C=${score.toFixed(2)} ⚠${below}`;
          this._item.backgroundColor   = new vscode.ThemeColor('statusBarItem.warningBackground');
          this._item.tooltip           = `specsmith: ${below} requirement(s) with low confidence (C=${score.toFixed(2)})`;
        }
      } else {
        // specsmith not configured yet or no REQUIREMENTS.md — show neutral
        this._item.text            = '🧠 —';
        this._item.backgroundColor = undefined;
        this._item.tooltip         = 'specsmith: no epistemic data (run specsmith init first)';
      }
    });

    proc.on('error', () => {
      // specsmith not on PATH — show silently
      this._item.text = '🧠 ·';
    });
  }
}
