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
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
    );

    const inst = new SessionPanel(panel, config, execPath, envOverrides, context.secrets, context.globalState, ollamaCtx);
    inst._availableProviders = availableProviders;
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
          // If auto-accept was previously set, skip buttons and auto-send yes
          if (this._autoAcceptAll) {
            this._bridge.send('yes, proceed');
            void this._panel.webview.postMessage({ type: 'system', message: '\u2713 Auto-accepted' } satisfies SpecsmithEvent);
          } else {
            setTimeout(() => {
              void this._panel.webview.postMessage({ type: 'proposal' } satisfies SpecsmithEvent);
            }, 100);
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
        emit(`⚠ Governance check found ${issues.length} issue(s):\n${issues.map(i => `  • ${i}`).join('\n')}`);
        // Ask the agent to help fix the issues
        setTimeout(() => {
          this._bridge.send(
            `[LANG:EN] The governance check found these issues:\n${issues.join('\n')}\n\n` +
            'Walk me through fixing each one. For each issue, explain what\'s wrong and what command to run.',
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
      const models = await fetchModels(provider, key);
      if (models.length > 0) {
        void this._panel.webview.postMessage({ type: 'models', models } satisfies SpecsmithEvent);
      }
      // If empty, don't send — the static models from init are already showing
    } catch {
      // API error — don't clear the model dropdown
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
    // NOTE: template literal escaping — JS regex backslashes doubled, template
    // literal backticks escaped with backslash inside the outer template.
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: 'unsafe-inline';">
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
<script>
const vscode=acquireVsCodeApi();
let curMdl='',busy=false,warned=false,lastU='';
const CTX={claude:200000,'gpt-4o':128000,o1:200000,o3:200000,gemini:1000000,mistral:128000};
function csize(m){const l=(m||'').toLowerCase();for(const[k,v]of Object.entries(CTX))if(l.includes(k))return v;return 128000}
function ts(){return new Date().toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'})}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function rmd(r){
  let s=esc(r);
  s=s.replace(/\`\`\`(\\S*)\\n([\\s\\S]*?)\`\`\`/g,(_,_l,c)=>\`<pre><code>\${c}</code></pre>\`);
  s=s.replace(/\`([^\`]+)\`/g,'<code>$1</code>');
  s=s.replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>');
  s=s.replace(/\\*([^*]+)\\*/g,'<em>$1</em>');
  s=s.replace(/\\n/g,'<br>');
  return s;
}
const C=document.getElementById('chat');
function sb2(){C.scrollTop=C.scrollHeight}
function addU(t,customTs){
  lastU=t;const d=document.createElement('div');d.className='mu';d.dataset.raw=t;
  d.innerHTML=\`<div class="bbl">\${esc(t)}</div><div class="mt">\${customTs||ts()}</div>
  <div class="mact"><button class="ab" title="Copy" onclick="cp(this)">⎘</button>
  <button class="ab" title="Edit" onclick="ed(this)">✏</button></div>\`;
  C.appendChild(d);sb2()}
function addA(t,customTs){const d=document.createElement('div');d.className='ma';d.dataset.raw=t;
  d.innerHTML=\`<div class="rtag">🧠 AEE Agent</div><div class="bbl">\${rmd(t)}</div>
  <div class="mt">\${customTs||ts()}</div><div class="mact">
  <button class="ab" title="Copy" onclick="cp(this)">⎘</button>
  <button class="ab" title="Regenerate" onclick="regen()">&#x21BA;</button></div>\`;
  C.appendChild(d);sb2()}
function extractErrSummary(r){
  if(!r)return'(empty result)';
  // Python traceback: find last exception line
  if(/Traceback \(most recent call last\)/i.test(r)){
    const lines=r.split('\\n').map(l=>l.trim()).filter(Boolean).reverse();
    for(const l of lines){
      if(/^(\\w*Error|Exception|RuntimeError|ValueError|TypeError|ImportError|ModuleNotFoundError|ValidationError|SystemExit)/.test(l))
        return 'Python error: '+l.slice(0,150);
    }
    return 'Python exception (see details)';
  }
  // Non-zero exit: use first meaningful line as summary
  const lines=r.split('\\n').map(l=>l.trim()).filter(l=>l&&!l.startsWith('#'));
  return lines[0]?.slice(0,150)||r.slice(0,150);
}
/* Human-readable tool name labels */
const _TLBL={audit:'Governance audit',validate:'Consistency check',doctor:'Tool check',
  epistemic_audit:'Epistemic audit',stress_test:'Stress test',belief_graph:'Belief graph',
  diff:'Drift check',export:'Compliance report',commit:'Commit',push:'Push',sync:'Sync',
  ledger_add:'Ledger entry',ledger_list:'Ledger list',read_file:'Reading file',
  write_file:'Writing file',list_dir:'Listing files',run_command:'Running command',
  req_list:'Requirements',req_gaps:'Coverage gaps',req_trace:'Traceability',
  read_wireframe:'Wireframe',retrieve_context:'Searching index',session_end:'Session end'};
function _tname(n){return _TLBL[n]||n}
/* Tool started: compact inline status — show meaningful context for each tool type */
function addTStart(n,args){
  const d=document.createElement('div');d.className='sl';
  const lbl=_tname(n);
  let hint='';
  if(n==='run_command'&&args&&args.command){
    // Show the actual command so the user knows what is running
    const cmd=String(args.command);
    hint=' \u2192 '+esc(cmd.length>80?cmd.slice(0,80)+'\u2026':cmd);
  }else if(args&&args.fix==='true'){hint=' (auto-fix)';}
  else if(args&&args.path){hint=' \u2014 '+String(args.path).split(/[\\/]/).pop();}
  else if(args&&args.content&&n==='write_file'){hint=' \u2014 writing';}
  d.innerHTML=\`<span style="color:var(--teal)">\u23f3 \${lbl}\${hint}\u2026</span><span class="mts">\${ts()}</span>\`;
  C.appendChild(d);sb2()}
function addT(n,r,e){
  // Treat [exit N] (non-zero subprocess exit) as an error for expandable display
  if(!e&&r&&/^\\[exit [1-9]/.test(r))e=true;
  const lbl=_tname(n);
  const d=document.createElement('div');d.className='tb'+(e?' er':'');
  if(e&&r&&r.length>80){
    const summary=extractErrSummary(r);
    // Add a Report Bug button for Python-level crashes (Traceback, ImportError, etc.)
    const isPyCrash=/Traceback \(most recent call last\)|ImportError|ModuleNotFoundError|AttributeError:|TypeError: |RuntimeError:/i.test(r);
    const rptBtn=isPyCrash
      ?\`<button onclick="rptTool(this,'\${esc(n)}','\${esc(r.slice(0,2000))}')"
          style="margin-top:6px;background:var(--red);color:#fff;border:none;border-radius:3px;padding:3px 8px;cursor:pointer;font-size:10px">\uD83D\uDC1B Report Bug</button>\`
      :'';
    d.innerHTML=\`<div class="thdr">\u274c \${esc(lbl)}</div>
      <details><summary class="tres" style="cursor:pointer;list-style:none">
        \${esc(summary)}<span style="font-size:9px;margin-left:4px;opacity:.6">(click for details)</span>
      </summary><pre class="err-detail" style="margin-top:4px;font-size:10px">\${esc(r.slice(0,3000))}\${r.length>3000?'\\n\u2026(truncated)':''}</pre>\${rptBtn}</details>\`;
  }else if(e){
    d.innerHTML=\`<div class="thdr">❌ \${esc(lbl)}</div><div class="tres">\${esc((r||'').slice(0,200))}</div>\`;
  }else{
    // Success: one-line compact pill — no raw dump, just a status tick
    const brief=_toolBrief(n,r||'');
    d.innerHTML=\`<div class="thdr" style="color:var(--teal)">✓ \${esc(lbl)} — \${esc(brief)}</div>\`;
  }
  C.appendChild(d);sb2()}
/* Parse a one-line human summary from tool output */
function _toolBrief(n,r){
  if(!r||r==='(no output)')return'done';
  if(n==='audit'||n==='validate'){const m=r.match(/(\\d+) (issue|check)/i);return m?m[0]:'done'}
  if(n==='doctor'){const m=r.match(/(\\d+) tool/i);return m?m[0]:'done'}
  const first=r.split('\\n').find(l=>l.trim()&&!l.startsWith('['));
  return(first||'done').trim().slice(0,60);}
/* Crash card: critical unexpected error — stop, show diagnostic, ask to report */
function addToolCrash(data){
  const repo=data.repo||'specsmith';
  const repoLabel=repo==='specsmith'?'specsmith CLI':'specsmith-vscode extension';
  const title=\`[\${repo}] \${data.tool||'tool'} crashed: \${(data.summary||'unexpected error').slice(0,80)}\`;
  const detail=[
    'Tool: '+esc(data.tool||'?'),
    'Error: '+esc(data.summary||'?'),
    'specsmith: '+esc(data.specsmith_version||'?'),
    'Python: '+esc(data.python_version||'?'),
    'OS: '+esc(data.os_info||'?'),
    data.project_type?'Project type: '+esc(data.project_type):'',
  ].filter(Boolean).join(' | ');
  const fullDetail=[
    '**Tool:** '+esc(data.tool||'?'),
    '**Error:** '+esc(data.summary||'?'),
    '**specsmith version:** '+esc(data.specsmith_version||'unknown'),
    '**Python:** '+esc(data.python_version||'?'),
    '**OS:** '+esc(data.os_info||'?'),
    data.project_type?'**Project type:** '+esc(data.project_type):'',
    data.detail?'\\n**Error detail:**\\n'+(data.detail||'').slice(0,3000):'',
  ].filter(Boolean).join('\\n');
  const d=document.createElement('div');
  d.style.cssText='background:rgba(244,71,71,.1);border:1px solid var(--red);border-left:4px solid var(--red);border-radius:6px;padding:10px 14px;margin:4px 0;';
  d.innerHTML=\`
    <div style="font-weight:600;color:var(--red);margin-bottom:6px">🚨 Something went wrong in the \${esc(repoLabel)}</div>
    <div style="font-size:12px;color:var(--fg);margin-bottom:2px"><strong>\${esc(data.tool||'?')}</strong> crashed: \${esc(data.summary||'unexpected error')}</div>
    <div style="font-size:11px;color:var(--dim);margin-bottom:8px">\${esc(detail)}</div>
    <div style="font-size:11px;color:var(--dim);margin-bottom:8px">The session has stopped. This is an unexpected error — not something you did wrong.</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button onclick="rptCrash(this,'\${esc(title)}','\${esc(fullDetail)}','\${esc(repo)}')"
        style="background:var(--red);color:#fff;border:none;border-radius:4px;padding:4px 10px;cursor:pointer;font-size:11px">🐛 Report Bug</button>
      <button onclick="this.closest('div[style]').remove()"
        style="background:none;border:1px solid var(--br);border-radius:4px;padding:4px 10px;cursor:pointer;font-size:11px;color:var(--dim)">Dismiss</button>
    </div>\`;
  C.appendChild(d);sb2();}
function rptTool(btn,toolName,output){
  const title='[specsmith] '+toolName+' tool crashed';
  const detail='**Tool:** '+toolName+'\\n**Error output:**\\n'+output.slice(0,2000);
  if(!confirm('Report this tool error to GitHub (BitConcepts/specsmith)?\\n\\nData sent:\\n\u2022 Tool name and error output\\n\\nNo personal data is included. Proceed?'))return;
  vscode.postMessage({command:'reportBug',bugTitle:title.slice(0,100),bugDetail:detail.slice(0,3000)});
  btn.textContent='\u2713 Reported';btn.disabled=true;}
function rptCrash(btn,title,detail,repo){
  if(!confirm('Report this bug to GitHub (BitConcepts/'+repo+')?\\n\\nData sent:\\n• Tool name + error message\\n• specsmith version, Python version, OS\\n• Error detail text\\n\\nNo personal data is included. You can review the full report before it is filed.\\n\\nProceed?'))return;
  vscode.postMessage({command:'reportBug',bugTitle:'['+repo+'] '+title.slice(0,100),bugDetail:detail.slice(0,3000)});
  btn.textContent='✓ Reported';btn.disabled=true;}
function addS(m){
  const d=document.createElement('div');d.className='sl';
  d.innerHTML=\`<span>\${esc(m)}</span><span class="mts">\${ts()}</span>\`;
  C.appendChild(d);sb2()}
/* Known specsmith error patterns → short human-friendly message */
const ERR_MAP=[
  [/No such command 'run'/,                'specsmith version too old — upgrade: Ctrl+Shift+P → specsmith: Install or Upgrade'],
  [/No such option.*json-events/,          'specsmith < v0.3.1 — Ctrl+Shift+P → specsmith: Install or Upgrade'],
  [/invalid_api_key|Incorrect API key/i,   'Invalid API key — reset via: Ctrl+Shift+P → specsmith: Set API Key'],
  [/error code.*401|status.*401/i,         'Authentication failed (401) — check your API key: Ctrl+Shift+P → specsmith: Set API Key'],
  [/Provider error.*401/i,                 'Wrong API key (401) — Ctrl+Shift+P → specsmith: Set API Key'],
  [/ECONNREFUSED|connection refused/i,      'Ollama not running — start it: run ollama serve or open the Ollama app'],
  [/404.*model|model.*not found/i,          'Model not downloaded — Ctrl+Shift+P → specsmith: Download Ollama Model'],
  [/Ollama model not found/i,               'Ollama model not installed — select a model from the dropdown or use: specsmith ollama pull <model>'],
  [/HTTP Error 404/i,                       'Ollama 404 — model not installed. Pick an installed model from the dropdown (Installed group)'],
  [/failed to load model/i,                 'Model failed to load — may need more VRAM or a smaller model'],
  [/insufficient_quota|exceeded.*quota/i,  'OpenAI quota exceeded — add credits at platform.openai.com/settings/billing'],
  [/Provider error.*429/i,                 'Rate limit (429) — quota exceeded, add billing credits or wait and retry'],
  [/error code.*429/i,                     'Rate limit (429) — quota exceeded or too many requests'],
  [/No API key/i,                          'No API key set — Ctrl+Shift+P → specsmith: Set API Key'],
  [/ANTHROPIC_API_KEY/,                    'Anthropic API key missing — Ctrl+Shift+P → specsmith: Set API Key'],
  [/OPENAI_API_KEY/,                       'OpenAI API key missing — Ctrl+Shift+P → specsmith: Set API Key'],
  [/GOOGLE_API_KEY/,                       'Google API key missing — Ctrl+Shift+P → specsmith: Set API Key'],
  [/MISTRAL_API_KEY/,                      'Mistral API key missing — Ctrl+Shift+P → specsmith: Set API Key'],
  [/Usage:.*specsmith.*COMMAND/s,          'specsmith CLI error — see details'],
  // Python tracebacks and crashes
  [/Traceback \(most recent call last\)/i,  'specsmith crashed — Python exception (click for details)'],
  [/ValidationError.*type|input should be.*ProjectType/i, 'scaffold.yml has an unsupported project type — open scaffold.yml and check the type field'],
  [/ModuleNotFoundError.*specsmith/i,       'specsmith is missing a module — try: specsmith: Install or Upgrade'],
  [/ImportError/i,                          'specsmith import error — try reinstalling via: pipx upgrade specsmith'],
  // Ollama 400
  [/HTTP Error 400|Bad Request/i,           'Ollama 400 — model does not support tool calling. Try a cloud provider (Anthropic/OpenAI) or a newer Ollama model.'],
  // Generic non-zero exit
  [/\[exit [1-9]/,                          'Command failed — see error detail above'],
];
function smartErr(m){
  for(const[re,msg]of ERR_MAP){if(re.test(m))return{short:msg,long:m}}
  const lines=m.split('\\n').map(l=>l.trim()).filter(Boolean);
  return lines.length>1?{short:lines[0],long:lines.slice(1).join('\\n')}:{short:m,long:''};
}
function addE(m){
  const{short,long}=smartErr(m||'?');
  const d=document.createElement('div');d.className='el';
  const bugBtn=\`<button class="ab" title="Report this bug" style="margin-top:4px;font-size:10px;color:var(--dim)" onclick="rptBug(this)">🐛 Report</button>\`;
  if(long){
    d.innerHTML=\`<details><summary>\u26a0 \${esc(short)}</summary><pre class="err-detail">\${esc(long)}</pre></details>\${bugBtn}\`;
  }else{
    d.innerHTML=\`<span>\u26a0 \${esc(short)}</span>\${bugBtn}\`;
  }
  d.dataset.errTitle=short;
  d.dataset.errDetail=long||'';
  C.appendChild(d);sb2()}
function rptBug(btn){
  const el=btn.closest('.el');const t=el?.dataset.errTitle||'specsmith error';const det=el?.dataset.errDetail||'';
  // Show consent summary before sending anything
  const preview=det?t.slice(0,80)+'\\n\\nError detail will be included (may contain file paths).':t.slice(0,80);
  if(!confirm('Report this bug to GitHub?\\n\\nWhat will be sent:\\n• Error summary\\n• specsmith version\\n• VS Code version + OS\\n• Error detail text (may include local file paths)\\n\\n'+preview+'\\n\\nThis will search BitConcepts/specsmith-vscode for a duplicate issue and either comment on it or create a new one. Proceed?'))return;
  vscode.postMessage({command:'reportBug',bugTitle:'[specsmith-vscode] '+t.slice(0,100),bugDetail:det.slice(0,3000)});
  btn.textContent='✓ Reported';btn.disabled=true;}
function addImg(u,l){const d=document.createElement('div');d.className='mu';
  d.innerHTML=\`<div class="bbl"><div style="font-size:11px;color:var(--dim);margin-bottom:4px">📎 \${esc(l)}</div>
  <img class="iprev" src="\${u}" alt="\${esc(l)}"></div><div class="mt">\${ts()}</div>\`;
  C.appendChild(d);sb2()}
function updTok(i,o,c){const t=i+o,sz=csize(curMdl),p=Math.min(100,Math.round(t/sz*100));
  const f=document.getElementById('cfil');f.style.width=p+'%';
  f.style.background=p>=90?'var(--red)':p>=70?'var(--amb)':'var(--grn)';
  document.getElementById('cpct').textContent=p+'%';
  document.getElementById('tcnt').textContent=i.toLocaleString()+'+'+o.toLocaleString();
  document.getElementById('tcst').textContent='$'+Number(c||0).toFixed(4);
  if(p>=70&&!warned){warned=true;document.getElementById('obn').classList.add('show');
    document.getElementById('obt').textContent=\`Context \${p}% — /clear or Audit/Compress\`}}
function mainAct(){if(busy)stp();else snd()}
function setBusy(v){busy=v;document.getElementById('it').disabled=v;
  document.getElementById('typ').className=v?'show':'';
  const b=document.getElementById('mainbtn');
  b.textContent=v?'◼':'↑';b.title=v?'Stop agent (click or Esc)':'Send (Enter)';
  if(v)b.classList.add('busy');else b.classList.remove('busy');
  document.querySelectorAll('.tb2').forEach(b=>b.disabled=v)}
function snd(){if(busy)return;const i=document.getElementById('it'),t=i.value.trim();if(!t)return;
  i.value='';addU(t);setBusy(true);vscode.postMessage({command:'send',text:t})}
function stp(){vscode.postMessage({command:'stop'});setBusy(false)}
function q(c){if(busy)return;addS('> '+c);setBusy(true);vscode.postMessage({command:'send',text:c})}
function openProj(){const l=document.getElementById('dlbl').title;if(l)vscode.postMessage({command:'openFile',filePath:l})}
function cp(btn){const c=btn.closest('[data-raw]');navigator.clipboard.writeText(c?.dataset.raw||c?.querySelector('.bbl')?.textContent||'').catch(()=>{})}
function ed(btn){const c=btn.closest('[data-raw]'),t=c?.dataset.raw||'';document.getElementById('it').value=t;document.getElementById('it').focus()}
function regen(){if(busy||!lastU)return;setBusy(true);vscode.postMessage({command:'send',text:lastU})}
function exportChat(){const ms=[];C.querySelectorAll('[data-raw]').forEach(el=>{const u=el.classList.contains('mu');ms.push((u?'**You:** ':'**Agent:** ')+(el.dataset.raw||''))});
  const md='# specsmith Chat\\n'+new Date().toISOString()+'\\n\\n'+ms.join('\\n\\n---\\n\\n');
  vscode.postMessage({command:'exportChat',markdown:md})}
function pf(){vscode.postMessage({command:'pickFile'})}
function copyAll(){
  const ms=[];C.querySelectorAll('[data-raw]').forEach(el=>{
    const u=el.classList.contains('mu');
    ms.push((u?'**You ('+el.querySelector('.mt')?.textContent+'):** ':'**Agent:** ')+(el.dataset.raw||''))});
  const txt=ms.join('\\n\\n---\\n\\n');
  navigator.clipboard.writeText(txt).then(()=>{
    const b=document.getElementById('cab');if(!b)return;
    const prev=b.textContent;b.textContent='✓';
    setTimeout(()=>b.textContent=prev,1200);
  }).catch(()=>{});
}
function doClearHistory(){
  if(busy&&!confirm('Agent is running. Clear anyway?'))return;
  vscode.postMessage({command:'clearHistory'});
}
document.getElementById('it').addEventListener('keydown',e=>{
  /* Enter alone = send; Ctrl+Enter or Shift+Enter = insert newline (default) */
  if(e.key==='Enter'&&!e.shiftKey&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();snd();return}
  if(e.key==='Escape'&&busy){e.preventDefault();stp();return}
  if(e.key==='ArrowUp'&&!e.target.value.trim()){e.preventDefault();e.target.value=lastU;e.target.setSelectionRange(lastU.length,lastU.length)}
  if(e.key==='@'&&!e.target.value.trim()){e.preventDefault();pf()}})
function popMdl(prov,mdls,sel){
  const s=document.getElementById('ms');const pr=sel||s.value;s.innerHTML='';
  const list=mdls&&mdls.length?mdls:[];
  /* Group by category into <optgroup> */
  const groups={};
  for(const m of list){const c=m.category||'Models';(groups[c]=groups[c]||[]).push(m)}
  const cats=Object.keys(groups);
  if(cats.length>1){
    for(const cat of cats){
      const og=document.createElement('optgroup');og.label=cat;
      for(const m of groups[cat]){
        const o=document.createElement('option');o.value=m.id;
        o.textContent=m.name||m.id;
        const ctx=m.contextWindow?(m.contextWindow>=1000000?Math.round(m.contextWindow/1000000)+'M ctx':Math.round(m.contextWindow/1000)+'K ctx'):'';
        o.title=[m.description||'',ctx].filter(Boolean).join(' • ');
        og.appendChild(o);
      }
      s.appendChild(og);
    }
  }else{
    for(const m of list){
      const o=document.createElement('option');o.value=m.id;o.textContent=m.name||m.id;
      const ctx=m.contextWindow?(m.contextWindow>=1000000?Math.round(m.contextWindow/1000000)+'M ctx':Math.round(m.contextWindow/1000)+'K ctx'):'';
      o.title=[m.description||'',ctx].filter(Boolean).join(' • ');
      s.appendChild(o);
    }
  }
  if(pr&&[...s.options].some(o=>o.value===pr))s.value=pr;
  curMdl=s.value;updDesc()}
function updDesc(){const s=document.getElementById('ms'),o=s.options[s.selectedIndex],d=document.getElementById('mdesc');d.textContent=o?.title||'';d.title=o?.title||''}
document.getElementById('ps').addEventListener('change',e=>{const p=e.target.value;
  vscode.postMessage({command:'setProvider',provider:p});vscode.postMessage({command:'getModels',provider:p})});
document.getElementById('ms').addEventListener('change',e=>{
  const val=e.target.value;
  if(val.startsWith('dl:')){
    // Not downloaded yet — restore previous selection and ask host to download
    e.target.value=curMdl;
    const realId=val.slice(3);
    vscode.postMessage({command:'downloadModel',model:realId});
  }else{
    curMdl=val;updDesc();
    vscode.postMessage({command:'setModel',model:curMdl});
  }
});
/* Drag and drop — uses dragover polling (reliable; no stuck-overlay bug) */
const _IB=document.getElementById('ibar');let _dt;
function _dsh(){_IB.classList.add('da')}
function _dhd(){clearTimeout(_dt);_IB.classList.remove('da')}
document.addEventListener('dragover',e=>{
  e.preventDefault();
  _dsh();
  clearTimeout(_dt);
  _dt=setTimeout(_dhd,400); // auto-hide if drag stops/leaves without drop
});
document.addEventListener('drop',e=>{
  e.preventDefault();_dhd();
  const f=e.dataTransfer?.files;if(f)for(const fi of f)inj(fi);
});
document.addEventListener('dragleave',e=>{
  // Only hide when cursor leaves the entire document (not just an element)
  if(!e.relatedTarget||e.relatedTarget===document.documentElement)_dhd();
});
/* Paste images + text */
document.addEventListener('paste',e=>{
  const items=e.clipboardData?.items||[];
  for(const it of items){
    if(it.type.startsWith('image/')){const f=it.getAsFile();if(f){e.preventDefault();inj(f)}}
    else if(it.type==='text/plain'){
      // Allow default paste for plain text in the textarea
    }
  }
});
/* Smart injection — handles images, text, large files, PDFs, and binaries.
   file.path is a VS Code webview extension to DataTransfer File that gives
   the absolute local path for files dragged from the OS or VS Code explorer. */
const _INLINE_LIMIT=50*1024; // 50 KB — above this use path reference
const _TEXT_EXTS=/\\.(md|txt|py|pyi|ts|tsx|js|jsx|json|yaml|yml|toml|sh|bash|zsh|ps1|go|rs|c|cc|cpp|cxx|h|hpp|cs|java|kt|swift|rb|php|sql|xml|css|scss|less|html|htm|vue|svelte|vhd|vhdl|sv|v|tcl|cmake|makefile|dockerfile|conf|ini|env|gitignore|editorconfig)$/i;
function _ext(name){return(name.split('.').pop()||'').toLowerCase()}
function _kb(sz){return sz<1024?sz+'B':(sz<1048576?(sz/1024).toFixed(0)+'KB':(sz/1048576).toFixed(1)+'MB')}
function inj(file){
  const im=file.type.startsWith('image/');
  const isPdf=file.type==='application/pdf'||/\\.pdf$/i.test(file.name);
  const isTxt=file.type.startsWith('text/')||_TEXT_EXTS.test(file.name);
  const fp=file.path||''; // VS Code webview provides full OS path for local file drops
  const it=document.getElementById('it');
  const rd=new FileReader();
  if(im){
    // Images: thumbnail in chat + [Image:] prefix in input
    rd.onload=ev=>{const u=ev.target.result;addImg(u,file.name);it.value=\`[Image: \${fp||file.name}]\\n\${it.value}\`};
    rd.readAsDataURL(file);
  }else if(isPdf){
    // PDFs: path reference with read_file note (no binary inline)
    const ref=fp||file.name;
    it.value=\`[PDF: \${ref} (\${_kb(file.size)}) — use read_file tool to parse content]\\n\\n\${it.value}\`;
    addS(\`📎 PDF attached: \${file.name}\`);
  }else if(isTxt&&file.size<=_INLINE_LIMIT){
    // Small text files: inline as fenced code block
    rd.onload=ev=>{
      const c=ev.target.result;
      const lang=_ext(file.name);
      it.value=\`[File: \${fp||file.name}]\\n\\\`\\\`\\\`\${lang}\\n\${c}\\n\\\`\\\`\\\`\\n\\n\${it.value}\`;
      it.focus();
    };
    rd.readAsText(file);
  }else if(isTxt&&file.size>_INLINE_LIMIT){
    // Large text files: path reference + short preview
    rd.onload=ev=>{
      const preview=ev.target.result.split('\\n').slice(0,6).join('\\n');
      const ref=fp||file.name;
      it.value=\`[Large file: \${ref} (\${_kb(file.size)}) — use read_file tool for full content]\\nPreview:\\n\${preview}\\n…\\n\\n\${it.value}\`;
    };
    rd.readAsText(file);
  }else if(fp){
    // Binary with known path: inject reference
    it.value=\`[File: \${fp} (binary \${_kb(file.size)}) — use read_file tool to access]\\n\\n\${it.value}\`;
    addS(\`📎 Binary attached: \${file.name}\`);
  }else{
    addS(\`Cannot inject \${file.name} (binary \${_kb(file.size)}) — drag from VS Code explorer to get a path reference\`);
  }
}
/* Resize handle — controls TEXTAREA height. Drag UP = bigger textarea, drag DOWN = smaller.
   Chat takes all remaining space (flex:1) so it auto-shrinks as textarea grows. */
(()=>{
  const h=document.getElementById('rh'),ta=document.getElementById('it');
  let dr=false,sy=0,sh=0;
  h.addEventListener('mousedown',e=>{dr=true;sy=e.clientY;sh=parseFloat(ta.style.height)||ta.getBoundingClientRect().height;h.classList.add('drag');e.preventDefault()});
  document.addEventListener('mousemove',e=>{
    if(!dr)return;
    const delta=sy-e.clientY; // drag UP = positive delta = bigger textarea
    const nh=Math.max(38,Math.min(320,sh+delta));
    ta.style.height=nh+'px';
  });
  document.addEventListener('mouseup',()=>{dr=false;h.classList.remove('drag')});
  h.addEventListener('dblclick',()=>{
    const cur=parseFloat(ta.style.height)||38;
    ta.style.height=(cur<=42?120:38)+'px';
  });
})();
/* Messages from host */
window.addEventListener('message',({data})=>{switch(data.type){
  case 'init':if(data.provider){document.getElementById('ps').value=data.provider;popMdl(data.provider,data.models||[],data.model)}
    if(data.projectDir){const l=document.getElementById('dlbl');l.textContent=data.projectDir.split(/[\\\\/]/).pop()||data.projectDir;l.title=data.projectDir}
    if(data.availableProviders){const ps=document.getElementById('ps');for(const o of ps.options){if(!data.availableProviders.includes(o.value)){o.disabled=true;o.textContent=o.value+' (no key)'}}}break;
  case 'models':popMdl(document.getElementById('ps').value,data.models,curMdl);break;
  case 'ready':setBusy(false);addS(\`AEE Agent ready — \${data.provider||''}/\${data.model||''} (\${data.tools||0} tools)\`);
    if(data.project_dir){const l=document.getElementById('dlbl');l.textContent=data.project_dir.split(/[\\\\/]/).pop();l.title=data.project_dir}break;
  case 'llm_chunk':addA(data.text||'');break;
  case 'tool_started':addTStart(data.name||'?',data.args||{});break;
  case 'tool_finished':addT(data.name||'?',data.result||'',!!data.is_error);break;
  case 'tool_crash':addToolCrash(data);setBusy(false);break;
  case 'tokens':updTok(data.in_tokens||0,data.out_tokens||0,data.cost_usd||0);break;
  case 'turn_done':setBusy(false);break;
  case 'error':addE(data.message);setBusy(false);break;
  case 'system':addS(data.message||'');break;
  case 'vcs_state':{
    const vb=document.getElementById('vb'),vc=document.getElementById('vchg'),vw=document.getElementById('vwd');
    if(vb)vb.textContent=data.branch||'\u2014';
    if(vc){const n=data.changes||0;vc.textContent=n>0?n+' change'+(n!==1?'s':''):'clean';vc.className=n>0?'vc':'';}
    if(vw&&data.projectDir){const p=data.projectDir.replace(/\\\\/g,'/');const short=p.split('/').slice(-2).join('/');vw.textContent=short;vw.title=p;}
    break;}
  case 'clear_display':
    C.innerHTML='';
    warned=false;
    document.getElementById('obn').classList.remove('show');
    addS(data.message||'Chat cleared.');
    setBusy(false);
    break;
  case 'history_user':
    addU(data.text||'', data.message); // data.message = historical timestamp
    break;
  case 'history_agent':
    addA(data.text||'', data.message);
    break;
  case 'file_picked':if(data.isImage&&data.dataUrl){addImg(data.dataUrl,data.fileName||'img');const i=document.getElementById('it');i.value=\`[Image: \${data.fileName}]\\n\${i.value}\`}
    else if(data.fileContent!==undefined){
      const i=document.getElementById('it');
      // Path/reference blocks start with '[' — inject verbatim without fenced block wrapper
      if(data.fileContent.startsWith('[')){
        i.value=\`\${data.fileContent}\\n\\n\${i.value}\`;
      }else{
        const lang=(data.fileName||'').split('.').pop()||'';
        i.value=\`[File: \${data.fileName}]\\n\\\`\\\`\\\`\${lang}\\n\${data.fileContent}\\n\\\`\\\`\\\`\\n\\n\${i.value}\`;
      }
      i.focus();
    }break;
  case 'proposal':{
    var pd=document.createElement('div');
    pd.style.cssText='display:flex;gap:6px;padding:4px 8px;align-self:flex-start';
    var ab=document.createElement('button');
    ab.textContent='\u2713 Accept';
    ab.style.cssText='background:var(--bb);color:var(--bf);border:none;border-radius:4px;padding:3px 10px;cursor:pointer;font-size:11px;font-weight:600';
    ab.onclick=function(){pd.remove();setBusy(true);vscode.postMessage({command:'send',text:'yes, proceed'});};
    var rb=document.createElement('button');
    rb.textContent='\u2717 Reject';
    rb.style.cssText='background:none;border:1px solid var(--br);color:var(--dim);border-radius:4px;padding:3px 10px;cursor:pointer;font-size:11px';
    rb.onclick=function(){pd.remove();setBusy(true);vscode.postMessage({command:'send',text:'no, skip this'});};
    var aab=document.createElement('button');
    aab.textContent='\u2713\u2713 Accept All';
    aab.style.cssText='background:rgba(78,201,176,.15);border:1px solid var(--teal);color:var(--teal);border-radius:4px;padding:3px 10px;cursor:pointer;font-size:11px;font-weight:600';
    aab.onclick=function(){pd.remove();setBusy(true);vscode.postMessage({command:'setAutoAccept'});vscode.postMessage({command:'send',text:'yes, proceed with everything'});};
    pd.appendChild(ab);pd.appendChild(rb);pd.appendChild(aab);
    C.appendChild(pd);sb2();
    break;}
}});
vscode.postMessage({command:'ready'});
</script>
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
