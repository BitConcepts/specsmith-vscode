// SPDX-License-Identifier: MIT
// Copyright (c) 2026 BitConcepts, LLC. All rights reserved.
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SpecsmithBridge } from './bridge';
import { SpecsmithEvent, WebviewMessage, SessionConfig, SessionStatus } from './types';
import { ApiKeyManager } from './ApiKeyManager';
import { fetchModels, getStaticModels } from './ModelRegistry';

/** Per-project saved session settings. */
interface SavedSettings { provider: string; model: string; }

/** One chat history entry saved to disk. */
interface ChatEntry {
  role: 'user' | 'agent' | 'tool' | 'system' | 'error';
  text: string;
  name?: string;  // for tool entries
  ts: string;
}

const CHAT_DIR = '.specsmith/chat';
const MAX_CHAT_DISPLAY = 200; // max entries to replay on re-open

// ── Static status listener registry ──────────────────────────────────────────
type StatusListener = (panel: SessionPanel, status: SessionStatus) => void;
const _statusListeners: StatusListener[] = [];

export function onSessionStatusChange(fn: StatusListener): vscode.Disposable {
  _statusListeners.push(fn);
  return {
    dispose: () => {
      const i = _statusListeners.indexOf(fn);
      if (i >= 0) { _statusListeners.splice(i, 1); }
    },
  };
}

// ── Panel registry ────────────────────────────────────────────────────────────

export class SessionPanel implements vscode.Disposable {
  private static _instances: SessionPanel[] = [];
  private static _current: SessionPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _bridge: SpecsmithBridge;
  private _config: SessionConfig;
  private _ollamaCtx: number;
  private _status: SessionStatus = 'starting';
  private _disposables: vscode.Disposable[] = [];
  private readonly _secrets: vscode.SecretStorage;
  private readonly _globalState: vscode.Memento;
  private _chatFile: string | undefined;
  private _chatStream: fs.WriteStream | undefined;
  private _availableProviders: string[] = ['ollama'];
  private _autoAcceptAll = false;

  /** Read auto_approve from scaffold.yml (project-level default). */
  private static _readAutoApprove(projectDir: string): boolean {
    try {
      const raw = fs.readFileSync(path.join(projectDir, 'scaffold.yml'), 'utf8');
      const m = raw.match(/^auto_approve:\s*(true|yes)/mi);
      return !!m;
    } catch { return false; }
  }

  // ── Factory (async — awaits SecretStorage for API keys) ───────────────────

  static async create(
    context: vscode.ExtensionContext,
    projectDir: string,
    provider: string,
    model: string,
  ): Promise<SessionPanel> {
    const cfg      = vscode.workspace.getConfiguration('specsmith');
    const execPath = cfg.get<string>('executablePath', 'specsmith');
    const envOverrides = await ApiKeyManager.getAllEnv(context.secrets);

    // For Ollama: auto-select first installed model if none explicitly saved/chosen
    if (provider === 'ollama' && !model) {
      const { OllamaManager: OM } = await import('./OllamaManager');
      const firstModel = await OM.getFirstInstalledModel();
      if (firstModel) {
        model = firstModel;
      } else {
        void vscode.window.showWarningMessage(
          'No Ollama models installed. Use the model dropdown to download one, or run: specsmith ollama pull <model>',
        );
      }
    }

    // Determine Ollama context length (VRAM-aware, or from setting)
    let ollamaCtx = 0;
    if (provider === 'ollama') {
      const cfgCtx = cfg.get<number>('ollamaContextLength', 0);
      if (cfgCtx > 0) {
        ollamaCtx = cfgCtx;
      } else {
        // Auto-detect from GPU VRAM
        const { OllamaManager } = await import('./OllamaManager');
        const vram = await OllamaManager.getVramGb();
        if (vram >= 16)      { ollamaCtx = 32768; }
        else if (vram >= 8)  { ollamaCtx = 16384; }
        else if (vram >= 4)  { ollamaCtx = 8192;  }
        else                 { ollamaCtx = 4096;  }
      }
    }

    // Load saved provider/model for this project.
    // Only use the saved provider if its API key is still configured
    // (prevents stale 'anthropic' overriding auto-detected 'openai' when keys change).
    const settingsKey = `specsmith.session.${projectDir}`;
    const saved = context.globalState.get<SavedSettings>(settingsKey);
    if (saved) {
      const savedKeyPresent = saved.provider === 'ollama'
        || !!(await ApiKeyManager.getKey(context.secrets, saved.provider));
      if (savedKeyPresent) {
        provider = saved.provider;
        model    = saved.model;
        // For Ollama: resolve the saved model to the EXACT installed ID.
        // Avoids 404 when model was pulled under a quantization-tagged name
        // (e.g. 'qwen2.5:14b-instruct-q4_K_M') but session saved 'qwen2.5:14b'.
        if (saved.provider === 'ollama' && saved.model) {
          const { OllamaManager: _OM } = await import('./OllamaManager');
          const installed = await _OM.getInstalledIds();
          if (installed.includes(saved.model)) {
            model = saved.model;                          // exact match — use as-is
          } else {
            // Fuzzy: find installed names that start with the base tag
            const base   = saved.model.split(':')[0];     // 'qwen2.5'
            const short  = saved.model;                   // 'qwen2.5:14b'
            const hits   = installed.filter(
              (id) => id.startsWith(base + ':') || id.startsWith(short),
            );
            if (hits.length > 0) {
              // Prefer shortest (= default quant tag Ollama uses)
              model = hits.reduce((a, b) => (a.length <= b.length ? a : b));
            } else {
              model = ''; // not installed at all — auto-detect below
            }
          }
        }
      }
    }

    // ── Provider validation: if selected provider has no API key, offer alternatives ──
    if (provider !== 'ollama') {
      const hasKey = !!(await ApiKeyManager.getKey(context.secrets, provider));
      if (!hasKey) {
        // Build list of available providers
        const available: Array<{ label: string; id: string }> = [{ label: '🦙 Ollama (local — no key needed)', id: 'ollama' }];
        for (const p of ['anthropic', 'openai', 'gemini', 'mistral'] as const) {
          if (await ApiKeyManager.getKey(context.secrets, p)) {
            const labels: Record<string, string> = { anthropic: '🧠 Anthropic (Claude)', openai: '🤖 OpenAI (GPT)', gemini: '✨ Google Gemini', mistral: '🌬 Mistral AI' };
            available.push({ label: labels[p] ?? p, id: p });
          }
        }
        const picked = await vscode.window.showQuickPick(
          [...available, { label: '🔑 Set API Key…', id: '__setkey__' }],
          { placeHolder: `No API key for ${provider}. Choose an available provider:` },
        );
        if (!picked) { return undefined as unknown as SessionPanel; } // cancelled
        if (picked.id === '__setkey__') {
          await ApiKeyManager.promptSetKey(context.secrets);
          return undefined as unknown as SessionPanel; // they can retry after setting key
        }
        provider = picked.id;
        model = ''; // reset model for new provider
      }
    }

    // Build list of providers with keys for the webview dropdown
    const availableProviders: string[] = ['ollama'];
    for (const p of ['anthropic', 'openai', 'gemini', 'mistral'] as const) {
      if (await ApiKeyManager.getKey(context.secrets, p)) { availableProviders.push(p); }
    }

    const config: SessionConfig = { projectDir, provider, model, sessionId: Date.now().toString() };
    const panel = vscode.window.createWebviewPanel(
      'specsmithSession',
      `🧠 ${path.basename(projectDir)}`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [
        vscode.Uri.joinPath(vscode.Uri.file(path.join(__dirname, '..')), 'media'),
      ] },
    );

    const inst = new SessionPanel(panel, config, execPath, envOverrides, context.secrets, context.globalState, ollamaCtx);
    inst._availableProviders = availableProviders;
    // Load project-level auto-approve setting from scaffold.yml
    inst._autoAcceptAll = SessionPanel._readAutoApprove(projectDir);
    SessionPanel._instances.push(inst);
    SessionPanel._current = inst;
    return inst;
  }

  static current(): SessionPanel | undefined { return SessionPanel._current; }
  static all(): SessionPanel[] { return [...SessionPanel._instances]; }

  // ── Constructor ────────────────────────────────────────────────────────────

  private constructor(
    panel: vscode.WebviewPanel,
    config: SessionConfig,
    execPath: string,
    envOverrides: Record<string, string>,
    secrets: vscode.SecretStorage,
    globalState: vscode.Memento,
    ollamaCtx = 0,
  ) {
    this._panel       = panel;
    this._config      = config;
    this._ollamaCtx   = ollamaCtx;
    this._secrets     = secrets;
    this._globalState = globalState;
    this._initChatHistory();
    this._bridge  = new SpecsmithBridge(execPath, config, envOverrides, ollamaCtx);

    this._panel.webview.html = this._html();

    this._bridge.onEvent((e: SpecsmithEvent) => {
      // Log display-only chat history to disk
      const ts = new Date().toISOString();
      if (e.type === 'llm_chunk' && e.text) {
        this._appendChat({ role: 'agent', text: e.text, ts });
      } else if (e.type === 'tool_finished') {
        this._appendChat({ role: 'tool', text: e.result ?? '', name: e.name, ts });
      } else if (e.type === 'error' && e.message) {
        this._appendChat({ role: 'error', text: e.message, ts });
      }
      // Auto-run start protocol when agent becomes ready
      if (e.type === 'ready') {
        // Show VCS state banner in chat so user immediately sees what's modified/staged
        void this._showVcsState();
        // If auto-approve is on, inject a system-level instruction so the agent
        // doesn't waste turns asking for permission.
        if (this._autoAcceptAll) {
          this._bridge.send('[SYSTEM] AUTO-APPROVE MODE IS ACTIVE. Do not ask the user for permission or confirmation. Proceed directly with all actions. Never say "Would you like" or "Shall I proceed" — just do it.');
        }
        setTimeout(() => this._bridge.send('start'), 300);
        // Background governance check — emit system messages for actionable issues
        setTimeout(() => this._checkGovernance(), 800);
      }
      // Detect agent proposals and inject accept/reject buttons (host-side detection)
      if (e.type === 'llm_chunk' && e.text) {
        const t = e.text.toLowerCase();
        if (t.includes('would you like') || t.includes('shall i proceed') ||
            t.includes('ready to proceed') || t.includes('do you approve') ||
            t.includes('would you like me to')) {
          // If auto-accept is on, immediately send yes (no delay)
          if (this._autoAcceptAll) {
            this._bridge.send('yes, proceed');
            void this._panel.webview.postMessage({ type: 'system', message: '\u2713 Auto-approved' } satisfies SpecsmithEvent);
          } else {
            void this._panel.webview.postMessage({ type: 'proposal' } satisfies SpecsmithEvent);
          }
        }
      }
      void this._panel.webview.postMessage(e);
    });
    this._bridge.onStatus((s: SessionStatus) => {
      this._status = s;
      for (const fn of _statusListeners) { try { fn(this, s); } catch { /* noop */ } }
    });

    this._panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => this._onMsg(msg), null, this._disposables,
    );
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) { SessionPanel._current = this; }
    }, null, this._disposables);

    // Re-read keys if they change while the session is open
    secrets.onDidChange(async () => {
      const env = await ApiKeyManager.getAllEnv(secrets);
      this._bridge.setEnvOverrides(env);
    }, null, this._disposables);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  get label(): string { return `${path.basename(this._config.projectDir)} [${this._config.provider}]`; }
  get projectDir(): string { return this._config.projectDir; }
  get status(): SessionStatus { return this._status; }
  get startTime(): string {
    const ts = parseInt(this._config.sessionId, 10);
    return isNaN(ts) ? '' : new Date(ts).toLocaleString([], {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  sendCommand(cmd: string): void {
    this._bridge.send(cmd);
    void this._panel.webview.postMessage({ type: 'system', message: `> ${cmd}` } satisfies SpecsmithEvent);
  }

  /** Push a fresh model list to the webview (called after API key verification). */
  postModels(provider: string, models: import('./types').ModelInfo[]): void {
    if (this._config.provider === provider) {
      void this._panel.webview.postMessage({ type: 'models', models } satisfies SpecsmithEvent);
    }
  }

  /** Clear display + agent context + JSONL files (called from command palette). */
  clearHistoryExternal(): void {
    this._doClearHistory();
  }

  private _doClearHistory(): void {
    // Delete all JSONL history files for this project
    try {
      const chatDir = path.join(this._config.projectDir, CHAT_DIR);
      if (fs.existsSync(chatDir)) {
        for (const f of fs.readdirSync(chatDir)) {
          if (f.endsWith('.jsonl')) { fs.unlinkSync(path.join(chatDir, f)); }
        }
      }
    } catch { /* ignore */ }
    // Start a fresh file
    this._chatStream?.end();
    this._initChatHistory();
    // Clear agent LLM context
    this._bridge.send('/clear');
    // Clear webview display
    void this._panel.webview.postMessage({
      type: 'clear_display',
      message: 'History cleared — new session started.',
    } satisfies SpecsmithEvent);
  }

  dispose(): void {
    SessionPanel._instances = SessionPanel._instances.filter((i) => i !== this);
    if (SessionPanel._current === this) {
      SessionPanel._current = SessionPanel._instances[SessionPanel._instances.length - 1];
    }
    this._status = 'inactive';
    for (const fn of _statusListeners) { try { fn(this, 'inactive'); } catch { /* noop */ } }
    this._bridge.dispose();
    this._chatStream?.end();
    this._chatStream = undefined;
    this._panel.dispose();
    while (this._disposables.length > 0) { this._disposables.pop()?.dispose(); }
  }

  // ── Message handler ────────────────────────────────────────────────────────

  private _onMsg(msg: WebviewMessage): void {
    switch (msg.command) {
      case 'ready':
        void this._panel.webview.postMessage({
          type: 'init', provider: this._config.provider,
          model: this._config.model, projectDir: this._config.projectDir,
          models: getStaticModels(this._config.provider),
          availableProviders: this._availableProviders,
        } satisfies SpecsmithEvent);
        // Offer previous chat session replay (last 40 messages as proper bubbles)
        const prev = this._loadPreviousChat();
        if (prev.length > 0) {
          void this._panel.webview.postMessage({ type: 'system', message: `── Previous session (${prev.length} messages, showing last 40) ──` } satisfies SpecsmithEvent);
          for (const e of prev.slice(-40)) {
            const ts = _fmtTs(e.ts);
            if (e.role === 'user') {
              void this._panel.webview.postMessage({ type: 'history_user', text: e.text, message: ts } satisfies SpecsmithEvent);
            } else if (e.role === 'agent') {
              void this._panel.webview.postMessage({ type: 'history_agent', text: e.text, message: ts } satisfies SpecsmithEvent);
            }
          }
          void this._panel.webview.postMessage({ type: 'system', message: '── New session ──' } satisfies SpecsmithEvent);
        }
        this._bridge.start();
        void this._refreshModels(this._config.provider);
        break;

      case 'send':
        if (msg.text) {
          this._appendChat({ role: 'user', text: msg.text, ts: new Date().toISOString() });
          this._bridge.send(msg.text);
        }
        break;

      case 'stop':
        this._bridge.kill();
        break;

      case 'setProvider':
        if (msg.provider) {
          this._config.provider = msg.provider;
          this._saveSettings();
          void ApiKeyManager.getAllEnv(this._secrets).then((env) => {
            this._bridge.restart(this._config, env);
          });
          void this._refreshModels(msg.provider);
        }
        break;

      case 'setModel':
        if (msg.model) {
          this._bridge.setModel(msg.model);
          this._config.model = msg.model;
          this._saveSettings();
        }
        break;

      case 'getModels':
        if (msg.provider) { void this._refreshModels(msg.provider); }
        break;

      case 'pickFile': {
        const INLINE_LIMIT = 50 * 1024; // 50 KB — matches webview threshold
        void vscode.window.showOpenDialog({
          canSelectMany: false, canSelectFiles: true, canSelectFolders: false,
          defaultUri: vscode.Uri.file(this._config.projectDir),
          title: 'Inject a file as context',
        }).then((uris) => {
          if (!uris?.[0]) { return; }
          const fp  = uris[0].fsPath;
          const fn  = path.basename(fp);
          const ext = path.extname(fp).toLowerCase();
          const imgs = new Set(['.png','.jpg','.jpeg','.gif','.webp','.bmp','.svg']);
          const isPdf = ext === '.pdf';
          if (imgs.has(ext)) {
            // Image: send base64 dataURL for thumbnail display
            const b64  = fs.readFileSync(fp).toString('base64');
            const mime = ext === '.svg' ? 'image/svg+xml' : `image/${ext.slice(1)}`;
            void this._panel.webview.postMessage({
              type: 'file_picked', fileName: fn, isImage: true,
              dataUrl: `data:${mime};base64,${b64}`,
            } satisfies SpecsmithEvent);
          } else if (isPdf) {
            // PDF: send as path reference
            void this._panel.webview.postMessage({
              type: 'file_picked', fileName: fn, isImage: false,
              fileContent: `[PDF: ${fp} — use read_file tool to parse content]`,
            } satisfies SpecsmithEvent);
          } else {
            try {
              const stat = fs.statSync(fp);
              if (stat.size > INLINE_LIMIT) {
                // Large file: path reference + brief preview
                const preview = fs.readFileSync(fp, 'utf8').split('\n').slice(0, 6).join('\n');
                const sizeStr = stat.size < 1048576
                  ? `${(stat.size / 1024).toFixed(0)}KB`
                  : `${(stat.size / 1048576).toFixed(1)}MB`;
                void this._panel.webview.postMessage({
                  type: 'file_picked', fileName: fn, isImage: false,
                  fileContent: `[Large file: ${fp} (${sizeStr}) — use read_file tool for full content]\nPreview:\n${preview}\n…`,
                } satisfies SpecsmithEvent);
              } else {
                const content = fs.readFileSync(fp, 'utf8');
                void this._panel.webview.postMessage({
                  type: 'file_picked', fileName: fn, isImage: false,
                  fileContent: content,
                } satisfies SpecsmithEvent);
              }
            } catch {
              void this._panel.webview.postMessage({
                type: 'file_picked', fileName: fn, isImage: false,
                fileContent: `[File: ${fp} — could not read as text, use read_file tool]`,
              } satisfies SpecsmithEvent);
            }
          }
        });
        break;
      }

      case 'exportChat':
        if (msg.markdown) {
          void vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(
              path.join(this._config.projectDir, `chat-${Date.now()}.md`),
            ),
            filters: { Markdown: ['md'] },
            title: 'Export Chat As…',
          }).then((uri) => {
            if (uri) {
              fs.writeFileSync(uri.fsPath, msg.markdown!);
              void vscode.window.showInformationMessage(`Chat exported to ${uri.fsPath}`);
            }
          });
        }
        break;

      case 'openFile':
        if (msg.filePath) {
          const uri = vscode.Uri.file(msg.filePath);
          if (fs.existsSync(msg.filePath) && fs.statSync(msg.filePath).isDirectory()) {
            void vscode.commands.executeCommand('revealFileInOS', uri);
          } else {
            void vscode.window.showTextDocument(uri);
          }
        }
        break;

      case 'clearHistory':
        this._doClearHistory();
        break;

      case 'copyAll': break; // handled entirely in webview JS

      case 'downloadModel':
        void vscode.commands.executeCommand('specsmith.downloadModel', msg.model ?? '');
        break;

      case 'showHelp':
        void vscode.commands.executeCommand('specsmith.showHelp');
        break;

      case 'reportBug': {
        // Determine target repo from prefilled title prefix
        const repo = msg.bugTitle?.startsWith('[specsmith]') ? 'specsmith' : 'specsmith-vscode';
        void vscode.commands.executeCommand(
          'specsmith.reportBug',
          msg.bugTitle ?? 'specsmith bug',
          msg.bugDetail ?? '',
          repo,
        );
        break;
      }

      case 'reportIssue':
        void vscode.commands.executeCommand('specsmith.reportIssue');
        break;

      case 'showSettings':
        void vscode.commands.executeCommand('specsmith.showSettings');
        break;

      case 'viewFull':
        if (msg.text) {
          void vscode.workspace.openTextDocument({ content: msg.text, language: 'markdown' })
            .then((doc) => vscode.window.showTextDocument(doc, { preview: true }));
        }
        break;

      case 'installOrUpgrade':
        void vscode.commands.executeCommand('specsmith.installOrUpgrade');
        break;

      case 'setAutoAccept':
        this._autoAcceptAll = true;
        break;

      case 'changeProject': {
        void vscode.window.showOpenDialog({
          canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
          openLabel: 'Switch to this project',
          defaultUri: vscode.Uri.file(this._config.projectDir),
        }).then((uris) => {
          if (!uris?.[0]) { return; }
          const newDir = uris[0].fsPath;
          this._config.projectDir = newDir;
          this._saveSettings();
          void ApiKeyManager.getAllEnv(this._secrets).then((env) => {
            this._bridge.restart(this._config, env);
          });
          this._panel.title = `\uD83E\uDDE0 ${path.basename(newDir)}`;
          void this._panel.webview.postMessage({
            type: 'system', message: `\uD83D\uDCC2 Switched to: ${newDir}`,
          } satisfies SpecsmithEvent);
        });
        break;
      }
    }
  }

  /** Non-blocking governance check — emits detailed messages and offers agent walkthrough. */
  private _checkGovernance(): void {
    const dir  = this._config.projectDir;
    const emit = (msg: string) =>
      void this._panel.webview.postMessage({ type: 'system', message: msg } satisfies SpecsmithEvent);
    const issues: string[] = [];

    try {
      // No scaffold.yml
      if (!fs.existsSync(path.join(dir, 'scaffold.yml'))) {
        issues.push('scaffold.yml not found — run specsmith init or specsmith import');
      }

      // Missing key governance files
      const required: Array<[string, string]> = [
        ['AGENTS.md', 'specsmith import --project-dir .'],
        ['LEDGER.md', 'specsmith audit --fix --project-dir .'],
      ];
      for (const [f, fix] of required) {
        if (!fs.existsSync(path.join(dir, f))) {
          issues.push(`${f} missing — fix: ${fix}`);
        }
      }

      // Duplicate requirements
      if (fs.existsSync(path.join(dir, 'REQUIREMENTS.md')) && fs.existsSync(path.join(dir, 'docs', 'REQUIREMENTS.md'))) {
        issues.push('Both REQUIREMENTS.md and docs/REQUIREMENTS.md exist — docs/ version is canonical');
      }

      // Legacy lowercase architecture
      if (fs.existsSync(path.join(dir, 'docs', 'architecture.md')) && !fs.existsSync(path.join(dir, 'docs', 'ARCHITECTURE.md'))) {
        issues.push('docs/architecture.md should be ARCHITECTURE.md — run specsmith upgrade');
      }

      // Legacy WORKFLOW.md
      if (fs.existsSync(path.join(dir, 'docs', 'governance', 'WORKFLOW.md'))) {
        issues.push('docs/governance/WORKFLOW.md is legacy — run specsmith upgrade to migrate to SESSION-PROTOCOL.md');
      }

      if (issues.length > 0) {
        emit(`\u26a0 Governance check found ${issues.length} issue(s):\n${issues.map(i => `  \u2022 ${i}`).join('\n')}`);
        // Auto-fix: run specsmith audit --fix first, then ask agent about remaining issues
        setTimeout(() => {
          this._bridge.send(
            '[RESPOND IN ENGLISH ONLY] ' +
            'Run specsmith audit --fix to auto-repair governance issues. ' +
            'Then check if these remain:\n' + issues.join('\n') + '\n' +
            'Fix each one automatically without asking for permission. ' +
            'Report what you fixed in 2-3 sentences.',
          );
        }, 1500);
      }
    } catch { /* ignore — non-blocking */ }
  }

  /**
   * Run git status + git log in the project directory and emit a system
   * message showing the current VCS state.  Gives the user (and the agent
   * context) immediate visibility into modified / staged / untracked files
   * and recent commits without waiting for the agent to run git commands.
   */
  private async _showVcsState(): Promise<void> {
    const dir = this._config.projectDir;
    const emit = (msg: string) =>
      void this._panel.webview.postMessage({ type: 'system', message: msg } satisfies SpecsmithEvent);

    try {
      const cp = await import('child_process');

      const status = cp.spawnSync('git', ['status', '--short'], {
        cwd: dir, encoding: 'utf8', timeout: 5000,
      });
      const log = cp.spawnSync('git', ['log', '--oneline', '-5'], {
        cwd: dir, encoding: 'utf8', timeout: 5000,
      });

      if (status.status !== 0) { return; } // not a git repo

      const statusText = status.stdout.trim() || '(clean — no uncommitted changes)';
      const logText    = log.status === 0 ? log.stdout.trim() : '(no commits yet)';

      // Get current branch
      const branchResult = cp.spawnSync('git', ['branch', '--show-current'], {
        cwd: dir, encoding: 'utf8', timeout: 3000,
      });
      const branch = branchResult.status === 0 ? branchResult.stdout.trim() : '';
      const changeCount = status.stdout.trim().split('\n').filter((l: string) => l.trim()).length;

      // Post structured VCS data for the bar
      void this._panel.webview.postMessage({
        type: 'vcs_state',
        branch: branch || '(detached)',
        changes: statusText === '(clean — no uncommitted changes)' ? 0 : changeCount,
        projectDir: dir,
      } satisfies SpecsmithEvent);

      // Format as a compact, readable snapshot
      const lines: string[] = [
        `📁 Project: ${dir}`,
        `🔀 ${branch || '(detached HEAD)'}${changeCount > 0 ? ` · ${changeCount} change(s)` : ' · clean'}`,
        `🗃 Recent: ${logText.split('\n').join(' │ ')}`,
      ];
      emit(lines.join('\n'));
    } catch { /* not a git repo or git not installed — silently skip */ }
  }

  /**
   * Return the last `n` chat messages formatted as plain text for inclusion
   * in a bug/issue report.
   * (JSONL on disk) so it works even if the webview is not open.
   */
  getRecentMessages(n = 10): string {
    try {
      const chatDir = path.join(this._config.projectDir, CHAT_DIR);
      if (!fs.existsSync(chatDir)) { return ''; }
      // Find the current session file first, else most recent
      const files = fs.readdirSync(chatDir)
        .filter((f) => f.endsWith('.jsonl'))
        .sort()
        .reverse();
      if (!files.length) { return ''; }
      const target = this._chatFile
        ? path.basename(this._chatFile)
        : files[0];
      const filePath = path.join(chatDir, target);
      if (!fs.existsSync(filePath)) { return ''; }
      const lines = fs.readFileSync(filePath, 'utf8')
        .trim()
        .split('\n')
        .slice(-n)
        .map((l) => { try { return JSON.parse(l) as { role: string; text: string; ts: string }; } catch { return null; } })
        .filter(Boolean) as { role: string; text: string; ts: string }[];
      if (!lines.length) { return ''; }
      return lines
        .map((e) => `[${e.role.toUpperCase()} ${e.ts.slice(0, 16)}] ${e.text.slice(0, 500)}`)
        .join('\n');
    } catch { return ''; }
  }

  setModelExternal(modelId: string): void {
    this._bridge.setModel(modelId);
    this._config.model = modelId;
    void this._panel.webview.postMessage({
      type: 'system',
      message: `Model switched to ${modelId}`,
    } satisfies SpecsmithEvent);
  }

  private async _refreshModels(provider: string): Promise<void> {
    try {
      const key    = await ApiKeyManager.getKey(this._secrets, provider);
      const models = await fetchModels(provider, key ?? undefined);
      if (models.length > 0) {
        void this._panel.webview.postMessage({ type: 'models', models } satisfies SpecsmithEvent);
      } else {
        // No live models — send static fallback so dropdown isn't empty
        const fallback = getStaticModels(provider);
        if (fallback.length > 0) {
          void this._panel.webview.postMessage({ type: 'models', models: fallback } satisfies SpecsmithEvent);
        }
      }
    } catch (err) {
      // API error — send static fallback so dropdown is never empty
      const fallback = getStaticModels(provider);
      if (fallback.length > 0) {
        void this._panel.webview.postMessage({ type: 'models', models: fallback } satisfies SpecsmithEvent);
      }
      console.warn('[specsmith] Model fetch failed for', provider, err);
    }
  }

  // ── Settings persistence

  private _saveSettings(): void {
    const key = `specsmith.session.${this._config.projectDir}`;
    void this._globalState.update(key, {
      provider: this._config.provider,
      model:    this._config.model,
    } satisfies SavedSettings);
  }

  // ── Chat history ───────────────────────────────────────────────────────────

  private _initChatHistory(): void {
    try {
      const chatDir = path.join(this._config.projectDir, CHAT_DIR);
      fs.mkdirSync(chatDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      this._chatFile = path.join(chatDir, `chat-${stamp}.jsonl`);
      this._chatStream = fs.createWriteStream(this._chatFile, { flags: 'a', encoding: 'utf8' });
    } catch { /* project dir not writable — skip */ }
  }

  private _appendChat(entry: ChatEntry): void {
    if (!this._chatStream) { return; }
    try { this._chatStream.write(JSON.stringify(entry) + '\n'); } catch { /* ignore */ }
  }

  /** Load the most recent previous chat file (display only). */
  private _loadPreviousChat(): ChatEntry[] {
    try {
      const chatDir = path.join(this._config.projectDir, CHAT_DIR);
      if (!fs.existsSync(chatDir)) { return []; }
      const files = fs.readdirSync(chatDir)
        .filter((f) => f.endsWith('.jsonl') && f !== path.basename(this._chatFile ?? ''))
        .sort().reverse();
      if (!files.length) { return []; }
      const lines = fs.readFileSync(path.join(chatDir, files[0]), 'utf8').trim().split('\n');
      return lines
        .map((l) => { try { return JSON.parse(l) as ChatEntry; } catch { return null; } })
        .filter(Boolean)
        .slice(-MAX_CHAT_DISPLAY) as ChatEntry[];
    } catch { return []; }
  }

  // ── Webview HTML ───────────────────────────────────────────────────────────

  // eslint-disable-next-line max-lines-per-function
  private _html(): string {
    const scriptUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(vscode.Uri.file(path.join(__dirname, '..', 'media')), 'session.js'),
    );
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' ${scriptUri}; img-src data: 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>specsmith</title>
<style>
  :root{--bg:var(--vscode-editor-background,#1e1e2e);--fg:var(--vscode-editor-foreground,#cdd6f4);--sf:var(--vscode-panel-background,#181825);--br:var(--vscode-panel-border,#313244);--ib:var(--vscode-input-background,#1e1e2e);--if:var(--vscode-input-foreground,#cdd6f4);--bb:var(--vscode-button-background,#1e66f5);--bf:var(--vscode-button-foreground,#fff);--bh:var(--vscode-button-hoverBackground,#1e5cd5);--teal:#4ec9b0;--amb:#ce9178;--red:#f44747;--grn:#4ec94e;--dim:var(--vscode-descriptionForeground,#7f849c);--fn:var(--vscode-font-family,'Segoe UI',system-ui,sans-serif);--mn:var(--vscode-editor-font-family,'Cascadia Code',monospace)}
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%;overflow:hidden}
  body{background:var(--bg);color:var(--fg);font-family:var(--fn);font-size:13px;display:flex;flex-direction:column}
  #pbar{display:flex;align-items:center;gap:7px;padding:4px 10px;background:var(--sf);border-bottom:1px solid var(--br);font-size:11px;flex-shrink:0}
  #pbar select{background:var(--ib);color:var(--if);border:1px solid var(--br);border-radius:3px;padding:2px 4px;font-size:11px;font-family:var(--fn)}
  #pbar select:focus{outline:1px solid var(--teal)}
  .dlbl{color:var(--dim);max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mn);font-size:11px;cursor:pointer}
  .dlbl:hover{color:var(--teal)}
  .bsep{color:var(--br)}
  #mdesc{font-size:10px;color:var(--dim);max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .hbtn{background:none;border:none;color:var(--dim);cursor:pointer;font-size:13px;padding:0 3px}
  .hbtn:hover{color:var(--teal)}
  #chat{flex:1 1 auto;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:5px;min-height:0}
  #chat::-webkit-scrollbar{width:5px}
  #chat::-webkit-scrollbar-thumb{background:var(--br);border-radius:3px}
  #rh{height:5px;background:var(--br);cursor:ns-resize;flex-shrink:0;transition:background .15s}
  #rh:hover,#rh.drag{background:var(--teal)}
  .mu{align-self:flex-end;max-width:76%;position:relative}
  .mu .bbl{background:var(--bb);color:var(--bf);border-radius:14px 14px 3px 14px;padding:8px 12px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
  .mu .mt{text-align:right;font-size:10px;color:var(--dim);margin-top:2px}
  .ma{align-self:flex-start;max-width:93%;position:relative}
  .rtag{font-size:10px;color:var(--teal);font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px}
  .ma .bbl{background:var(--sf);border:1px solid var(--br);border-radius:3px 14px 14px 14px;padding:8px 12px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
  .mt{font-size:10px;color:var(--dim);margin-top:2px;padding:0 1px}
  .tb{align-self:flex-start;background:var(--sf);border:1px solid var(--br);border-left:3px solid var(--amb);border-radius:4px;padding:5px 9px;max-width:93%;font-size:12px}
  .tb.er{border-left-color:var(--red)}
  .thdr{color:var(--amb);font-weight:600;font-family:var(--mn);margin-bottom:3px}
  .tb.er .thdr{color:var(--red)}
  .tres{color:var(--dim);font-family:var(--mn);font-size:11px;max-height:100px;overflow:hidden;white-space:pre-wrap;word-break:break-all}
  .sl{align-self:flex-start;color:var(--dim);font-size:11px;font-style:italic;padding:1px 4px;display:flex;gap:6px;align-items:baseline}
  .sl .mts{font-size:9px;opacity:.6;flex-shrink:0}
  .el{align-self:flex-start;color:var(--red);font-size:12px;background:rgba(244,71,71,.08);border-left:3px solid var(--red);border-radius:3px;padding:4px 9px;max-width:93%}
  .el details summary{cursor:pointer;list-style:none;outline:none}
  .el details summary::-webkit-details-marker{display:none}
  .el details summary::before{content:'▶ ';font-size:9px}
  .el details[open] summary::before{content:'▼ ';}
  .el .err-detail{font-family:var(--mn);font-size:10px;color:var(--dim);margin-top:4px;white-space:pre-wrap;word-break:break-all}
  code{font-family:var(--mn);background:rgba(255,255,255,.07);padding:1px 4px;border-radius:3px;font-size:12px;color:var(--teal)}
  pre{background:rgba(0,0,0,.25);border:1px solid var(--br);border-radius:4px;padding:6px 9px;overflow-x:auto;font-size:11px;margin:4px 0}
  pre code{background:none;padding:0}
  .mact{display:none;position:absolute;top:0;right:0;background:var(--sf);border:1px solid var(--br);border-radius:4px;gap:2px;padding:2px 4px}
  .mu:hover .mact,.ma:hover .mact{display:flex}
  .ab{background:none;border:none;color:var(--dim);cursor:pointer;font-size:11px;padding:1px 4px;border-radius:3px}
  .ab:hover{color:var(--teal);background:rgba(78,201,176,.1)}
  .iprev{max-width:100%;max-height:200px;border-radius:6px;border:1px solid var(--br);margin-top:4px}
  /* Drop overlay — only highlights the input bar, not the full window */
  #ibar{display:flex;flex-direction:column;gap:4px;padding:6px 10px 8px;background:var(--sf);border-top:1px solid var(--br);border-bottom:2px solid var(--teal);flex-shrink:0;transition:border-top-color .15s,background .15s}
  #ibar.da{border-top:2px solid var(--teal);background:rgba(78,201,176,.06)}
  #dh{display:none;text-align:center;color:var(--teal);font-size:11px;padding:2px 0;font-style:italic}
  #ibar.da #dh{display:block}
  #tmtr{display:flex;align-items:center;gap:8px;padding:3px 10px;background:var(--sf);border-bottom:1px solid var(--br);font-size:11px;color:var(--dim);flex-shrink:0}
  #ctrk{flex:1;height:4px;background:var(--br);border-radius:2px;overflow:hidden}
  #cfil{height:100%;width:0%;background:var(--grn);border-radius:2px;transition:width .4s,background .4s}
  #cpct{min-width:28px;text-align:right}
  #tcst{color:var(--teal);font-weight:600}
  #obn{display:none;align-items:center;gap:8px;padding:4px 10px;background:rgba(206,145,120,.1);border-top:1px solid var(--amb);font-size:11px;color:var(--amb);flex-shrink:0}
  #obn.show{display:flex}
  #obn button{background:none;border:none;color:var(--amb);cursor:pointer;font-size:13px;margin-left:auto}
  #ir{position:relative}
  #it{width:100%;background:var(--ib);color:var(--if);border:1px solid var(--br);border-radius:8px;padding:9px 46px 9px 12px;font-family:var(--fn);font-size:13px;resize:none;min-height:38px;height:38px;line-height:1.45;overflow-y:auto;box-sizing:border-box;transition:border-color .15s}
  #it:focus{outline:none;border-color:var(--teal)}
  #it:disabled{opacity:.5}
  #mainbtn{position:absolute;right:7px;bottom:5px;width:28px;height:28px;border:none;border-radius:50%;background:var(--bb);color:var(--bf);cursor:pointer;font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center;transition:background .15s,transform .1s;z-index:1}
  #mainbtn:hover:not(:disabled){background:var(--bh);transform:scale(1.08)}
  #mainbtn:disabled{opacity:.45;cursor:not-allowed}
  #mainbtn.busy{background:var(--red)!important}
  #tr{display:flex;gap:4px;flex-wrap:wrap;align-items:center}
  .tb2{background:none;border:1px solid var(--br);border-radius:3px;color:var(--dim);padding:1px 6px;cursor:pointer;font-size:10px;font-family:var(--fn);transition:border-color .15s,color .15s}
  .tb2:hover:not(:disabled){border-color:var(--teal);color:var(--teal)}
  .tb2:disabled{opacity:.4;cursor:not-allowed}
  .kh{font-size:10px;color:var(--dim);margin-left:auto}
  #vcsbar{display:flex;align-items:center;gap:8px;padding:2px 10px;background:var(--sf);border-bottom:1px solid var(--br);font-size:10px;color:var(--dim);flex-shrink:0}
  #vcsbar .vb{color:var(--teal);font-weight:600}
  #vcsbar .vc{background:rgba(206,145,120,.15);color:var(--amb);border-radius:8px;padding:0 5px;font-weight:600;font-size:9px}
  #typ{display:none;gap:5px;align-items:center;color:var(--teal);font-size:11px}
  #typ.show{display:flex}
  .d{width:5px;height:5px;background:var(--teal);border-radius:50%;animation:b 1.1s infinite}
  .d:nth-child(2){animation-delay:.18s}
  .d:nth-child(3){animation-delay:.36s}
  @keyframes b{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-5px)}}
</style>
</head>
<body>
<div id="pbar">
  <span style="opacity:.7;cursor:pointer" onclick="openProj()">📁</span>
  <span class="dlbl" id="dlbl" title="" onclick="openProj()">.</span>
  <span class="bsep">│</span>
  <label for="ps" style="color:var(--dim)">Provider</label>
  <select id="ps">
    <option value="anthropic">anthropic</option>
    <option value="openai">openai</option>
    <option value="gemini">gemini</option>
    <option value="mistral">mistral</option>
    <option value="ollama">ollama</option>
  </select>
  <label for="ms" style="color:var(--dim)">Model</label>
  <select id="ms" style="min-width:148px"></select>
  <span id="mdesc" title=""></span>
  <span style="flex:1"></span>
  <button class="hbtn" title="Copy all messages" onclick="copyAll()" id="cab">⎍</button>
  <button class="hbtn" title="Clear chat history" onclick="doClearHistory()">🗑</button>
  <button class="hbtn" title="Export chat as markdown" onclick="exportChat()">⬇</button>
  <button class="hbtn" title="Report an issue or suggest a feature" onclick="vscode.postMessage({command:'reportIssue'})">📝</button>
  <button class="hbtn" title="Install / Upgrade specsmith" onclick="vscode.postMessage({command:'installOrUpgrade'})">⬆</button>
  <button class="hbtn" title="Settings (venv, Ollama, version check)" onclick="vscode.postMessage({command:'showSettings'})">⚙</button>
  <button class="hbtn" title="Help (keyboard shortcuts, commands, usage)" onclick="vscode.postMessage({command:'showHelp'})">❓</button>
</div>
<div id="vcsbar">
  <span>\uD83D\uDD00</span><span class="vb" id="vb">\u2014</span>
  <span id="vchg"></span>
  <span style="flex:1"></span>
  <span id="vwd" style="font-family:var(--mn);opacity:.7" title=""></span>
</div>
<div id="tmtr">
  <span>Context</span>
  <div id="ctrk"><div id="cfil"></div></div>
  <span id="cpct">0%</span><span id="tcnt">0+0</span><span id="tcst">$0.0000</span>
</div>
<div id="obn"><span>\u26a0</span><span id="obt">Context high</span>
  <button onclick="document.getElementById('obn').classList.remove('show')">\u2715</button></div>
<div id="chat"></div>
<div id="rh" title="Drag \u00b7 Dbl-click collapse"></div>
<div id="ibar">
  <div id="dh">📎 Drop files to inject as context</div>
  <div id="typ"><div class="d"></div><div class="d"></div><div class="d"></div>
    <span>Agent thinking…</span></div>
  <div id="ir">
    <textarea id="it" placeholder="Message AEE agent… (Enter to send · Shift+Enter newline · @ file)"></textarea>
    <button id="mainbtn" title="Send (Enter)" onclick="mainAct()">↑</button>
  </div>
  <div id="tr">
    <button class="tb2" onclick="q('audit')">🔍 audit</button>
    <button class="tb2" onclick="q('validate')">✅ validate</button>
    <button class="tb2" onclick="q('doctor')">🩺 doctor</button>
    <button class="tb2" onclick="q('epistemic')">🧠 epistemic</button>
    <button class="tb2" onclick="q('stress')">⚡ stress</button>
    <button class="tb2" onclick="q('/clear')">🗑 clear</button>
    <button class="tb2" onclick="q('status')">📊 status</button>
    <button class="tb2" onclick="pf()" title="Pick @file">@ file</button>
    <span class="kh">Enter sends · Shift+Enter newline</span>
  </div>
</div>
<script src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/** Format an ISO timestamp for display in history replay. */
function _fmtTs(iso: string): string {
  try {
    return new Date(iso).toLocaleString([], {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return ''; }
}
