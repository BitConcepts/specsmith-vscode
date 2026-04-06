// SPDX-License-Identifier: MIT
// Copyright (c) 2026 BitConcepts, LLC. All rights reserved.
/**
 * SessionPanel — one WebviewPanel per agent session.
 *
 * Each panel owns a SpecsmithBridge (child process). The embedded HTML
 * UI communicates with the extension host via postMessage in both directions.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { SpecsmithBridge } from './bridge';
import { SpecsmithEvent, WebviewMessage, SessionConfig } from './types';

// ── Session registry ────────────────────────────────────────────────────────

export class SessionPanel implements vscode.Disposable {
  private static _instances: SessionPanel[] = [];
  private static _current: SessionPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _bridge: SpecsmithBridge;
  private _config: SessionConfig;
  private _disposables: vscode.Disposable[] = [];

  // ── Static factory ─────────────────────────────────────────────────────────

  public static create(
    context: vscode.ExtensionContext,
    projectDir: string,
    provider: string,
    model: string,
  ): SessionPanel {
    const cfg = vscode.workspace.getConfiguration('specsmith');
    const execPath = cfg.get<string>('executablePath', 'specsmith');
    const config: SessionConfig = {
      projectDir,
      provider,
      model,
      sessionId: Date.now().toString(),
    };

    const panel = vscode.window.createWebviewPanel(
      'specsmithSession',
      `🧠 ${path.basename(projectDir)}`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      },
    );

    const instance = new SessionPanel(panel, config, execPath);
    SessionPanel._instances.push(instance);
    SessionPanel._current = instance;
    return instance;
  }

  /** Return the most-recently-active session panel, if any. */
  public static current(): SessionPanel | undefined {
    return SessionPanel._current;
  }

  /** All open sessions (for the Sessions tree view). */
  public static all(): SessionPanel[] {
    return [...SessionPanel._instances];
  }

  // ── Constructor ────────────────────────────────────────────────────────────

  private constructor(
    panel: vscode.WebviewPanel,
    config: SessionConfig,
    execPath: string,
  ) {
    this._panel = panel;
    this._config = config;
    this._bridge = new SpecsmithBridge(execPath, config);

    this._panel.webview.html = this._html();

    // Bridge → webview
    this._bridge.onEvent((event: SpecsmithEvent) => {
      void this._panel.webview.postMessage(event);
    });

    // Webview → extension host
    this._panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => this._onMessage(msg),
      null,
      this._disposables,
    );

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        SessionPanel._current = this;
      }
    }, null, this._disposables);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  public get label(): string {
    return `${path.basename(this._config.projectDir)} [${this._config.provider}]`;
  }

  public get projectDir(): string {
    return this._config.projectDir;
  }

  /** Send a text command to the agent (e.g. from a toolbar button). */
  public sendCommand(cmd: string): void {
    this._bridge.send(cmd);
    // Echo to chat
    void this._panel.webview.postMessage({ type: 'system', message: `> ${cmd}` });
  }

  public dispose(): void {
    SessionPanel._instances = SessionPanel._instances.filter((i) => i !== this);
    if (SessionPanel._current === this) {
      SessionPanel._current = SessionPanel._instances[SessionPanel._instances.length - 1];
    }
    this._bridge.dispose();
    this._panel.dispose();
    while (this._disposables.length > 0) {
      this._disposables.pop()?.dispose();
    }
  }

  // ── Message handler ────────────────────────────────────────────────────────

  private _onMessage(msg: WebviewMessage): void {
    switch (msg.command) {
      case 'ready':
        // Webview is ready — send initial config and start the bridge
        void this._panel.webview.postMessage({
          type: 'init',
          provider: this._config.provider,
          model:    this._config.model,
          projectDir: this._config.projectDir,
        } satisfies SpecsmithEvent);
        this._bridge.start();
        break;

      case 'send':
        if (msg.text) {
          this._bridge.send(msg.text);
        }
        break;

      case 'setProvider':
        if (msg.provider) {
          this._config.provider = msg.provider;
          this._bridge.restart(this._config);
        }
        break;

      case 'setModel':
        if (msg.model) {
          this._bridge.setModel(msg.model);
          this._config.model = msg.model;
        }
        break;
    }
  }

  // ── Webview HTML ───────────────────────────────────────────────────────────

  private _html(): string {
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>specsmith Agent</title>
<style>
  /* ── Variables ── */
  :root {
    --bg:       var(--vscode-editor-background, #1e1e2e);
    --fg:       var(--vscode-editor-foreground, #cdd6f4);
    --surface:  var(--vscode-panel-background, #181825);
    --border:   var(--vscode-panel-border, #313244);
    --input-bg: var(--vscode-input-background, #1e1e2e);
    --input-fg: var(--vscode-input-foreground, #cdd6f4);
    --btn-bg:   var(--vscode-button-background, #1e66f5);
    --btn-fg:   var(--vscode-button-foreground, #ffffff);
    --btn-hover:var(--vscode-button-hoverBackground, #1e5cd5);
    --teal:     #4ec9b0;
    --amber:    #ce9178;
    --red:      #f44747;
    --green:    #4ec94e;
    --dim:      var(--vscode-descriptionForeground, #7f849c);
    --font:     var(--vscode-font-family, 'Segoe UI', system-ui, sans-serif);
    --mono:     var(--vscode-editor-font-family, 'Cascadia Code', 'Fira Code', monospace);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; overflow: hidden; }
  body {
    background: var(--bg);
    color: var(--fg);
    font-family: var(--font);
    font-size: 13px;
    display: flex;
    flex-direction: column;
  }

  /* ── Provider bar ── */
  #provider-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 10px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    font-size: 11px;
    flex-shrink: 0;
  }
  #provider-bar select {
    background: var(--input-bg);
    color: var(--input-fg);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 2px 5px;
    font-size: 11px;
    font-family: var(--font);
  }
  #provider-bar select:focus { outline: 1px solid var(--teal); }
  .dir-label {
    color: var(--dim);
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--mono);
    font-size: 11px;
  }
  .bar-sep { color: var(--border); margin: 0 2px; }

  /* ── Chat area ── */
  #chat {
    flex: 1;
    overflow-y: auto;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    scroll-behavior: smooth;
  }
  #chat::-webkit-scrollbar { width: 5px; }
  #chat::-webkit-scrollbar-track { background: transparent; }
  #chat::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

  /* ── Messages ── */
  .msg-user {
    align-self: flex-end;
    max-width: 75%;
  }
  .msg-user .bubble {
    background: var(--btn-bg);
    color: var(--btn-fg);
    border-radius: 14px 14px 3px 14px;
    padding: 9px 13px;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 13px;
  }
  .msg-user .meta { text-align: right; }

  .msg-assistant { align-self: flex-start; max-width: 92%; }
  .role-tag {
    font-size: 10px;
    color: var(--teal);
    font-weight: 700;
    letter-spacing: 0.6px;
    text-transform: uppercase;
    margin-bottom: 3px;
  }
  .msg-assistant .bubble {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 3px 14px 14px 14px;
    padding: 9px 13px;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 13px;
  }

  .meta {
    font-size: 10px;
    color: var(--dim);
    margin-top: 3px;
    padding: 0 2px;
  }

  .tool-block {
    align-self: flex-start;
    background: var(--surface);
    border: 1px solid var(--border);
    border-left: 3px solid var(--amber);
    border-radius: 4px;
    padding: 6px 10px;
    max-width: 92%;
    font-size: 12px;
  }
  .tool-block.is-error { border-left-color: var(--red); }
  .tool-header {
    color: var(--amber);
    font-weight: 600;
    font-family: var(--mono);
    margin-bottom: 3px;
  }
  .tool-block.is-error .tool-header { color: var(--red); }
  .tool-result {
    color: var(--dim);
    font-family: var(--mono);
    font-size: 11px;
    max-height: 110px;
    overflow: hidden;
    white-space: pre-wrap;
    word-break: break-all;
  }

  .system-line {
    align-self: center;
    color: var(--dim);
    font-size: 11px;
    font-style: italic;
    text-align: center;
    padding: 2px 4px;
  }
  .error-line {
    align-self: flex-start;
    color: var(--red);
    font-size: 12px;
    background: rgba(244,71,71,0.08);
    border-left: 3px solid var(--red);
    border-radius: 3px;
    padding: 5px 10px;
    max-width: 92%;
  }

  /* Inline code / code blocks inside assistant bubbles */
  code {
    font-family: var(--mono);
    background: rgba(255,255,255,0.07);
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 12px;
    color: var(--teal);
  }
  pre {
    background: rgba(0,0,0,0.25);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 8px 10px;
    overflow-x: auto;
    font-size: 11px;
    margin: 4px 0;
  }
  pre code { background: none; padding: 0; }

  /* ── Token meter ── */
  #token-meter {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px;
    background: var(--surface);
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--dim);
    flex-shrink: 0;
  }
  #ctx-track {
    flex: 1;
    height: 4px;
    background: var(--border);
    border-radius: 2px;
    overflow: hidden;
  }
  #ctx-fill {
    height: 100%;
    width: 0%;
    background: var(--green);
    border-radius: 2px;
    transition: width 0.4s ease, background 0.4s ease;
  }
  #ctx-pct  { min-width: 30px; text-align: right; }
  #tok-cnt  { min-width: 80px; }
  #tok-cost { color: var(--teal); font-weight: 600; }

  /* ── Optimize banner ── */
  #opt-banner {
    display: none;
    align-items: center;
    gap: 8px;
    padding: 5px 10px;
    background: rgba(206,145,120,0.1);
    border-top: 1px solid var(--amber);
    font-size: 11px;
    color: var(--amber);
    flex-shrink: 0;
  }
  #opt-banner.show { display: flex; }
  #opt-banner button {
    background: none; border: none; color: var(--amber);
    cursor: pointer; font-size: 13px; padding: 0 3px; margin-left: auto;
  }

  /* ── Input bar ── */
  #input-bar {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 7px 10px;
    background: var(--surface);
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }
  #input-row { display: flex; gap: 6px; align-items: flex-end; }
  #input-text {
    flex: 1;
    background: var(--input-bg);
    color: var(--input-fg);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 7px 10px;
    font-family: var(--font);
    font-size: 13px;
    resize: none;
    min-height: 38px;
    max-height: 110px;
    line-height: 1.4;
  }
  #input-text:focus { outline: 1px solid var(--teal); border-color: var(--teal); }
  #input-text:disabled { opacity: 0.5; }
  #send-btn {
    background: var(--btn-bg);
    color: var(--btn-fg);
    border: none;
    border-radius: 5px;
    padding: 7px 14px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
    height: 38px;
  }
  #send-btn:hover:not(:disabled) { background: var(--btn-hover); }
  #send-btn:disabled { opacity: 0.45; cursor: not-allowed; }

  #tools-row { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
  .tool-btn {
    background: none;
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--dim);
    padding: 1px 7px;
    cursor: pointer;
    font-size: 10px;
    font-family: var(--font);
    transition: border-color 0.15s, color 0.15s;
  }
  .tool-btn:hover:not(:disabled) { border-color: var(--teal); color: var(--teal); }
  .tool-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .kbd-hint { font-size: 10px; color: var(--dim); margin-left: auto; }

  /* ── Typing dots ── */
  #typing { display: none; gap: 5px; align-items: center; color: var(--teal); font-size: 11px; }
  #typing.show { display: flex; }
  .dot {
    width: 5px; height: 5px; background: var(--teal);
    border-radius: 50%; animation: bounce 1.1s infinite;
  }
  .dot:nth-child(2) { animation-delay: 0.18s; }
  .dot:nth-child(3) { animation-delay: 0.36s; }
  @keyframes bounce {
    0%,60%,100% { transform: translateY(0); }
    30% { transform: translateY(-5px); }
  }
</style>
</head>
<body>

<!-- Provider bar -->
<div id="provider-bar">
  <span title="Project directory" style="opacity:0.7">📁</span>
  <span class="dir-label" id="dir-label">.</span>
  <span class="bar-sep">│</span>
  <label for="prov-sel" style="color:var(--dim)">Provider</label>
  <select id="prov-sel">
    <option value="anthropic">anthropic</option>
    <option value="openai">openai</option>
    <option value="gemini">gemini</option>
    <option value="mistral">mistral</option>
    <option value="ollama">ollama</option>
  </select>
  <label for="model-sel" style="color:var(--dim)">Model</label>
  <select id="model-sel" style="min-width:160px"></select>
</div>

<!-- Chat -->
<div id="chat"></div>

<!-- Optimize banner -->
<div id="opt-banner">
  <span>⚠</span>
  <span id="opt-text">Context is getting large — consider /clear, or run Audit to compress</span>
  <button onclick="document.getElementById('opt-banner').classList.remove('show')">✕</button>
</div>

<!-- Token meter -->
<div id="token-meter">
  <span style="color:var(--dim)">Context</span>
  <div id="ctx-track"><div id="ctx-fill"></div></div>
  <span id="ctx-pct">0%</span>
  <span id="tok-cnt">0 + 0 tok</span>
  <span id="tok-cost">$0.0000</span>
</div>

<!-- Input bar -->
<div id="input-bar">
  <div id="typing">
    <div class="dot"></div><div class="dot"></div><div class="dot"></div>
    <span>Agent thinking…</span>
  </div>
  <div id="input-row">
    <textarea id="input-text" rows="2"
      placeholder="Message the AEE agent… (Ctrl+Enter to send)"></textarea>
    <button id="send-btn" onclick="sendMsg()">Send ↵</button>
  </div>
  <div id="tools-row">
    <button class="tool-btn" onclick="quickCmd('audit')">🔍 audit</button>
    <button class="tool-btn" onclick="quickCmd('validate')">✅ validate</button>
    <button class="tool-btn" onclick="quickCmd('doctor')">🩺 doctor</button>
    <button class="tool-btn" onclick="quickCmd('epistemic')">🧠 epistemic</button>
    <button class="tool-btn" onclick="quickCmd('stress')">⚡ stress-test</button>
    <button class="tool-btn" onclick="quickCmd('/clear')">🗑 clear</button>
    <button class="tool-btn" onclick="quickCmd('status')">📊 status</button>
    <span class="kbd-hint">Ctrl+Enter to send</span>
  </div>
</div>

<script>
/* ── VS Code API ── */
const vscode = acquireVsCodeApi();

/* ── Model registry ── */
const MODELS = {
  anthropic: ['claude-opus-4-5','claude-sonnet-4-5','claude-haiku-4-5','claude-opus-4-0','claude-sonnet-4-0'],
  openai:    ['gpt-4o','gpt-4o-mini','o3','o3-mini','o1','gpt-4-turbo'],
  gemini:    ['gemini-2.5-pro','gemini-2.5-flash','gemini-2.0-pro','gemini-2.0-flash'],
  mistral:   ['mistral-large-latest','mistral-small-latest','codestral-latest','pixtral-large-latest'],
  ollama:    ['qwen2.5:14b','qwen2.5:7b','llama3.2:latest','deepseek-coder-v2:latest','mistral:latest'],
};

/* Context window sizes by model keyword */
const CTX = { claude:200000,'gpt-4o':128000, o1:200000, o3:200000, gemini:1000000, mistral:128000 };
function ctxSize(m) {
  const ml = (m||'').toLowerCase();
  for (const [k,v] of Object.entries(CTX)) { if (ml.includes(k)) return v; }
  return 128000;
}

let busy = false;
let warned = false;
let curModel = '';

/* ── Helpers ── */
function ts() { return new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); }

function esc(s) {
  return String(s||'')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* Minimal markdown rendering */
function renderMd(raw) {
  let s = esc(raw);
  // fenced code blocks
  s = s.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, (_,lang,code) =>
    \`<pre><code>\${code}</code></pre>\`);
  // inline code
  s = s.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  // bold / italic
  s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
  s = s.replace(/\\*([^*]+)\\*/g,'<em>$1</em>');
  // line breaks
  s = s.replace(/\\n/g,'<br>');
  return s;
}

const chat = document.getElementById('chat');
function scrollBot() { chat.scrollTop = chat.scrollHeight; }

function addUser(text) {
  const d = document.createElement('div');
  d.className = 'msg-user';
  d.innerHTML = \`<div class="bubble">\${esc(text)}</div><div class="meta">\${ts()}</div>\`;
  chat.appendChild(d); scrollBot();
}

function addAssistant(text) {
  const d = document.createElement('div');
  d.className = 'msg-assistant';
  d.innerHTML = \`<div class="role-tag">🧠 AEE Agent</div>
    <div class="bubble">\${renderMd(text)}</div>
    <div class="meta">\${ts()}</div>\`;
  chat.appendChild(d); scrollBot();
}

function addTool(name, result, isErr) {
  const d = document.createElement('div');
  d.className = 'tool-block' + (isErr ? ' is-error' : '');
  const icon = isErr ? '❌' : '✅';
  const preview = esc((result||'').slice(0,500));
  d.innerHTML = \`<div class="tool-header">\${icon} \${esc(name)}</div>
    <div class="tool-result">\${preview}\${(result||'').length>500?'<em>…</em>':''}</div>\`;
  chat.appendChild(d); scrollBot();
}

function addSystem(msg) {
  const d = document.createElement('div');
  d.className = 'system-line';
  d.textContent = msg;
  chat.appendChild(d); scrollBot();
}

function addError(msg) {
  const d = document.createElement('div');
  d.className = 'error-line';
  d.textContent = '⚠ ' + (msg||'Unknown error');
  chat.appendChild(d); scrollBot();
}

/* ── Token meter ── */
function updateTokens(inT, outT, costUsd) {
  const total = inT + outT;
  const size  = ctxSize(curModel);
  const pct   = Math.min(100, Math.round(total/size*100));
  const fill  = document.getElementById('ctx-fill');
  fill.style.width      = pct + '%';
  fill.style.background = pct>=90 ? 'var(--red)' : pct>=70 ? 'var(--amber)' : 'var(--green)';
  document.getElementById('ctx-pct').textContent   = pct + '%';
  document.getElementById('tok-cnt').textContent   = inT.toLocaleString() + ' + ' + outT.toLocaleString() + ' tok';
  document.getElementById('tok-cost').textContent  = '$' + Number(costUsd||0).toFixed(4);
  if (pct>=70 && !warned) {
    warned = true;
    document.getElementById('opt-banner').classList.add('show');
    document.getElementById('opt-text').textContent =
      \`Context at \${pct}% — consider /clear or running Audit/Compress\`;
  }
}

/* ── Busy state ── */
function setBusy(val) {
  busy = val;
  document.getElementById('send-btn').disabled    = val;
  document.getElementById('input-text').disabled  = val;
  document.getElementById('typing').className      = val ? 'show' : '';
  document.querySelectorAll('.tool-btn').forEach(b => b.disabled = val);
}

/* ── Send ── */
function sendMsg() {
  if (busy) return;
  const inp = document.getElementById('input-text');
  const txt = inp.value.trim();
  if (!txt) return;
  inp.value = '';
  addUser(txt);
  setBusy(true);
  vscode.postMessage({ command: 'send', text: txt });
}

function quickCmd(cmd) {
  if (busy) return;
  addSystem('> ' + cmd);
  setBusy(true);
  vscode.postMessage({ command: 'send', text: cmd });
}

/* ── Keyboard ── */
document.getElementById('input-text').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    sendMsg();
  }
});

/* ── Provider / model selectors ── */
function populateModels(prov) {
  const sel = document.getElementById('model-sel');
  sel.innerHTML = '';
  (MODELS[prov]||[]).forEach(m => {
    const o = document.createElement('option');
    o.value = m; o.textContent = m;
    sel.appendChild(o);
  });
  curModel = sel.value;
}

document.getElementById('prov-sel').addEventListener('change', e => {
  const prov = e.target.value;
  populateModels(prov);
  vscode.postMessage({ command: 'setProvider', provider: prov });
  vscode.postMessage({ command: 'setModel', model: document.getElementById('model-sel').value });
});

document.getElementById('model-sel').addEventListener('change', e => {
  curModel = e.target.value;
  vscode.postMessage({ command: 'setModel', model: curModel });
});

/* ── Messages from extension host ── */
window.addEventListener('message', ({ data }) => {
  switch (data.type) {

    case 'init':
      if (data.provider) {
        document.getElementById('prov-sel').value = data.provider;
        populateModels(data.provider);
      }
      if (data.model) {
        document.getElementById('model-sel').value = data.model;
        curModel = data.model;
      }
      if (data.projectDir) {
        const lbl = document.getElementById('dir-label');
        lbl.textContent = data.projectDir;
        lbl.title = data.projectDir;
      }
      break;

    case 'ready':
      addSystem(\`AEE Agent ready — \${data.provider||''}  \${data.model||''}  (\${data.tools||0} tools)\`);
      if (data.project_dir) {
        const lbl = document.getElementById('dir-label');
        lbl.textContent = data.project_dir;
        lbl.title = data.project_dir;
      }
      break;

    case 'llm_chunk':
      addAssistant(data.text || '');
      break;

    case 'tool_started':
      addSystem('  ⚙ ' + (data.name||'?') + '…');
      break;

    case 'tool_finished':
      addTool(data.name||'?', data.result||'', !!data.is_error);
      break;

    case 'tokens':
      updateTokens(data.in_tokens||0, data.out_tokens||0, data.cost_usd||0);
      break;

    case 'turn_done':
      setBusy(false);
      break;

    case 'error':
      addError(data.message);
      setBusy(false);
      break;

    case 'system':
      addSystem(data.message || '');
      break;
  }
});

/* Notify host we're ready */
vscode.postMessage({ command: 'ready' });
</script>
</body>
</html>`;
  }
}
