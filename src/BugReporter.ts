// SPDX-License-Identifier: MIT
// Copyright (c) 2026 BitConcepts, LLC. All rights reserved.
/**
 * BugReporter — in-extension GitHub issue reporter backed by the `gh` CLI.
 *
 * Flow:
 *  1. Check if `gh` is available and the user is authenticated.
 *  2. Search existing open issues for a duplicate (title similarity).
 *  3. If found: offer to add a comment with additional context.
 *  4. If not found: create a new issue.
 *  5. Show the user the issue URL.
 *  6. If `gh` is unavailable: copy the report to the clipboard and show manual
 *     filing instructions.
 */

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as os from 'os';

const REPO = 'BitConcepts/specsmith-vscode';

// ── gh availability ────────────────────────────────────────────────────────────

/** Returns true if the `gh` CLI is on PATH and the user is authenticated. */
async function _ghAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    cp.exec('gh auth status', { timeout: 5000 }, (err) => resolve(!err));
  });
}

// ── Issue search ───────────────────────────────────────────────────────────────

interface GhIssue {
  number: number;
  title: string;
  url: string;
}

/** Search open issues for potential duplicates. Returns up to 5 matches. */
async function _searchIssues(keywords: string): Promise<GhIssue[]> {
  return new Promise((resolve) => {
    const query = keywords.replace(/[^a-zA-Z0-9 _-]/g, ' ').slice(0, 80);
    const cmd = `gh issue list --repo ${REPO} --state open --search "${query}" --json number,title,url --limit 5`;
    cp.exec(cmd, { timeout: 8000 }, (err, stdout) => {
      if (err || !stdout.trim()) { resolve([]); return; }
      try {
        const issues = JSON.parse(stdout) as GhIssue[];
        resolve(Array.isArray(issues) ? issues : []);
      } catch { resolve([]); }
    });
  });
}

// ── Issue creation ─────────────────────────────────────────────────────────────

/** Create a new GitHub issue. Returns the issue URL or null on failure. */
async function _createIssue(title: string, body: string): Promise<string | null> {
  return new Promise((resolve) => {
    // Write body to a temp file to avoid shell escaping issues
    const tmp = require('path').join(os.tmpdir(), `specsmith-bug-${Date.now()}.md`);
    require('fs').writeFileSync(tmp, body, 'utf8');
    const cmd = `gh issue create --repo ${REPO} --title "${title.replace(/"/g, "'")}" --body-file "${tmp}" --label bug`;
    cp.exec(cmd, { timeout: 15000 }, (err, stdout) => {
      try { require('fs').unlinkSync(tmp); } catch { /* ignore */ }
      if (err) { resolve(null); return; }
      const url = stdout.trim().split(/\s+/).find((s) => s.startsWith('http')) ?? null;
      resolve(url);
    });
  });
}

/** Add a comment to an existing issue. Returns true on success. */
async function _commentIssue(issueNumber: number, comment: string): Promise<boolean> {
  return new Promise((resolve) => {
    const tmp = require('path').join(os.tmpdir(), `specsmith-comment-${Date.now()}.md`);
    require('fs').writeFileSync(tmp, comment, 'utf8');
    const cmd = `gh issue comment ${issueNumber} --repo ${REPO} --body-file "${tmp}"`;
    cp.exec(cmd, { timeout: 10000 }, (err) => {
      try { require('fs').unlinkSync(tmp); } catch { /* ignore */ }
      resolve(!err);
    });
  });
}

// ── Clipboard fallback ────────────────────────────────────────────────────────

async function _clipboardFallback(title: string, body: string): Promise<void> {
  const report = `**Title:** ${title}\n\n${body}`;
  await vscode.env.clipboard.writeText(report);
  const action = await vscode.window.showInformationMessage(
    'specsmith: `gh` CLI not available or not authenticated. Bug report copied to clipboard.',
    'Open GitHub Issues',
  );
  if (action === 'Open GitHub Issues') {
    await vscode.env.openExternal(
      vscode.Uri.parse(`https://github.com/${REPO}/issues/new`),
    );
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface BugReport {
  title: string;
  /** Short description shown in the issue body (plain text). */
  summary: string;
  /** Full error/detail text for the issue body. */
  detail?: string;
  /** specsmith version if available. */
  specsmithVersion?: string;
  /** OS info. */
  platform?: string;
}

/**
 * File a bug report interactively.
 *
 * Checks for duplicates first, then either comments on an existing issue or
 * creates a new one.  Falls back to clipboard if `gh` is unavailable.
 */
export async function reportBug(report: BugReport, skipConsent = false): Promise<void> {
  const { title, summary, detail, specsmithVersion, platform } = report;

  // ── Consent gate ────────────────────────────────────────────────────────────
  // Never submit data without explicit user confirmation.
  if (!skipConsent) {
    const privacyNote = detail
      ? 'The error detail text may contain local file paths from your machine.'
      : '';
    const ans = await vscode.window.showInformationMessage(
      `Report this bug to GitHub (BitConcepts/specsmith-vscode)?\n\n` +
      `What will be included: error summary, specsmith version, VS Code version, OS platform.\n` +
      (privacyNote ? privacyNote + '\n' : '') +
      `GitHub will search for a duplicate issue first.`,
      { modal: true },
      'Send Report',
    );
    if (ans !== 'Send Report') { return; } // user cancelled — do nothing
  }

  // Build a rich issue body
  const body = [
    `## Summary`,
    summary,
    detail ? `\n## Error Detail\n\`\`\`\n${detail.slice(0, 3000)}${detail.length > 3000 ? '\n…(truncated)' : ''}\n\`\`\`` : '',
    `\n## Environment`,
    `- **specsmith**: ${specsmithVersion ?? 'unknown'}`,
    `- **Platform**: ${platform ?? `${os.platform()} ${os.release()}`}`,
    `- **VS Code**: ${vscode.version}`,
    `- **Extension**: specsmith-vscode`,
  ].filter(Boolean).join('\n');

  // Check gh availability
  const ghOk = await _ghAvailable();
  if (!ghOk) {
    await _clipboardFallback(title, body);
    return;
  }

  // Search for duplicates
  const keywords = title.replace(/[^a-zA-Z0-9 ]/g, ' ').split(' ').filter((w) => w.length > 3).slice(0, 6).join(' ');
  const existing = await _searchIssues(keywords);

  if (existing.length > 0) {
    // Show existing issues and let user decide
    const items: vscode.QuickPickItem[] = [
      ...existing.map((iss) => ({
        label: `#${iss.number}: ${iss.title.slice(0, 70)}`,
        description: iss.url,
        detail: 'Add a comment to this existing issue',
      })),
      {
        label: '$(add) Create new issue',
        description: '',
        detail: 'File a new issue (none of the above match)',
      },
    ];

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Similar issues found — comment on one or create new?',
      matchOnDetail: true,
    });
    if (!picked) { return; } // user cancelled

    if (picked.label.startsWith('$(add)')) {
      // Create new
      const url = await _createIssue(title, body);
      _showResult(url, 'created');
    } else {
      // Comment on existing
      const issueNumber = parseInt(picked.label.slice(1), 10);
      if (isNaN(issueNumber)) { return; }
      const comment = `## Additional occurrence\n\n${body}`;
      const ok = await _commentIssue(issueNumber, comment);
      if (ok) {
        const url = existing.find((i) => i.number === issueNumber)?.url;
        _showResult(url ?? null, 'commented');
      } else {
        void vscode.window.showWarningMessage('specsmith: could not add comment. Check gh auth status.');
      }
    }
  } else {
    // No duplicates — create directly
    const url = await _createIssue(title, body);
    _showResult(url, 'created');
  }
}

function _showResult(url: string | null, action: 'created' | 'commented'): void {
  if (!url) {
    void vscode.window.showWarningMessage('specsmith: issue could not be filed. Check `gh auth status`.');
    return;
  }
  const msg = action === 'created'
    ? `Bug report filed: ${url}`
    : `Comment added: ${url}`;
  void vscode.window.showInformationMessage(msg, 'Open Issue').then((a) => {
    if (a === 'Open Issue') { void vscode.env.openExternal(vscode.Uri.parse(url)); }
  });
}

// ── Interactive prompt (no pre-built title/body) ──────────────────────────────

/**
 * Prompt the user for a bug title/description interactively (called from the
 * command palette or a button in the session panel).
 */
export async function promptAndReportBug(opts?: {
  prefillTitle?: string;
  prefillDetail?: string;
  specsmithVersion?: string;
}): Promise<void> {
  const title = await vscode.window.showInputBox({
    prompt: 'Bug report title (one-line summary)',
    placeHolder: 'e.g. Audit crashes with UnicodeDecodeError on Windows',
    value: opts?.prefillTitle ?? '',
    validateInput: (v) => v.trim().length < 5 ? 'Please provide at least 5 characters' : undefined,
  });
  if (!title) { return; }

  const summary = await vscode.window.showInputBox({
    prompt: 'Brief description (what went wrong? what did you expect?)',
    placeHolder: 'Steps to reproduce, expected vs actual behaviour…',
    value: '',
  });
  if (summary === undefined) { return; }

  // skipConsent=false so reportBug still shows the final confirmation modal
  await reportBug(
    {
      title: title.trim(),
      summary: summary.trim() || '(no description provided)',
      detail: opts?.prefillDetail,
      specsmithVersion: opts?.specsmithVersion,
    },
    false,
  );
}
