// SPDX-License-Identifier: MIT
// Copyright (c) 2026 BitConcepts, LLC. All rights reserved.
/**
 * SpecsmithBridge — manages the `specsmith run --json-events` child process
 * for a single session tab.
 *
 * Protocol:
 *   stdin  ← user messages, one line each
 *   stdout → JSONL events: ready, llm_chunk, tool_started, tool_finished,
 *                          tokens, turn_done, error, system
 */
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { SpecsmithEvent, SessionConfig, SessionStatus } from './types';
import { getVenvSpecsmith } from './VenvManager';

/**
 * Return an env object that guarantees known pipx/pip bin directories are on
 * PATH. The real PATH always comes FIRST so the extension resolves the same
 * specsmith binary the user's terminal would find. The extra directories are
 * appended as a fallback for VS Code extension-host environments where the
 * shell PATH was not fully inherited (e.g. launched from the taskbar/dock).
 */
export function augmentedEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  const fallback: string[] = [];

  if (process.platform === 'win32') {
    const local   = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    const roaming = process.env.APPDATA      ?? path.join(os.homedir(), 'AppData', 'Roaming');

    // Preferred: pipx shims (.local\bin) — single canonical install
    fallback.push(
      path.join(os.homedir(), '.local', 'bin'),            // pipx shims (recommended)
      path.join(local,   'pipx', 'bin'),                   // pipx alt location
      path.join(local,   'Programs', 'Python', 'Scripts'), // pip user (Python 3.11+)
      path.join(roaming, 'Python', 'Scripts'),             // pip user (older Python)
    );

    // Git: VS Code extension host often doesn't inherit the full PATH.
    // Add common Git install locations so git commands work in agent sessions.
    fallback.push(
      'C:\\Program Files\\Git\\cmd',
      'C:\\Program Files (x86)\\Git\\cmd',
      path.join(local, 'Programs', 'Git', 'cmd'),
    );

    // pythoncore-* subdirs as last resort
    try {
      const pyBase = path.join(local, 'Python');
      if (fs.existsSync(pyBase)) {
        for (const entry of fs.readdirSync(pyBase, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name.startsWith('pythoncore')) {
            fallback.push(path.join(pyBase, entry.name, 'Scripts'));
          }
        }
      }
    } catch { /* ignore */ }
  } else {
    fallback.push(path.join(os.homedir(), '.local', 'bin'), '/usr/local/bin');
    // Git on macOS via Xcode CLT or Homebrew
    fallback.push('/usr/bin', '/opt/homebrew/bin');
  }

  // Dynamic: probe for git and add its directory if not already on PATH
  try {
    const whichCmd = process.platform === 'win32' ? 'where.exe' : 'which';
    const r = cp.spawnSync(whichCmd, ['git'], { timeout: 3000, encoding: 'utf8', env: { ...base, PATH: [...(base.PATH?.split(path.delimiter) ?? []), ...fallback].join(path.delimiter) } });
    if (r.status === 0 && r.stdout.trim()) {
      const gitDir = path.dirname(r.stdout.trim().split('\n')[0]);
      if (!fallback.includes(gitDir)) { fallback.push(gitDir); }
    }
  } catch { /* git not found — will fail gracefully when agent tries to use it */ }

  const current = env.PATH ?? '';
  // Real PATH first — extension finds the same binary as the terminal.
  // Fallback dirs are only reached if specsmith is absent from the real PATH.
  env.PATH = [current, ...fallback].join(path.delimiter);
  return env;
}

/** Parse semver from 'specsmith, version X.Y.Z' string. Returns [maj,min,patch] or null. */
function _parseVersion(s: string): [number, number, number] | null {
  const m = s.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [+m[1], +m[2], +m[3]] : null;
}

/** Returns true if the executable is specsmith >= 0.3.1 (has --json-events). */
function _isValidSpecsmith(execPath: string): boolean {
  try {
    const r = cp.spawnSync(execPath, ['--version'], { timeout: 4000, encoding: 'utf8' });
    if (r.status !== 0) { return false; }
    const ver = _parseVersion(r.stdout ?? '');
    if (!ver) { return false; }
    const [maj, min, patch] = ver;
    return (maj > 0) || (min > 3) || (min === 3 && patch >= 1);
  } catch { return false; }
}

/**
 * Find the best specsmith executable: the configured path or the first valid
 * one in known locations. 'Valid' means version >= 0.3.1 (has --json-events).
 * Exported so GovernancePanel can use the same resolution logic.
 */
export function findSpecsmith(configured: string, envPath: string): string {
  // 1. Try the configured path first
  if (_isValidSpecsmith(configured)) { return configured; }

  // 2. Scan all PATH directories for a valid specsmith
  const exeNames = process.platform === 'win32'
    ? ['specsmith.exe', 'specsmith.bat', 'specsmith.cmd']
    : ['specsmith'];

  for (const dir of envPath.split(path.delimiter)) {
    for (const name of exeNames) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate) && _isValidSpecsmith(candidate)) {
        return candidate;
      }
    }
  }

  return configured; // fallback — will fail with a useful error
}

const TURN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per turn

export class SpecsmithBridge {
  private _proc: cp.ChildProcess | null = null;
  private _rl: readline.Interface | null = null;
  private _handlers: Array<(e: SpecsmithEvent) => void> = [];
  private _statusHandlers: Array<(s: SessionStatus) => void> = [];
  private _ready = false;
  private _pending: string[] = [];
  private _turnTimer: ReturnType<typeof setTimeout> | undefined;
  private _startupTimer: ReturnType<typeof setTimeout> | undefined;
  private _suppressNextExit = false; // set before voluntary restart to suppress exit message
  private readonly _execPath: string;
  private _config: SessionConfig;
  private _envOverrides: Record<string, string>;
  private _ollamaCtx: number; // context length for Ollama (0 = default)

  constructor(
    execPath: string,
    config: SessionConfig,
    envOverrides: Record<string, string> = {},
    ollamaCtx = 0,
  ) {
    this._execPath = execPath;
    this._config = { ...config };
    this._envOverrides = envOverrides;
    this._ollamaCtx = ollamaCtx;
  }

  // ── Lifecycle ──────────────────────────────────────────────

  public start(): void { this._spawn(); }

  public restart(config: SessionConfig, envOverrides?: Record<string, string>): void {
    this._suppressNextExit = true; // switching model/provider — don't show exit message
    this._config = { ...config };
    if (envOverrides) { this._envOverrides = envOverrides; }
    this._ready = false;
    this._pending = [];
    this._clearTurnTimer();
    this._spawn();
  }

  /** Forcibly kill the running process (user pressed Stop). */
  public kill(): void {
    this._clearTurnTimer();
    if (!this._proc) { return; }
    this._setStatus('inactive');
    // Try graceful shutdown first
    try { this._proc.kill('SIGTERM'); } catch { /* ignore */ }
    // Hard kill after 2s if still running
    const proc = this._proc;
    setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }, 2000);
    this._emit({ type: 'system', message: 'Agent stopped by user.' });
    this._emit({ type: 'turn_done' });
  }

  public dispose(): void {
    this._ready = false;
    this._clearTurnTimer();
    this._clearStartupTimer();
    this._rl?.close();
    this._rl = null;
    if (this._proc) {
      try { this._proc.stdin?.end(); } catch { /* ignore */ }
      try { this._proc.kill(); } catch { /* ignore */ }
      this._proc = null;
    }
  }

  // ── Messaging ───────────────────────────────────────────────

  public send(text: string): void {
    // Auto-respawn the agent process if it has died
    if (!this._proc) {
      const ts = new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      this._emit({ type: 'system', message: `[${ts}] Respawning agent…` });
      this._spawn();
    }
    this._setStatus('running');
    this._startTurnTimer();
    if (this._ready) {
      this._writeLine(text);
    } else {
      this._pending.push(text);
    }
  }

  public setModel(model: string): void {
    this._config.model = model;
    if (this._ready) { this._writeLine(`/model ${model}`); }
  }

  public setEnvOverrides(env: Record<string, string>): void {
    this._envOverrides = env;
  }

  /** Register a handler for incoming events. */
  public onEvent(handler: (e: SpecsmithEvent) => void): void {
    this._handlers.push(handler);
  }

  /** Register a handler for session status changes. */
  public onStatus(handler: (s: SessionStatus) => void): void {
    this._statusHandlers.push(handler);
  }

  // ── Private ───────────────────────────────────────────────

  private _spawn(): void {
    this.dispose();
    this._setStatus('starting');

    const args = ['run', '--json-events', '--no-stream',
      '--project-dir', this._config.projectDir];
    if (this._config.provider) { args.push('--provider', this._config.provider); }
    if (this._config.model)    { args.push('--model',    this._config.model);    }

    const env = augmentedEnv({ ...process.env, ...this._envOverrides });
    // Inject Ollama context length when using the ollama provider
    if (this._config.provider === 'ollama' && this._ollamaCtx > 0) {
      env.SPECSMITH_OLLAMA_NUM_CTX = String(this._ollamaCtx);
    }

    // Prefer global venv — completely bypasses PATH resolution and
    // prevents version conflicts between multiple system installs.
    const venvBin = getVenvSpecsmith();
    const execPath = venvBin
      ? venvBin
      : findSpecsmith(this._execPath, env.PATH ?? '');
    if (venvBin) {
      this._emit({ type: 'system', message: '\uD83D\uDD12 Using specsmith environment (~/.specsmith/venv)' });
    } else if (execPath !== this._execPath) {
      this._emit({ type: 'system', message: `Using specsmith at: ${execPath}` });
    }

    // Warn if specsmith hasn't emitted 'ready' within 20 seconds
    this._startupTimer = setTimeout(() => {
      if (!this._ready) {
        this._emit({
          type: 'error',
          message:
            `specsmith not responding (tried: "${execPath}")\n` +
            'To fix:\n' +
            '  \u2022 Ctrl+Shift+P \u2192 specsmith: Install or Upgrade\n' +
            '  \u2022 Or set specsmith.executablePath in VS Code settings\n' +
            '  \u2022 On Windows / pip install path:\n' +
            '    %LOCALAPPDATA%\\Python\\pythoncore-3.12-64\\Scripts\\specsmith.exe',
        });
        this._setStatus('error');
      }
    }, 20_000);

    this._proc = cp.spawn(execPath, args, {
      cwd: this._config.projectDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    this._rl = readline.createInterface({ input: this._proc.stdout! });
    this._rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) { return; }
      try {
        const event = JSON.parse(trimmed) as SpecsmithEvent;
        if (event.type === 'ready') {
          this._ready = true;
          this._clearStartupTimer();
          this._setStatus('waiting');
          while (this._pending.length > 0) {
            this._writeLine(this._pending.shift()!);
          }
        }
        if (event.type === 'turn_done') {
          this._clearTurnTimer();
          this._setStatus('waiting');
        }
        if (event.type === 'error') {
          this._clearTurnTimer();
          this._setStatus('error');
        }
        this._emit(event);
      } catch {
        this._emit({ type: 'system', message: trimmed });
      }
    });

    this._proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (!text) { return; }
      // Detect critical errors in stderr and surface as proper error events
      if (/No such option.*json-events/i.test(text)) {
        this._emit({ type: 'error',
          message: 'specsmith v0.3.1+ required (missing --json-events)\nUpgrade: Ctrl+Shift+P → specsmith: Install or Upgrade' });
      } else if (/No such command.*run/i.test(text)) {
        this._emit({ type: 'error',
          message: 'specsmith v0.3.0+ required (missing \'run\' command)\nUpgrade: Ctrl+Shift+P → specsmith: Install or Upgrade' });
      } else if (/connection refused|failed to connect|ECONNREFUSED/i.test(text)) {
        this._emit({ type: 'error',
          message: 'Ollama not running — start it: run ollama serve (or open Ollama app)' });
      } else if (/404.*not found|model.*not found|pull model manifest/i.test(text)) {
        this._emit({ type: 'error',
          message: `Model not found in Ollama — download it: specsmith ollama pull <model>` });
      } else if (/Error:/i.test(text) || /error:/i.test(text)) {
        this._emit({ type: 'error', message: text });
      } else {
        this._emit({ type: 'system', message: text });
      }
    });

    this._proc.on('exit', (code, signal) => {
      this._ready = false;
      this._proc = null;
      this._clearTurnTimer();
      // Suppress message for voluntary restarts (model/provider switch)
      if (this._suppressNextExit) {
        this._suppressNextExit = false;
        this._emit({ type: 'turn_done' });
        return;
      }
      const isError = (code !== 0 && code !== null) || signal !== null;
      this._setStatus(isError ? 'error' : 'inactive');
      const ts = new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const reason = signal ? `signal ${signal}` : `exit code ${code ?? '?'}`;
      this._emit({ type: isError ? 'error' : 'system',
        message: `[${ts}] Agent process ended (${reason})${isError ? ' — send a message to restart' : ''}` });
      this._emit({ type: 'turn_done' });
    });

    this._proc.on('error', (err: NodeJS.ErrnoException) => {
      this._setStatus('error');
      const hint = err.code === 'ENOENT'
        ? ` — is specsmith installed? Try: pip install specsmith[anthropic]`
        : '';
      this._emit({ type: 'error', message: `Failed to start specsmith: ${err.message}${hint}` });
    });
  }

  private _writeLine(text: string): void {
    if (this._proc?.stdin?.writable) { this._proc.stdin.write(text + '\n'); }
  }

  private _emit(event: SpecsmithEvent): void {
    for (const h of this._handlers) {
      try { h(event); } catch { /* never crash */ }
    }
  }

  private _setStatus(status: SessionStatus): void {
    for (const h of this._statusHandlers) {
      try { h(status); } catch { /* never crash */ }
    }
  }

  private _startTurnTimer(): void {
    this._clearTurnTimer();
    this._turnTimer = setTimeout(() => {
      this._emit({ type: 'error', message: 'Agent turn timed out after 5 minutes.' });
      this.kill();
    }, TURN_TIMEOUT_MS);
  }

  private _clearTurnTimer(): void {
    if (this._turnTimer !== undefined) {
      clearTimeout(this._turnTimer);
      this._turnTimer = undefined;
    }
  }

  private _clearStartupTimer(): void {
    if (this._startupTimer !== undefined) {
      clearTimeout(this._startupTimer);
      this._startupTimer = undefined;
    }
  }
}
