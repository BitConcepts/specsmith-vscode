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
import * as readline from 'readline';
import { SpecsmithEvent, SessionConfig, SessionStatus } from './types';

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
  private readonly _execPath: string;
  private _config: SessionConfig;
  private _envOverrides: Record<string, string>;

  constructor(
    execPath: string,
    config: SessionConfig,
    envOverrides: Record<string, string> = {},
  ) {
    this._execPath = execPath;
    this._config = { ...config };
    this._envOverrides = envOverrides;
  }

  // ── Lifecycle ──────────────────────────────────────────────

  public start(): void { this._spawn(); }

  public restart(config: SessionConfig, envOverrides?: Record<string, string>): void {
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

    const env = { ...process.env, ...this._envOverrides } as NodeJS.ProcessEnv;

    // Warn if specsmith hasn't emitted 'ready' within 20 seconds
    this._startupTimer = setTimeout(() => {
      if (!this._ready) {
        this._emit({
          type: 'error',
          message:
            'specsmith hasn\'t started after 20s. Possible causes:\n' +
            '  1. specsmith not on PATH — set executablePath in settings\n' +
            '  2. No API key set — run: specsmith: Set API Key\n' +
            '  3. specsmith not installed — pip install specsmith[anthropic]',
        });
        this._setStatus('error');
      }
    }, 20_000);

    this._proc = cp.spawn(this._execPath, args, {
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
      if (text) { this._emit({ type: 'system', message: `[stderr] ${text}` }); }
    });

    this._proc.on('exit', (code, signal) => {
      this._ready = false;
      this._clearTurnTimer();
      this._setStatus('inactive');
      const reason = signal ? `signal ${signal}` : `exit code ${code ?? '?'}`;
      this._emit({ type: 'system', message: `Agent process ended (${reason})` });
      this._emit({ type: 'turn_done' }); // unblock any waiting UI
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
