// SPDX-License-Identifier: MIT
// Copyright (c) 2026 BitConcepts, LLC. All rights reserved.
/**
 * OllamaManager — Ollama API interactions for the VS Code extension.
 *
 * Handles:
 *  - GPU VRAM detection (nvidia-smi + Windows WMI fallback)
 *  - Fetching installed models from the local Ollama API
 *  - Merging installed models with the curated catalog
 *  - Downloading models with VS Code progress notifications + cancellation
 */
import * as cp from 'child_process';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import * as vscode from 'vscode';
import { ModelInfo } from './types';

const OLLAMA_API = 'http://localhost:11434';

// ── Curated model catalog ────────────────────────────────────────────────────

export interface OllamaCatalogEntry {
  id:         string;
  name:       string;
  vramGb:     number;
  sizeGb:     number;
  ctxK:       number;
  bestFor:    string[];
  notes:      string;
  tier:       string;
}

export const OLLAMA_CATALOG: OllamaCatalogEntry[] = [
  // CPU-friendly / Tiny (0-4 GB VRAM)
  { id: 'llama3.2:latest',           name: 'Llama 3.2 3B',           vramGb: 2.0,  sizeGb: 2.0,  ctxK: 128, tier: 'Tiny',     bestFor: ['chat', 'quick tasks'],                    notes: 'CPU-friendly, minimal resources' },
  { id: 'qwen2.5-coder:3b',          name: 'Qwen 2.5 Coder 3B',     vramGb: 2.5,  sizeGb: 2.0,  ctxK:  32, tier: 'Tiny',     bestFor: ['code generation', 'debugging'],            notes: 'Smallest coder model, CPU OK' },
  { id: 'phi3:mini',                  name: 'Phi-3 Mini 3.8B',       vramGb: 3.0,  sizeGb: 2.3,  ctxK:   4, tier: 'Tiny',     bestFor: ['reasoning', 'chat'],                       notes: 'Microsoft, strong reasoning for size' },
  // Balanced (4-8 GB VRAM)
  { id: 'mistral:latest',             name: 'Mistral 7B',            vramGb: 4.5,  sizeGb: 4.1,  ctxK:  32, tier: 'Balanced', bestFor: ['chat', 'writing'],                         notes: 'Fast general-purpose' },
  { id: 'qwen2.5:7b',                 name: 'Qwen 2.5 7B',           vramGb: 5.0,  sizeGb: 4.7,  ctxK:  32, tier: 'Balanced', bestFor: ['coding', 'analysis', 'requirements'],      notes: 'Best 7B for technical work' },
  { id: 'qwen2.5-coder:7b-instruct',  name: 'Qwen 2.5 Coder 7B',    vramGb: 4.8,  sizeGb: 4.7,  ctxK:  32, tier: 'Balanced', bestFor: ['code generation', 'debugging'],             notes: 'Specialized coder — RECOMMENDED' },
  { id: 'llama3.1:8b',                name: 'Llama 3.1 8B',          vramGb: 5.0,  sizeGb: 4.7,  ctxK: 128, tier: 'Balanced', bestFor: ['general', 'chat', 'coding'],               notes: 'Meta, 128K context' },
  { id: 'codellama:7b',               name: 'Code Llama 7B',         vramGb: 4.5,  sizeGb: 3.8,  ctxK:  16, tier: 'Balanced', bestFor: ['code generation', 'code completion'],       notes: 'Meta code specialist' },
  // Capable (8-16 GB VRAM)
  { id: 'gemma3:12b',                 name: 'Gemma 3 12B (Google)',  vramGb: 8.0,  sizeGb: 7.8,  ctxK: 128, tier: 'Capable',  bestFor: ['general', 'analysis'],                     notes: 'Google, 128K ctx, vision' },
  { id: 'phi4:latest',                name: 'Phi-4 14B (Microsoft)', vramGb: 9.0,  sizeGb: 8.5,  ctxK:  16, tier: 'Capable',  bestFor: ['reasoning', 'analysis', 'requirements'],   notes: 'Outstanding reasoning' },
  { id: 'qwen2.5:14b',                name: 'Qwen 2.5 14B',          vramGb: 9.0,  sizeGb: 8.9,  ctxK:  32, tier: 'Capable',  bestFor: ['coding', 'requirements engineering'],       notes: 'Best for AEE workflows' },
  { id: 'mistral-nemo:12b',           name: 'Mistral Nemo 12B',     vramGb: 8.0,  sizeGb: 7.1,  ctxK: 128, tier: 'Capable',  bestFor: ['coding', 'reasoning', 'multilingual'],     notes: '128K ctx, tool calling' },
  { id: 'deepseek-coder-v2:latest',   name: 'DeepSeek Coder v2 16B',vramGb: 11.0, sizeGb: 9.1,  ctxK: 128, tier: 'Capable',  bestFor: ['code generation', 'code review'],           notes: 'Top local coding model' },
  // Powerful (16+ GB VRAM)
  { id: 'qwen2.5:32b',                name: 'Qwen 2.5 32B',          vramGb: 20.0, sizeGb: 19.0, ctxK:  32, tier: 'Powerful', bestFor: ['complex reasoning', 'architecture'],        notes: 'Best quality (needs 24GB)' },
  { id: 'llama3.1:70b',               name: 'Llama 3.1 70B',         vramGb: 40.0, sizeGb: 39.0, ctxK: 128, tier: 'Powerful', bestFor: ['complex reasoning', 'analysis'],            notes: 'Flagship (needs 48GB+)' },
  { id: 'qwen2.5-coder:32b',          name: 'Qwen 2.5 Coder 32B',   vramGb: 20.0, sizeGb: 19.0, ctxK:  32, tier: 'Powerful', bestFor: ['code generation', 'architecture'],           notes: 'Best local coder (needs 24GB)' },
];

/**
 * Recommend the best default model based on available VRAM.
 * Prefers qwen2.5-coder variants. Falls back to smallest model for CPU.
 */
export function recommendDefaultModel(vramGb: number): string {
  if (vramGb >= 16) { return 'qwen2.5-coder:7b-instruct'; } // plenty of room
  if (vramGb >= 8)  { return 'qwen2.5-coder:7b-instruct'; } // fits well
  if (vramGb >= 4)  { return 'qwen2.5-coder:3b'; }          // tight but works
  return 'llama3.2:latest';                                   // CPU fallback
}

// Task → model tag mapping for selectModelForTask
export const TASK_SUGGESTIONS: Record<string, string[]> = {
  'Code Generation':         ['code generation', 'debugging', 'coding'],
  'Requirements Engineering':['requirements', 'requirements engineering', 'analysis'],
  'Architecture & Design':   ['complex reasoning', 'architecture', 'requirements engineering'],
  'General Chat':            ['chat', 'writing', 'general'],
  'Analysis & Reasoning':    ['analysis', 'reasoning', 'requirements'],
  'Complex Reasoning':       ['complex reasoning', 'reasoning'],
};

// ── OllamaManager ────────────────────────────────────────────────────────────

export class OllamaManager {
  private static _pullProc: cp.ChildProcess | null = null;

  // ── Connectivity ────────────────────────────────────────────────────────

  /** Check if Ollama is running and reachable. */
  static isRunning(): Promise<boolean> {
    return new Promise((resolve) => {
      http.get(`${OLLAMA_API}/api/version`, (res) => {
        resolve(res.statusCode === 200);
      }).on('error', () => resolve(false));
    });
  }

  // ── Installed models ────────────────────────────────────────────────────

  /**
   * Return the ID of the first installed model, or null if none.
   * Used to auto-select a valid model when no saved setting exists.
   */
  static async getFirstInstalledModel(): Promise<string | null> {
    const ids = await OllamaManager.getInstalledIds();
    return ids.length > 0 ? ids[0] : null;
  }

  /** Return just the IDs of installed models (e.g. ['qwen2.5:14b']). */
  static async getInstalledIds(): Promise<string[]> {
    return new Promise((resolve) => {
      let data = '';
      http.get(`${OLLAMA_API}/api/tags`, (res) => {
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => {
          try {
            const json = JSON.parse(data) as { models?: Array<{ name: string }> };
            resolve((json.models ?? []).map((m) => m.name));
          } catch { resolve([]); }
        });
      }).on('error', () => resolve([]));
    });
  }

  // ── GPU detection ────────────────────────────────────────────────────────

  /** Return available VRAM in GB, or 0 if no GPU detected. */
  static async getVramGb(): Promise<number> {
    // ── NVIDIA nvidia-smi ────────────────────────────────────────────────
    try {
      const result = cp.spawnSync('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], { timeout: 5000, encoding: 'utf8' });
      if (result.status === 0 && result.stdout) {
        const mb = parseInt(result.stdout.trim().split('\n')[0], 10);
        if (!isNaN(mb) && mb > 0) { return mb / 1024; }
      }
    } catch { /* fallthrough */ }

    // ── Windows WMI (AMD / Intel / any WDDM GPU) ─────────────────────────
    if (process.platform === 'win32') {
      try {
        const result = cp.spawnSync(
          'powershell',
          ['-NoProfile', '-Command',
           "Get-WmiObject Win32_VideoController | Sort-Object AdapterRAM -Descending | Select-Object -First 1 -ExpandProperty AdapterRAM"],
          { timeout: 10000, encoding: 'utf8' },
        );
        if (result.status === 0 && result.stdout) {
          const bytes = parseInt(result.stdout.trim(), 10);
          if (!isNaN(bytes) && bytes > 0) { return bytes / (1024 ** 3); }
        }
      } catch { /* no GPU */ }
    }

    return 0; // no GPU or detection failed
  }

  // ── Available models (catalog + installed status) ─────────────────────

  /**
   * Return the full model list for Ollama provider:
   *  - Installed models → category 'Installed', normal id
   *  - Catalog models not installed → category 'Available to Download', id = 'dl:<id>'
   *  - Models that exceed VRAM budget are still shown but marked
   */
  static async getAvailableModels(): Promise<ModelInfo[]> {
    const [installed, vramGb] = await Promise.all([
      OllamaManager.getInstalledIds(),
      OllamaManager.getVramGb(),
    ]);

    const results: ModelInfo[] = [];
    const matchedCatalogIds = new Set<string>();

    // ── Installed models (shown first) ────────────────────────────────────
    for (const id of installed) {
      // Exact match first, then match by base tag (e.g. 'qwen2.5' matches 'qwen2.5:7b')
      const catalog = OLLAMA_CATALOG.find((c) => c.id === id)
        ?? OLLAMA_CATALOG.find((c) => {
          const base = c.id.split(':')[0];
          const installedBase = id.split(':')[0];
          return base === installedBase;
        });
      if (catalog) { matchedCatalogIds.add(catalog.id); }
      results.push({
        id,
        name:          id,  // Always show the real Ollama ID for clarity
        category:      'Installed',
        description:   catalog ? `${catalog.sizeGb}GB • ${catalog.bestFor.slice(0, 2).join(', ')}` : 'local model',
        contextWindow: catalog ? catalog.ctxK * 1024 : 32768,
      });
    }

    // ── Catalog models not yet installed ──────────────────────────────────
    const budget = vramGb > 0 ? vramGb * 0.90 : 999;
    for (const entry of OLLAMA_CATALOG) {
      if (matchedCatalogIds.has(entry.id)) { continue; }
      const fits = entry.vramGb <= budget;
      results.push({
        id:            `dl:${entry.id}`,                // 'dl:' prefix = needs download
        name:          `\u2B07 ${entry.name}`,
        category:      fits ? 'Available to Download' : 'Requires More VRAM',
        description:   `${entry.sizeGb}GB • ${entry.bestFor.slice(0, 2).join(', ')} • ${entry.notes}`,
        contextWindow: entry.ctxK * 1024,
      });
    }

    return results;
  }

  // ── Download ─────────────────────────────────────────────────────────────

  /**
   * Download a model via `ollama pull` with VS Code progress notification.
   * Returns true if successful, false if cancelled or failed.
   */
  static async download(
    modelId: string,
    token: vscode.CancellationToken,
  ): Promise<boolean> {
    const catalog = OLLAMA_CATALOG.find((c) => c.id === modelId);
    const sizeStr = catalog ? ` (~${catalog.sizeGb}GB)` : '';

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title:    `Downloading ${modelId}${sizeStr}`,
        cancellable: true,
      },
      (_progress, progressToken) => new Promise<boolean>((resolve) => {
        const combinedToken = {
          isCancellationRequested: () =>
            token.isCancellationRequested || progressToken.isCancellationRequested,
        };

        const proc = cp.spawn('ollama', ['pull', modelId], {
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        OllamaManager._pullProc = proc;

        let lastPct = 0;
        const rl = readline.createInterface({ input: proc.stdout! });
        rl.on('line', (line) => {
          if (combinedToken.isCancellationRequested()) {
            proc.kill();
            return;
          }
          try {
            const chunk = JSON.parse(line) as {
              status?: string;
              completed?: number;
              total?: number;
              digest?: string;
            };
            const { status = '', completed = 0, total = 0 } = chunk;
            if (status === 'success') {
              _progress.report({ message: '\u2713 Complete', increment: 100 - lastPct });
              return;
            }
            if (total > 0 && completed > 0) {
              const pct = Math.round((completed / total) * 100);
              const mb = (completed / (1024 ** 2)).toFixed(0);
              const totalMb = (total / (1024 ** 2)).toFixed(0);
              const delta = Math.max(0, pct - lastPct);
              if (delta > 0) {
                _progress.report({ message: `${pct}% (${mb}/${totalMb} MB)`, increment: delta });
                lastPct = pct;
              }
            } else if (status) {
              _progress.report({ message: status });
            }
          } catch { /* non-JSON line, ignore */ }
        });

        proc.on('close', (code) => {
          OllamaManager._pullProc = null;
          rl.close();
          if (combinedToken.isCancellationRequested()) {
            void vscode.window.showWarningMessage(`Download of ${modelId} cancelled.`);
            resolve(false);
          } else if (code === 0) {
            void vscode.window.showInformationMessage(`✓ ${modelId} downloaded and ready.`);
            resolve(true);
          } else {
            void vscode.window.showErrorMessage(`Failed to download ${modelId} (exit code ${code})`);
            resolve(false);
          }
        });

        proc.on('error', (err) => {
          OllamaManager._pullProc = null;
          void vscode.window.showErrorMessage(
            `Cannot run ollama pull: ${err.message}. Is Ollama installed?`
          );
          resolve(false);
        });

        // Handle external cancellation
        const cancelListener = token.onCancellationRequested(() => {
          proc.kill();
          cancelListener.dispose();
        });
        progressToken.onCancellationRequested(() => {
          proc.kill();
        });
      }),
    );
  }

  /** Cancel any in-progress download. */
  static cancelDownload(): void {
    if (OllamaManager._pullProc) {
      OllamaManager._pullProc.kill();
      OllamaManager._pullProc = null;
    }
  }

  // ── Task-based suggestions ────────────────────────────────────────────────

  /**
   * Return ordered model suggestions for a task type.
   * Mixes installed local models + catalog + cloud options.
   */
  static async suggestForTask(
    taskKey: string,
    installedIds: string[],
    vramGb: number,
  ): Promise<Array<{ id: string; name: string; installed: boolean; sizeGb?: number; cloud: boolean; notes: string }>> {
    const tags = TASK_SUGGESTIONS[taskKey] ?? [];
    const budget = vramGb > 0 ? vramGb * 0.90 : 999;

    // Score catalog models
    const scored = OLLAMA_CATALOG
      .filter((m) => m.vramGb <= budget)
      .map((m) => {
        const score = tags.reduce((s, t) => s + (m.bestFor.includes(t) ? 1 : 0), 0);
        const installed = installedIds.some((id) => id.includes(m.id.split(':')[0]) || id === m.id);
        return { m, score, installed };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => (b.installed ? 1 : 0) - (a.installed ? 1 : 0) || b.score - a.score);

    return scored.map(({ m, installed }) => ({
      id:        m.id,
      name:      m.name,
      installed,
      sizeGb:    m.sizeGb,
      cloud:     false,
      notes:     m.notes,
    }));
  }
}
