// SPDX-License-Identifier: MIT
// Copyright (c) 2026 BitConcepts, LLC. All rights reserved.

/** Events emitted by `specsmith run --json-events` over stdout (JSONL). */
export interface SpecsmithEvent {
  type:
    | 'ready'
    | 'llm_chunk'
    | 'tool_started'
    | 'tool_finished'
    | 'tokens'
    | 'turn_done'
    | 'error'
    | 'system'
    | 'init'; // synthetic: sent by extension host to webview on setup

  // ready
  provider?: string;
  model?: string;
  project_dir?: string;
  tools?: number;
  skills?: number;

  // llm_chunk
  text?: string;

  // tool_started / tool_finished
  name?: string;
  args?: Record<string, unknown>;
  result?: string;
  is_error?: boolean;

  // tokens
  in_tokens?: number;
  out_tokens?: number;
  cost_usd?: number;

  // turn_done
  total_tokens?: number;

  // error / system
  message?: string;

  // init (extension → webview)
  projectDir?: string;
}

/** Messages sent from the webview to the extension host. */
export interface WebviewMessage {
  command: 'ready' | 'send' | 'setProvider' | 'setModel';
  text?: string;
  provider?: string;
  model?: string;
}

/** Configuration for a single agent session. */
export interface SessionConfig {
  projectDir: string;
  provider: string;
  model: string;
  sessionId: string;
}
