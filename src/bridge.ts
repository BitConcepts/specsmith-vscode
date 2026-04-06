// SPDX-License-Identifier: MIT
// Copyright (c) 2026 BitConcepts, LLC. All rights reserved.
/**
 * SpecsmithBridge — manages the `specsmith run --json-events` child process
 * for a single session tab.
 *
 * Protocol:
 *   stdin  ← user messages, one line each (the specsmith REPL reads via input())
 *   stdout → JSONL events: ready, llm_chunk, tool_started, tool_finished,
 *                          tokens, turn_done, error, system
 */
import * as cp from 'child_process';
import * as readline from 'readline';
import { SpecsmithEvent, SessionConfig } from './types';

export class SpecsmithBridge {
  private _proc: cp.ChildProcess | null = null;
  private _rl: readline.Interface | null = null;
  private _handlers: Array<(e: SpecsmithEvent) => void> = [];
  private _ready = false;
  private _pending: string[] = [];
  private readonly _execPath: string;
  private _config: SessionConfig;

  constructor(execPath: string, config: SessionConfig) {
    this._execPath = execPath;
    this._config = { ...config };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  public start(): void {
    this._spawn();
  }

  public restart(config: SessionConfig): void {
    this._config = { ...config };
    this._ready = false;
    this._pending = [];
    this._spawn();
  }

  public dispose(): void {
    this._ready = false;
    this._rl?.close();
    this._rl = null;
    if (this._proc) {
      try { this._proc.stdin?.end(); } catch { /* ignore */ }
      try { this._proc.kill(); } catch { /* ignore */ }
      this._proc = null;
    }
  }

  // ── Messaging ──────────────────────────────────────────────────────────────

  /**
   * Send a user message to the agent process.
   * If the process hasn't emitted `ready` yet, the message is queued.
   */
  public send(text: string): void {
    if (this._ready) {
      this._writeLine(text);
    } else {
      this._pending.push(text);
    }
  }

  /**
   * Tell the running agent to switch models via the /model slash command.
   */
  public setModel(model: string): void {
    this._config.model = model;
    if (this._ready) {
      this._writeLine(`/model ${model}`);
    }
  }

  /** Register a handler for incoming events. */
  public onEvent(handler: (e: SpecsmithEvent) => void): void {
    this._handlers.push(handler);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _spawn(): void {
    this.dispose();

    const args = ['run', '--json-events', '--no-stream',
      '--project-dir', this._config.projectDir];
    if (this._config.provider) { args.push('--provider', this._config.provider); }
    if (this._config.model)    { args.push('--model',    this._config.model);    }

    this._proc = cp.spawn(this._execPath, args, {
      cwd: this._config.projectDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Inherit the user's environment so API keys are available
      env: process.env,
    });

    // Parse JSONL from stdout
    this._rl = readline.createInterface({ input: this._proc.stdout! });
    this._rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) { return; }
      try {
        const event = JSON.parse(trimmed) as SpecsmithEvent;
        if (event.type === 'ready') {
          this._ready = true;
          // Flush any messages queued before ready
          while (this._pending.length > 0) {
            this._writeLine(this._pending.shift()!);
          }
        }
        this._emit(event);
      } catch {
        // Non-JSON line (e.g. startup noise) → treat as system message
        this._emit({ type: 'system', message: trimmed });
      }
    });

    // Pipe stderr as system messages (e.g. import warnings)
    this._proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        this._emit({ type: 'system', message: `[stderr] ${text}` });
      }
    });

    this._proc.on('exit', (code, signal) => {
      this._ready = false;
      const reason = signal ? `signal ${signal}` : `exit code ${code ?? '?'}`;
      this._emit({ type: 'system', message: `Agent process ended (${reason})` });
    });

    this._proc.on('error', (err: NodeJS.ErrnoException) => {
      const hint = err.code === 'ENOENT'
        ? ` — is specsmith installed? Try: pip install specsmith[anthropic]`
        : '';
      this._emit({ type: 'error', message: `Failed to start specsmith: ${err.message}${hint}` });
    });
  }

  private _writeLine(text: string): void {
    if (this._proc?.stdin?.writable) {
      this._proc.stdin.write(text + '\n');
    }
  }

  private _emit(event: SpecsmithEvent): void {
    for (const h of this._handlers) {
      try { h(event); } catch { /* never let a handler crash the bridge */ }
    }
  }
}
