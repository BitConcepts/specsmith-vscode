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
import { showGovernancePanel, closeGovernancePanel } from './GovernancePanel';
import { showSettingsPanel, closeSettingsPanel } from './SettingsPanel';
import { fetchModels } from './ModelRegistry';
import { OllamaManager, TASK_SUGGESTIONS } from './OllamaManager';
import { SessionStatus } from './types';
import { promptAndReportBug } from './BugReporter';
import { setVenvDir } from './VenvManager';

// ── Activation ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {

  // Apply custom venv path from settings immediately so all modules pick it up
  const _applyVenvPath = () =>
    setVenvDir(vscode.workspace.getConfiguration('specsmith').get<string>('envPath', ''));
  _applyVenvPath();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('specsmith.envPath')) { _applyVenvPath(); }
    }),
  );

  // ── Sidebar: unified Projects
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
    onSessionStatusChange((_panel: SessionPanel, status: SessionStatus) => {
      sessionTree.refresh();
      projectTree.refresh(); // update active indicator
      // Close Settings when last session closes, but keep GovernancePanel open
      // (it's project-level, not session-level)
      if (status === 'inactive' && SessionPanel.all().length === 0) {
        closeSettingsPanel();
      }
    }),
  );

  // ── Helpers ───────────────────────────────────────────────────────────────

  function defaultCfg() {
    const cfg = vscode.workspace.getConfiguration('specsmith');
    return {
      provider: cfg.get<string>('defaultProvider', 'ollama'),
      model:    cfg.get<string>('defaultModel', ''),
    };
  }

  async function openSession(projectDir: string): Promise<void> {
    // Venv is required — block session start if not present.
    const venvReady = await _ensureVenv(context);
    if (!venvReady) { return; }

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
    projectTree.refresh();
    projectTree.addProject(projectDir);
    // Open project settings alongside the session
    showGovernancePanel(
      context,
      projectDir,
      (text) => SessionPanel.current()?.sendCommand(text),
      async () => { await openSession(projectDir); },
    );
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
      // ── Step 1: project name ──────────────────────────────────────────────
      const name = await vscode.window.showInputBox({
        prompt: 'New project name',
        placeHolder: 'my-project',
        validateInput: (v) => v.trim() ? undefined : 'Name cannot be empty',
      });
      if (!name) { return; }

      // ── Step 2: project type ──────────────────────────────────────────────
      const TYPE_CHOICES: vscode.QuickPickItem[] = [
        { label: 'cli-python',         description: 'Python CLI application' },
        { label: 'library-python',     description: 'Python library / package' },
        { label: 'web-frontend',       description: 'Web front-end (JS/TS)' },
        { label: 'fullstack-js',       description: 'Full-stack JavaScript' },
        { label: 'backend-frontend',   description: 'Python backend + web frontend' },
        { label: 'api-specification',  description: 'REST / GraphQL API spec' },
        { label: 'spec-document',      description: 'Technical specification document' },
        { label: 'fpga-rtl',           description: 'FPGA / RTL hardware project' },
        { label: 'embedded-c',         description: 'Embedded C / C++ firmware' },
        { label: 'yocto-linux',        description: 'Yocto / OpenEmbedded Linux' },
        { label: 'monorepo',           description: 'Monorepo (multiple packages)' },
        { label: 'epistemic-pipeline', description: 'AEE epistemic pipeline' },
        { label: 'knowledge-engineering', description: 'Knowledge engineering / ontology' },
      ];
      const typePick = await vscode.window.showQuickPick(TYPE_CHOICES, {
        placeHolder: 'Select project type',
        matchOnDescription: true,
      });
      if (!typePick) { return; }

      // ── Step 3: VCS platform ─────────────────────────────────────────────
      const vcsPick = await vscode.window.showQuickPick(
        [
          { label: 'github',    description: 'GitHub' },
          { label: 'gitlab',    description: 'GitLab' },
          { label: 'bitbucket', description: 'Bitbucket' },
          { label: '',          description: 'None / other' },
        ],
        { placeHolder: 'VCS platform (for CI/CD templates)' },
      );
      if (!vcsPick) { return; }

      // ── Step 4: output directory ──────────────────────────────────────────
      const uri = await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        openLabel: 'Create project here',
      });
      if (!uri?.[0]) { return; }

      const cfg  = vscode.workspace.getConfiguration('specsmith');
      const exec = cfg.get<string>('executablePath', 'specsmith');
      const projectDir = uri[0].fsPath;

      // ── Step 5: confirm ───────────────────────────────────────────────────
      const preview = [
        `Name:     ${name}`,
        `Type:     ${typePick.label} — ${typePick.description}`,
        `VCS:      ${vcsPick.label || 'none'}`,
        `Location: ${projectDir}`,
      ].join('\n');
      const go = await vscode.window.showInformationMessage(
        `Create specsmith project?\n\n${preview}`,
        { modal: true },
        'Create',
      );
      if (go !== 'Create') { return; }

      // ── Step 6: run specsmith init via terminal ───────────────────────────
      // specsmith init is interactive; use terminal so user can answer prompts.
      // Pre-fill name in env so the CLI can potentially pick it up, but the
      // user will confirm all options interactively in the terminal.
      const term = vscode.window.createTerminal({ name: 'specsmith init', shellPath: _shellPath() });
      // Use --config if a scaffold.yml exists with the right options, otherwise
      // fall back to interactive init with name/type/vcs pre-filled as defaults.
      term.sendText(
        `${exec} init --output-dir "${projectDir}"`,
      );
      term.show();
      projectTree.addProject(projectDir);

      // Offer to open a session once init is done
      void vscode.window.showInformationMessage(
        `specsmith init running in terminal. Open a session when it's done?`,
        'Open Session',
      ).then((a) => {
        if (a === 'Open Session') { void openSession(projectDir); }
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('specsmith.importProject', async () => {
      // ── Step 1: pick folder ───────────────────────────────────────────────
      const uri = await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        openLabel: 'Import this project',
      });
      if (!uri?.[0]) { return; }

      const cfg  = vscode.workspace.getConfiguration('specsmith');
      const exec = cfg.get<string>('executablePath', 'specsmith');
      const projectDir = uri[0].fsPath;

      // ── Step 2: pre-scan via specsmith scan ──────────────────────────────
      let scanSummary = '';
      try {
        const { execSync } = require('child_process') as typeof import('child_process');
        const result = execSync(
          `"${exec}" scan --project-dir "${projectDir}" --json`,
          { timeout: 15000, encoding: 'utf8' },
        ) as string;
        const scan = JSON.parse(result);
        scanSummary = [
          `Name:     ${scan.name ?? path.basename(projectDir)}`,
          `Type:     ${scan.type_label ?? scan.type ?? 'unknown'}`,
          `Language: ${(scan.languages ?? []).slice(0, 3).join(', ') || 'unknown'}`,
          `VCS:      ${scan.vcs_platform ?? 'unknown'}`,
        ].join('\n');
      } catch {
        scanSummary = `Location: ${projectDir}\n(Could not pre-scan project — will detect on import.)`;
      }

      // ── Step 3: confirm ───────────────────────────────────────────────────
      const mode = await vscode.window.showQuickPick(
        [
          { label: 'Standard import', description: 'Generate governance overlay only, keep existing code' },
          { label: 'Guided import',   description: 'Also run architecture interview after import' },
          { label: 'Dry run',         description: 'Preview what will be created without writing files' },
        ],
        { placeHolder: `Importing: ${path.basename(projectDir)}\n${scanSummary}` },
      );
      if (!mode) { return; }

      const guided = mode.label === 'Guided import';
      const dryRun = mode.label === 'Dry run';

      // ── Step 4: run specsmith import in terminal (auto-yes in non-dry mode) ─
      const flags = [
        dryRun  ? '--dry-run' : '--yes',
        guided  ? '--guided'  : '',
      ].filter(Boolean).join(' ');

      const term = vscode.window.createTerminal({ name: 'specsmith import', shellPath: _shellPath() });
      term.sendText(`${exec} import --project-dir "${projectDir}" ${flags}`);
      term.show();
      projectTree.addProject(projectDir);

      if (!dryRun) {
        void vscode.window.showInformationMessage(
          'specsmith import running. Open a session when done?',
          'Open Session',
        ).then((a) => {
          if (a === 'Open Session') { void openSession(projectDir); }
        });
      }
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

  // Startup: privacy notice (first install only), fetch models, update check, venv check
  void _showFirstRunPrivacyNotice(context);
  void _startupFetchModels(context);
  void _checkForSpecsmithUpdate(context);
  void _checkForOllamaUpdate();
  void _autoOpenGovernancePanel(context, openSession);
  void _notifyIfVenvMissing(context);

  // Keep Settings panel in sync when workspace folders change
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
        await vscode.window.showTextDocument(vscode.Uri.file(found), { viewColumn: vscode.ViewColumn.One });
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
      // Always direct to Settings panel — updates should use the venv, not system pipx
      void vscode.commands.executeCommand('specsmith.showSettings');
      void vscode.window.showInformationMessage(
        'Use the Environment tab in specsmith Settings to update. This ensures the venv (not system-wide pipx) is used.',
      );
    }),
  );

  // ── Commands: Report Issue (rich multi-step) ──────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('specsmith.reportIssue', async () => {
      const version = _probeVersion(
        vscode.workspace.getConfiguration('specsmith').get<string>('executablePath', 'specsmith') ?? 'specsmith',
      ) ?? 'unknown';

      // ── Step 1: issue type ─────────────────────────────────────────────
      const issueType = await vscode.window.showQuickPick(
        [
          { label: '$(bug) Bug Report',              description: 'Something is broken or behaving incorrectly', value: 'bug' },
          { label: '$(lightbulb) Feature Request',   description: 'A new capability or improvement idea',       value: 'enhancement' },
          { label: '$(question) Question / Feedback', description: 'Not a bug, just a question or suggestion',   value: 'question' },
        ],
        { placeHolder: 'What kind of issue is this?' },
      ) as (vscode.QuickPickItem & { value: string }) | undefined;
      if (!issueType) { return; }

      // ── Step 2: which repo ──────────────────────────────────────────────
      const repoPick = await vscode.window.showQuickPick(
        [
          {
            label:       '$(terminal) specsmith CLI',
            description: 'github.com/BitConcepts/specsmith',
            detail:      'CLI commands, agent behaviour, audit/validate/doctor, tool crashes, scaffolding',
            value:       'specsmith',
          },
          {
            label:       '$(extensions) specsmith-vscode Extension',
            description: 'github.com/BitConcepts/specsmith-vscode',
            detail:      'VS Code UI, session panel, sidebar, governance panel, bug reporter, file injection',
            value:       'specsmith-vscode',
          },
          {
            label:       '$(question) Not sure',
            description: 'File under specsmith-vscode and we will triage',
            value:       'specsmith-vscode',
          },
        ],
        { placeHolder: 'Which part of specsmith does this affect?', matchOnDetail: true },
      ) as (vscode.QuickPickItem & { value: string }) | undefined;
      if (!repoPick) { return; }
      const targetRepo = repoPick.value;

      // ── Step 3: title ──────────────────────────────────────────────────
      const TITLE_HINTS: Record<string, string> = {
        bug:         'e.g. “audit crashes with UnicodeDecodeError on Windows”',
        enhancement: 'e.g. “add support for multi-file drag-and-drop”',
        question:    'e.g. “how do I use specsmith with a monorepo?”',
      };
      const title = await vscode.window.showInputBox({
        prompt: `${issueType.label.replace(/^\$\(.*?\) /, '')} title`,
        placeHolder: TITLE_HINTS[issueType.value] ?? 'A clear, one-line summary',
        validateInput: (v) => v.trim().length < 5 ? 'Please write at least 5 characters' : undefined,
      });
      if (!title) { return; }

      // ── Step 4: description ────────────────────────────────────────────
      const DESC_HINTS: Record<string, string> = {
        bug:         'What happened? What did you expect? Include any error messages.',
        enhancement: 'What problem would this solve? What would the ideal behaviour look like?',
        question:    'What are you trying to do? What have you already tried?',
      };
      const description = await vscode.window.showInputBox({
        prompt: DESC_HINTS[issueType.value],
        placeHolder: 'Be as specific as possible. The more detail, the faster we can help.',
      });
      if (description === undefined) { return; }

      // ── Step 5: steps to reproduce (bugs only) ───────────────────────────
      let stepsToRepro = '';
      if (issueType.value === 'bug') {
        stepsToRepro = await vscode.window.showInputBox({
          prompt: 'Steps to reproduce (optional but very helpful)',
          placeHolder: '1. Open a session  2. Run doctor  3. See error',
        }) ?? '';
      }

      // ── Step 6: include recent chat? ───────────────────────────────────
      let chatContext = '';
      const session = SessionPanel.current();
      if (session) {
        const recentMsgs = session.getRecentMessages(8);
        if (recentMsgs) {
          const includeChatPick = await vscode.window.showQuickPick(
            [
              { label: '$(comment-discussion) Yes — include last 8 messages', description: 'Helps reproduce context-sensitive issues', value: 'yes' },
              { label: '$(circle-slash) No — leave chat out',                 description: 'Keep the report minimal',                   value: 'no' },
            ],
            { placeHolder: 'Include recent chat messages in the report? (they may contain project details)' },
          ) as (vscode.QuickPickItem & { value: string }) | undefined;
          if (includeChatPick?.value === 'yes') {
            chatContext = recentMsgs;
          }
        }
      }

      // ── Step 7: build issue body ───────────────────────────────────────────
      const bodyParts: string[] = [
        `## Description`,
        description || '(no description provided)',
      ];
      if (stepsToRepro) {
        bodyParts.push(`\n## Steps to Reproduce`, stepsToRepro);
      }
      if (chatContext) {
        bodyParts.push(`\n## Recent Chat Context`, '```', chatContext, '```');
      }
      bodyParts.push(
        `\n## Environment`,
        `- **specsmith**: ${version}`,
        `- **VS Code**: ${vscode.version}`,
        `- **Extension**: specsmith-vscode`,
        `- **OS**: ${process.platform}`,
      );
      const issueBody = bodyParts.join('\n');

      // ── Step 8: consent + file ─────────────────────────────────────────
      const { reportBug } = await import('./BugReporter');
      await reportBug(
        {
          title:            `${title.trim()}`,
          summary:          description || '(no description provided)',
          detail:           issueBody,
          specsmithVersion: version,
          extraContext:     {
            'Issue type': issueType.value,
            ...(stepsToRepro ? { 'Steps to reproduce': stepsToRepro } : {}),
            ...(chatContext   ? { 'Chat context included': 'yes (last 8 messages)' } : {}),
          },
        },
        false,
        targetRepo,
      );
      // Confirm in the active chat session
      const activeSession = SessionPanel.current();
      if (activeSession) {
        activeSession.sendCommand(`[system] Bug report filed: ${title.trim()}`);
      }
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

  // ── Commands: Settings panel ─────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('specsmith.showSettings', () => {
      showSettingsPanel(context);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('specsmith.showGovernance', (item?: ProjectItem) => {
      // Accept project dir from tree item click, current session, or workspace
      const projectDir = item?.fsPath
        ?? SessionPanel.current()?.projectDir
        ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!projectDir) {
        void vscode.window.showWarningMessage('specsmith: add a project folder first.');
        return;
      }
      showGovernancePanel(
        context,
        projectDir,
        // sendToSession: uses current session if one exists for this project
        (text) => {
          const s = SessionPanel.all().find(p => p.projectDir === projectDir)
            ?? SessionPanel.current();
          s?.sendCommand(text);
        },
        // openSession: auto-creates a session for this project
        async () => { await openSession(projectDir); },
      );
    }),
  );

  // ── Commands: Help ──────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('specsmith.showHelp', () => showHelp(context)),
  );

  // ── Commands: Bug reporter ───────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'specsmith.reportBug',
      (prefillTitle?: string, prefillDetail?: string, targetRepo?: string) => {
        const version = _probeVersion(
          vscode.workspace.getConfiguration('specsmith').get<string>('executablePath', 'specsmith') ?? 'specsmith',
        ) ?? undefined;
        if (prefillTitle && prefillDetail && targetRepo) {
          // Called from webview crash card with pre-collected diagnostics——go straight to reportBug (still shows consent modal).
          void import('./BugReporter').then(({ reportBug }) =>
            reportBug({ title: prefillTitle, summary: prefillDetail.split('\n')[0], detail: prefillDetail, specsmithVersion: version }, false, targetRepo),
          );
        } else {
          void promptAndReportBug({ prefillTitle, prefillDetail, specsmithVersion: version });
        }
      },
    ),
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
 * Show a one-time privacy notice on first install.
 * Stores a flag in globalState so it only fires once.
 */
async function _showFirstRunPrivacyNotice(context: vscode.ExtensionContext): Promise<void> {
  const KEY = 'specsmith.privacyNoticeSeen.v1';
  if (context.globalState.get<boolean>(KEY)) { return; }
  await context.globalState.update(KEY, true);

  const action = await vscode.window.showInformationMessage(
    'specsmith collects no telemetry. ' +
    'Your messages are sent only to the LLM provider you configure (Anthropic, OpenAI, Gemini, Ollama, etc.). ' +
    'The optional bug reporter requires your explicit consent before filing anything.',
    'View Privacy Policy',
    'OK',
  );
  if (action === 'View Privacy Policy') {
    void vscode.env.openExternal(
      vscode.Uri.parse('https://github.com/BitConcepts/specsmith-vscode/blob/main/PRIVACY.md'),
    );
  }
}

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

/** Return the preferred shell for terminal commands. Always PowerShell on Windows. */
function _shellPath(): string | undefined {
  if (process.platform === 'win32') { return 'powershell.exe'; }
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

/** Check if a newer specsmith is available on every VS Code startup.
 *  Uses the venv version (not system-wide) for comparison.
 *  Respects `specsmith.checkForUpdatesOnStart` setting (default: true). */
async function _checkForSpecsmithUpdate(context: vscode.ExtensionContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('specsmith');
  if (cfg.get<boolean>('checkForUpdatesOnStart', true) === false) { return; }
  await context.globalState.update('specsmith.lastUpdateCheck', Date.now());

  await new Promise((r) => setTimeout(r, 5000)); // wait for startup
  try {
    // Use venv version first (the authoritative install), fall back to PATH
    const { getVenvSpecsmithVersion } = await import('./VenvManager');
    const venvVer = getVenvSpecsmithVersion();
    let current: string | null = venvVer;
    if (!current) {
      const execPath = cfg.get<string>('executablePath', 'specsmith');
      current = _probeVersion(execPath);
    }
    if (!current) { return; } // specsmith not installed

    // Extract just the version number (may be 'specsmith, version X.Y.Z')
    const verMatch = current.match(/(\d+\.\d+\.\d+(?:\.dev\d+)?)/);
    const installedVer = verMatch?.[1] ?? current;

    // Fetch latest from PyPI
    const channel = cfg.get<string>('releaseChannel', 'stable');
    const https = await import('https');
    const res = await new Promise<string>((resolve, reject) => {
      const req = https.get(
        'https://pypi.org/pypi/specsmith/json',
        { timeout: 8000 },
        (r) => { let d = ''; r.on('data', (c: Buffer) => { d += c; }); r.on('end', () => resolve(d)); },
      );
      req.on('error', reject);
    });
    const pypiData = JSON.parse(res) as { info?: { version?: string }; releases?: Record<string, unknown[]> };
    let latest: string;
    if (channel === 'pre-release') {
      const candidates = Object.keys(pypiData.releases ?? {})
        .filter(v => (pypiData.releases?.[v] as unknown[])?.length > 0)
        .sort();
      latest = candidates[candidates.length - 1] ?? pypiData.info?.version ?? '';
    } else {
      latest = pypiData.info?.version ?? '';
    }
    if (!latest || latest === installedVer) { return; }

    // Simple semver comparison
    const toNum = (v: string) => v.split('.').map(Number);
    const a = toNum(latest), b = toNum(installedVer);
    let isNewer = false;
    for (let i = 0; i < 3; i++) {
      if ((a[i] ?? 0) > (b[i] ?? 0)) { isNewer = true; break; }
      if ((a[i] ?? 0) < (b[i] ?? 0)) { break; }
    }
    if (!isNewer) { return; }

    // Save to globalState so SettingsPanel shows the update on first render
    await context.globalState.update('specsmith.availableVersion', latest);

    const ans = await vscode.window.showInformationMessage(
      `specsmith ${latest} available (you have ${installedVer}). Update via Settings.`,
      'Open Settings',
      'Later',
    );
    if (ans === 'Open Settings') {
      void vscode.commands.executeCommand('specsmith.showSettings');
    }
  } catch { /* silent — don't crash startup */ }
}

/** Check Ollama version + model staleness on startup.
 *  Respects `specsmith.checkOllamaOnStart` setting (default: true). */
async function _checkForOllamaUpdate(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('specsmith');
  if (cfg.get<boolean>('checkOllamaOnStart', true) === false) { return; }

  await new Promise((r) => setTimeout(r, 8000)); // wait for startup to settle
  try {
    const { OllamaManager } = await import('./OllamaManager');
    const running = await OllamaManager.isRunning();
    if (!running) { return; } // Ollama not running

    // Check Ollama version
    const http = await import('http');
    const installed = await new Promise<string | null>((resolve) => {
      let d = '';
      http.get('http://localhost:11434/api/version', (r) => {
        r.on('data', (c: Buffer) => { d += c.toString(); });
        r.on('end', () => { try { resolve((JSON.parse(d) as { version?: string }).version ?? null); } catch { resolve(null); } });
      }).on('error', () => resolve(null));
    });

    // Check model staleness
    const models = await new Promise<Array<{ name: string; modified_at: string }>>((resolve) => {
      let d = '';
      http.get('http://localhost:11434/api/tags', (r) => {
        r.on('data', (c: Buffer) => { d += c.toString(); });
        r.on('end', () => { try { resolve((JSON.parse(d) as { models?: Array<{ name: string; modified_at: string }> }).models ?? []); } catch { resolve([]); } });
      }).on('error', () => resolve([]));
    });

    const STALE_MS = 30 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const staleModels = models.filter(m => {
      const pulled = m.modified_at ? new Date(m.modified_at).getTime() : 0;
      return pulled > 0 && (now - pulled) > STALE_MS;
    });

    if (staleModels.length > 0) {
      const ans = await vscode.window.showInformationMessage(
        `${staleModels.length} Ollama model(s) may have updates (pulled > 30 days ago). Open Settings to update.`,
        'Open Settings',
        'Later',
      );
      if (ans === 'Open Settings') {
        void vscode.commands.executeCommand('specsmith.showSettings');
      }
    }
  } catch { /* silent */ }
}

/**
 * Auto-open the Settings panel when VS Code starts.
 * Opens Beside the editor after a short delay so it doesn't block activation.
 * Respects a user setting to disable: specsmith.autoOpenGovernancePanel = false.
 *
 * The global Settings panel always opens (even without a project).
 * The Project Settings panel only opens when a project folder is available.
 */
async function _autoOpenGovernancePanel(
  context: vscode.ExtensionContext,
  openSession: (dir: string) => Promise<void>,
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('specsmith');
  if (cfg.get<boolean>('autoOpenGovernancePanel', true) === false) { return; }

  // Wait for VS Code to finish painting before we do anything
  await new Promise((r) => setTimeout(r, 1500));

  // Focus the specsmith sidebar first so the user sees it
  void vscode.commands.executeCommand('workbench.view.extension.specsmith');

  // Global Settings: only restore if it was previously left open
  const settingsWasOpen = context.globalState.get<boolean>('specsmith.settingsPanelOpen', false);
  if (settingsWasOpen) {
    showSettingsPanel(context);
  }

  // Project Settings only when a project folder is available
  const workspaceDir =
    SessionPanel.current()?.projectDir
    ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  if (workspaceDir) {
    showGovernancePanel(
      context,
      workspaceDir,
      (text) => SessionPanel.current()?.sendCommand(text),
      async () => { await openSession(workspaceDir); },
    );
  }
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

/**
 * Check that the global specsmith venv exists.  If it does not, show a modal
 * prompt offering to create it.  Returns true if the venv is ready, false if
 * the user declined or the setup is still in progress.
 *
 * This is called before every session open so nothing runs without an env.
 */
async function _ensureVenv(context: vscode.ExtensionContext): Promise<boolean> {
  const { venvExists, buildCreateVenvCommands, getGlobalVenvDir } = await import('./VenvManager');
  if (venvExists()) { return true; }

  const action = await vscode.window.showWarningMessage(
    'specsmith requires a Python environment to run agent sessions.\n\n'
    + `Environment location: ${getGlobalVenvDir()}\n\n`
    + 'Nothing will work until the environment is created.',
    { modal: true },
    'Create Environment Now',
    'Cancel',
  );
  if (action !== 'Create Environment Now') { return false; }

  const channel = vscode.workspace.getConfiguration('specsmith')
    .get<string>('releaseChannel', 'stable') as 'stable' | 'pre-release';
  const providerPkgMap: Record<string, string> = {
    anthropic: 'anthropic', openai: 'openai',
    gemini: 'google-generativeai', mistral: 'mistralai',
  };
  const providers: string[] = [];
  for (const [prov, pkg] of Object.entries(providerPkgMap)) {
    const key = await ApiKeyManager.getKey(context.secrets, prov);
    if (key) { providers.push(pkg); }
  }

  const cmds = buildCreateVenvCommands(channel, providers);
  const term = vscode.window.createTerminal({ name: 'specsmith: create environment', shellPath: _shellPath() });
  // Join with ; — works in both powershell.exe (PS5) and pwsh (PS7)
  term.sendText(cmds.join('; '));
  term.show();
  void vscode.window.showInformationMessage(
    'Creating specsmith environment in terminal. Reload VS Code when done, then open your session.',
    'Reload Now',
  ).then((a) => {
    if (a === 'Reload Now') { void vscode.commands.executeCommand('workbench.action.reloadWindow'); }
  });
  return false; // not ready yet — user must reload after setup completes
}

/**
 * Non-blocking startup notification when the global venv is missing.
 * Shown once per VS Code launch so the user knows they need to create it.
 */
async function _notifyIfVenvMissing(context: vscode.ExtensionContext): Promise<void> {
  await new Promise((r) => setTimeout(r, 3000)); // wait for startup to settle
  const { venvExists } = await import('./VenvManager');
  if (venvExists()) { return; }

  // Throttle: don't show more than once every 5 minutes (e.g. repeated reloads)
  const THROTTLE_KEY = 'specsmith.venvMissingNotified';
  const last = context.globalState.get<number>(THROTTLE_KEY, 0);
  if (Date.now() - last < 5 * 60 * 1000) { return; }
  await context.globalState.update(THROTTLE_KEY, Date.now());

  const action = await vscode.window.showWarningMessage(
    'specsmith: No environment found (~/.specsmith/venv). Create one to enable agent sessions.',
    'Create Environment',
    'Open Settings',
    'Later',
  );
  if (action === 'Create Environment') {
    void vscode.commands.executeCommand('specsmith.showSettings'); // Settings panel has the Create button
  } else if (action === 'Open Settings') {
    void vscode.commands.executeCommand('specsmith.showSettings');
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
