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
  private _status: SessionStatus = 'starting';
  private _disposables: vscode.Disposable[] = [];
  private readonly _secrets: vscode.SecretStorage;
  private readonly _globalState: vscode.Memento;
  private _chatFile: string | undefined;
  private _chatStream: fs.WriteStream | undefined;

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
      }
    }

    const config: SessionConfig = { projectDir, provider, model, sessionId: Date.now().toString() };
    const panel = vscode.window.createWebviewPanel(
      'specsmithSession',
      `🧠 ${path.basename(projectDir)}`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
    );

    const inst = new SessionPanel(panel, config, execPath, envOverrides, context.secrets, context.globalState);
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
  ) {
    this._panel       = panel;
    this._config      = config;
    this._secrets     = secrets;
    this._globalState = globalState;
    this._initChatHistory();
    this._bridge  = new SpecsmithBridge(execPath, config, envOverrides);

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
        } satisfies SpecsmithEvent);
        // Offer previous chat session replay
        const prev = this._loadPreviousChat();
        if (prev.length > 0) {
          void this._panel.webview.postMessage({ type: 'system', message: `── Previous session (${prev.length} messages) ──` } satisfies SpecsmithEvent);
          for (const e of prev) {
            if (e.role === 'user')   { void this._panel.webview.postMessage({ type: 'system', message: `You: ${e.text.slice(0, 120)}${e.text.length > 120 ? '…' : ''}` }); }
            else if (e.role === 'agent') { void this._panel.webview.postMessage({ type: 'llm_chunk', text: e.text }); }
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

      case 'pickFile':
        void vscode.window.showOpenDialog({
          canSelectMany: false, canSelectFiles: true, canSelectFolders: false,
          defaultUri: vscode.Uri.file(this._config.projectDir),
          title: 'Inject a file as context',
        }).then((uris) => {
          if (!uris?.[0]) { return; }
          const fp = uris[0].fsPath;
          const fn = path.basename(fp);
          const ext = path.extname(fp).toLowerCase();
          const imgs = new Set(['.png','.jpg','.jpeg','.gif','.webp','.bmp','.svg']);
          if (imgs.has(ext)) {
            const b64  = fs.readFileSync(fp).toString('base64');
            const mime = ext === '.svg' ? 'image/svg+xml' : `image/${ext.slice(1)}`;
            void this._panel.webview.postMessage({
              type: 'file_picked', fileName: fn, isImage: true,
              dataUrl: `data:${mime};base64,${b64}`,
            } satisfies SpecsmithEvent);
          } else {
            try {
              const content = fs.readFileSync(fp, 'utf8');
              void this._panel.webview.postMessage({
                type: 'file_picked', fileName: fn, isImage: false,
                fileContent: content.slice(0, 50000),
              } satisfies SpecsmithEvent);
            } catch {
              void this._panel.webview.postMessage({
                type: 'system', message: `Cannot read ${fn} as text`,
              } satisfies SpecsmithEvent);
            }
          }
        });
        break;

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
        if (msg.filePath) { void vscode.window.showTextDocument(vscode.Uri.file(msg.filePath)); }
        break;
    }
  }

  private async _refreshModels(provider: string): Promise<void> {
    const key    = await ApiKeyManager.getKey(this._secrets, provider);
    const models = await fetchModels(provider, key);
    void this._panel.webview.postMessage({ type: 'models', models } satisfies SpecsmithEvent);
  }

  // ── Settings persistence ───────────────────────────────────────────────────

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
  #chat{flex:1 1 auto;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:5px;min-height:140px}
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
  .sl{align-self:center;color:var(--dim);font-size:11px;font-style:italic;text-align:center}
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
  #dov{display:none;position:fixed;inset:0;z-index:999;background:rgba(78,201,176,.12);border:3px dashed var(--teal);border-radius:8px;align-items:center;justify-content:center;font-size:18px;color:var(--teal);pointer-events:none}
  #dov.show{display:flex}
  #tmtr{display:flex;align-items:center;gap:8px;padding:3px 10px;background:var(--sf);border-top:1px solid var(--br);font-size:11px;color:var(--dim);flex-shrink:0}
  #ctrk{flex:1;height:4px;background:var(--br);border-radius:2px;overflow:hidden}
  #cfil{height:100%;width:0%;background:var(--grn);border-radius:2px;transition:width .4s,background .4s}
  #cpct{min-width:28px;text-align:right}
  #tcst{color:var(--teal);font-weight:600}
  #obn{display:none;align-items:center;gap:8px;padding:4px 10px;background:rgba(206,145,120,.1);border-top:1px solid var(--amb);font-size:11px;color:var(--amb);flex-shrink:0}
  #obn.show{display:flex}
  #obn button{background:none;border:none;color:var(--amb);cursor:pointer;font-size:13px;margin-left:auto}
  #ibar{display:flex;flex-direction:column;gap:4px;padding:6px 10px;background:var(--sf);border-top:1px solid var(--br);flex-shrink:0}
  #ir{display:flex;gap:5px;align-items:flex-end}
  #it{flex:1;background:var(--ib);color:var(--if);border:1px solid var(--br);border-radius:5px;padding:6px 9px;font-family:var(--fn);font-size:13px;resize:none;min-height:38px;max-height:110px;line-height:1.4}
  #it:focus{outline:1px solid var(--teal);border-color:var(--teal)}
  #it:disabled{opacity:.5}
  #mainbtn{width:40px;height:40px;border:none;border-radius:50%;background:var(--bb);color:var(--bf);cursor:pointer;font-size:18px;font-weight:700;flex-shrink:0;transition:background .15s,transform .1s;align-self:flex-end}
  #mainbtn:hover:not(:disabled){background:var(--bh);transform:scale(1.07)}
  #mainbtn:disabled{opacity:.45;cursor:not-allowed}
  #mainbtn.busy{background:var(--red)!important}
  #tr{display:flex;gap:4px;flex-wrap:wrap;align-items:center}
  .tb2{background:none;border:1px solid var(--br);border-radius:3px;color:var(--dim);padding:1px 6px;cursor:pointer;font-size:10px;font-family:var(--fn);transition:border-color .15s,color .15s}
  .tb2:hover:not(:disabled){border-color:var(--teal);color:var(--teal)}
  .tb2:disabled{opacity:.4;cursor:not-allowed}
  .kh{font-size:10px;color:var(--dim);margin-left:auto}
  #typ{display:none;gap:5px;align-items:center;color:var(--teal);font-size:11px}
  #typ.show{display:flex}
  .d{width:5px;height:5px;background:var(--teal);border-radius:50%;animation:b 1.1s infinite}
  .d:nth-child(2){animation-delay:.18s}
  .d:nth-child(3){animation-delay:.36s}
  @keyframes b{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-5px)}}
</style>
</head>
<body>
<div id="dov">📎 Drop files to inject as context</div>
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
  <button class="hbtn" title="Export chat" onclick="exportChat()">⬇</button>
  <button class="hbtn" title="Help" onclick="vscode.postMessage({command:'openFile',filePath:''})">❓</button>
</div>
<div id="chat" ondragover="dvr(event)" ondragleave="dlv()" ondrop="ddp(event)"></div>
<div id="rh" title="Drag · Dbl-click collapse"></div>
<div id="obn"><span>⚠</span><span id="obt">Context high</span>
  <button onclick="document.getElementById('obn').classList.remove('show')">✕</button></div>
<div id="tmtr">
  <span>Context</span>
  <div id="ctrk"><div id="cfil"></div></div>
  <span id="cpct">0%</span><span id="tcnt">0+0</span><span id="tcst">$0.0000</span>
</div>
<div id="ibar">
  <div id="typ"><div class="d"></div><div class="d"></div><div class="d"></div>
    <span>Agent thinking…</span></div>
  <div id="ir">
    <textarea id="it" rows="2" placeholder="Message AEE agent… (Enter to send · Shift+Enter newline · @ file · drag/drop)"></textarea>
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
function addU(t){lastU=t;const d=document.createElement('div');d.className='mu';d.dataset.raw=t;
  d.innerHTML=\`<div class="bbl">\${esc(t)}</div><div class="mt">\${ts()}</div>
  <div class="mact"><button class="ab" title="Copy" onclick="cp(this)">⎘</button>
  <button class="ab" title="Edit" onclick="ed(this)">✏</button></div>\`;
  C.appendChild(d);sb2()}
function addA(t){const d=document.createElement('div');d.className='ma';d.dataset.raw=t;
  d.innerHTML=\`<div class="rtag">🧠 AEE Agent</div><div class="bbl">\${rmd(t)}</div>
  <div class="mt">\${ts()}</div><div class="mact">
  <button class="ab" title="Copy" onclick="cp(this)">⎘</button>
  <button class="ab" title="Regenerate" onclick="regen()">↺</button></div>\`;
  C.appendChild(d);sb2()}
function addT(n,r,e){const d=document.createElement('div');d.className='tb'+(e?' er':'');
  d.innerHTML=\`<div class="thdr">\${e?'❌':'✅'} \${esc(n)}</div>
  <div class="tres">\${esc((r||'').slice(0,500))}\${(r||'').length>500?'<em>…</em>':''}</div>\`;
  C.appendChild(d);sb2()}
function addS(m){const d=document.createElement('div');d.className='sl';d.textContent=m;C.appendChild(d);sb2()}
/* Known specsmith error patterns → short human-friendly message */
const ERR_MAP=[
  [/No such command 'run'/,        'specsmith version too old — upgrade: pip install --upgrade specsmith'],
  [/No such option.*json-events/,  'specsmith < v0.3.1 — upgrade: pip install --upgrade specsmith'],
  [/No API key/i,                  'No API key set — Ctrl+Shift+P → specsmith: Set API Key'],
  [/ANTHROPIC_API_KEY/,            'Anthropic API key missing — run: specsmith: Set API Key'],
  [/OPENAI_API_KEY/,               'OpenAI API key missing — run: specsmith: Set API Key'],
  [/Usage:.*specsmith.*COMMAND/s,  'specsmith CLI error — see details'],
];
function smartErr(m){
  for(const[re,msg]of ERR_MAP){if(re.test(m))return{short:msg,long:m}}
  const lines=m.split('\\n').map(l=>l.trim()).filter(Boolean);
  return lines.length>1?{short:lines[0],long:lines.slice(1).join('\\n')}:{short:m,long:''};
}
function addE(m){
  const{short,long}=smartErr(m||'?');
  const d=document.createElement('div');d.className='el';
  if(long){
    d.innerHTML=\`<details><summary>\u26a0 \${esc(short)}</summary><pre class="err-detail">\${esc(long)}</pre></details>\`;
  }else{
    d.textContent='\u26a0 '+short;
  }
  C.appendChild(d);sb2()}
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
document.getElementById('ms').addEventListener('change',e=>{curMdl=e.target.value;updDesc();vscode.postMessage({command:'setModel',model:curMdl})});
/* Drag and drop */
let dc=0;
document.addEventListener('dragenter',()=>{dc++;document.getElementById('dov').classList.add('show')});
document.addEventListener('dragleave',()=>{if(--dc<=0){dc=0;document.getElementById('dov').classList.remove('show')}});
function dvr(e){e.preventDefault()}function dlv(){}
function ddp(e){e.preventDefault();dc=0;document.getElementById('dov').classList.remove('show');
  const f=e.dataTransfer?.files;if(f)for(const fi of f)inj(fi)}
/* Paste images */
document.addEventListener('paste',e=>{const items=e.clipboardData?.items||[];for(const it of items){if(it.type.startsWith('image/')){const f=it.getAsFile();if(f){e.preventDefault();inj(f)}}}});
function inj(file){const im=file.type.startsWith('image/'),tx=file.type.startsWith('text/')||/\\.(md|txt|py|ts|js|json|yaml|yml|toml|sh|go|rs|c|cpp|h|cs|java)$/i.test(file.name);const rd=new FileReader();
  if(im){rd.onload=ev=>{const u=ev.target.result;addImg(u,file.name);const i=document.getElementById('it');i.value=\`[Image: \${file.name}]\\n\${i.value}\`};rd.readAsDataURL(file)}
  else if(tx||file.size<500000){rd.onload=ev=>{const c=ev.target.result;const p=c.length>8000?c.slice(0,8000)+'\\n…':c;const i=document.getElementById('it');i.value=\`[File: \${file.name}]\\n\\\`\\\`\\\`\\n\${p}\\n\\\`\\\`\\\`\\n\\n\${i.value}\`};rd.readAsText(file)}
  else addS(\`Cannot inject \${file.name} (binary)\`)}
/* Resize handle */
(()=>{const h=document.getElementById('rh'),ce=document.getElementById('chat');let dr=false,sy=0,sh=0,col=false,sv=0;
  h.addEventListener('mousedown',e=>{dr=true;sy=e.clientY;sh=ce.getBoundingClientRect().height;h.classList.add('drag');e.preventDefault()});
  document.addEventListener('mousemove',e=>{if(!dr)return;const d=e.clientY-sy,nh=Math.max(140,sh+d);ce.style.flex='none';ce.style.height=nh+'px'});
  document.addEventListener('mouseup',()=>{dr=false;h.classList.remove('drag')});
  h.addEventListener('dblclick',()=>{if(col){ce.style.height=sv+'px';col=false}else{sv=ce.getBoundingClientRect().height;ce.style.flex='none';ce.style.height='140px';col=true}})})();
/* Messages from host */
window.addEventListener('message',({data})=>{switch(data.type){
  case 'init':if(data.provider){document.getElementById('ps').value=data.provider;popMdl(data.provider,data.models||[],data.model)}
    if(data.projectDir){const l=document.getElementById('dlbl');l.textContent=data.projectDir.split(/[\\\\/]/).pop()||data.projectDir;l.title=data.projectDir}break;
  case 'models':popMdl(document.getElementById('ps').value,data.models,curMdl);break;
  case 'ready':setBusy(false);addS(\`AEE Agent ready — \${data.provider||''}/\${data.model||''} (\${data.tools||0} tools)\`);
    if(data.project_dir){const l=document.getElementById('dlbl');l.textContent=data.project_dir.split(/[\\\\/]/).pop();l.title=data.project_dir}break;
  case 'llm_chunk':addA(data.text||'');break;
  case 'tool_started':addS('  ⚙ '+(data.name||'?')+'…');break;
  case 'tool_finished':addT(data.name||'?',data.result||'',!!data.is_error);break;
  case 'tokens':updTok(data.in_tokens||0,data.out_tokens||0,data.cost_usd||0);break;
  case 'turn_done':setBusy(false);break;
  case 'error':addE(data.message);setBusy(false);break;
  case 'system':addS(data.message||'');break;
  case 'file_picked':if(data.isImage&&data.dataUrl){addImg(data.dataUrl,data.fileName||'img');const i=document.getElementById('it');i.value=\`[Image: \${data.fileName}]\\n\${i.value}\`}
    else if(data.fileContent!==undefined){const i=document.getElementById('it');const p=data.fileContent.length>8000?data.fileContent.slice(0,8000)+'\\n…':data.fileContent;i.value=\`[File: \${data.fileName}]\\n\\\`\\\`\\\`\\n\${p}\\n\\\`\\\`\\\`\\n\\n\${i.value}\`;i.focus()}break;
}});
vscode.postMessage({command:'ready'});
</script>
</body>
</html>`;
  }
}
