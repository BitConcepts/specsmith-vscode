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
    | 'chat_export'   // synthetic: extension host → webview with export file path
    | 'file_picked'   // synthetic: extension host → webview with file content
    | 'clear_display'    // synthetic: extension host → webview: clear chat UI
    | 'history_user'     // previous session user message replay
    | 'history_agent'   // previous session agent message replay
    | 'tool_crash'      // critical tool failure — fail fast, ask to report
    | 'vcs_state'       // synthetic: git branch + change count for VCS bar
    | 'proposal';       // synthetic: agent is asking for approval — show accept/reject buttons

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
  availableProviders?: string[];  // providers with API keys configured (+ ollama)

  // models (extension → webview)
  models?: ModelInfo[];

  // file_picked (extension → webview)
  fileName?: string;
  fileContent?: string;
  isImage?: boolean;
  dataUrl?: string;
  // vcs_state
  branch?: string;
  changes?: number;
  additions?: number;
  deletions?: number;

  // tool_crash
  tool?: string;
  summary?: string;
  detail?: string;
  specsmith_version?: string;
  python_version?: string;
  os_info?: string;
  project_type?: string;
  repo?: string; // 'specsmith' | 'specsmith-vscode'
}

/** Model info returned by provider APIs. */
export interface ModelInfo {
  id: string;
  name: string;         // display name
  description?: string; // short capability description
  contextWindow?: number;
  category?: string;    // for grouping in optgroup (e.g. 'Flagship', 'Reasoning')
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
    | 'openFile'
    | 'clearHistory'   // webview → host: clear files + agent context + display
    | 'copyAll'        // webview → host: (handled entirely client-side, no-op here)
    | 'downloadModel' // webview → host: user selected a dl: prefixed model
    | 'showHelp'         // webview → host: open help panel
    | 'showSettings'     // webview → host: open global Settings panel
    | 'reportBug'        // webview → host: user clicked Report Bug on an error
    | 'reportIssue'      // webview → host: user wants to file an issue/suggestion
    | 'installOrUpgrade'  // webview → host: user wants to install/upgrade specsmith
    | 'changeProject'     // webview → host: user wants to switch project directory
    | 'setAutoAccept'     // webview → host: user clicked Accept All
    | 'viewFull';         // webview → host: open full text in read-only editor
  text?: string;
  provider?: string;
  model?: string;
  // exportChat
  markdown?: string;
  // openFile
  filePath?: string;
  // reportBug
  bugTitle?: string;
  bugDetail?: string;
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
