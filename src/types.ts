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
    | 'init'        // synthetic: extension host → webview on setup
    | 'models'      // synthetic: extension host → webview with dynamic model list
    | 'chat_export' // synthetic: extension host → webview with export file path
    | 'file_picked'; // synthetic: extension host → webview with file content

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

  // models (extension → webview)
  models?: ModelInfo[];

  // file_picked (extension → webview)
  fileName?: string;
  fileContent?: string;
  isImage?: boolean;
  dataUrl?: string;
}

/** Model info returned by provider APIs. */
export interface ModelInfo {
  id: string;
  name: string;       // display name
  description?: string;
  contextWindow?: number;
}

/** Messages sent from the webview to the extension host. */
export interface WebviewMessage {
  command:
    | 'ready'
    | 'send'
    | 'stop'
    | 'setProvider'
    | 'setModel'
    | 'getModels'
    | 'pickFile'
    | 'exportChat'
    | 'openFile';
  text?: string;
  provider?: string;
  model?: string;
  // exportChat
  markdown?: string;
  // openFile
  filePath?: string;
}

/** Session lifecycle status — drives the status icon in the Sessions tree. */
export type SessionStatus = 'starting' | 'waiting' | 'running' | 'error' | 'inactive';

/** Configuration for a single agent session. */
export interface SessionConfig {
  projectDir: string;
  provider: string;
  model: string;
  sessionId: string;
}
