// SPDX-License-Identifier: MIT
// Copyright (c) 2026 BitConcepts, LLC. All rights reserved.
/**
 * ModelRegistry — fetches live model lists from each provider's REST API.
 *
 * REQ-EXT-001: Model dropdowns MUST always reflect the provider's current model
 * list via live API call on session open, with static fallback when no key is set
 * or the API is unreachable. Provider APIs:
 *   Anthropic: GET https://api.anthropic.com/v1/models
 *   OpenAI:    GET https://api.openai.com/v1/models  (filter non-chat families)
 *   Gemini:    GET https://generativelanguage.googleapis.com/v1beta/models
 *   Mistral:   GET https://api.mistral.ai/v1/models
 *   Ollama:    GET http://localhost:11434/api/tags
 *
 * Results are cached in-memory for 5 minutes.
 */
import * as https from 'https';
import * as http from 'http';
import { ModelInfo } from './types';

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  models: ModelInfo[];
  expiresAt: number;
}

const _cache = new Map<string, CacheEntry>();

// ── Static fallbacks ──────────────────────────────────────────────────────────

// Static fallbacks — updated April 2026.
// These are shown before the live API fetch completes, and as a fallback
// if the provider API is unreachable.
const STATIC: Record<string, ModelInfo[]> = {
  anthropic: [
    // claude-4.6 series (current as of April 2026)
    { id: 'claude-opus-4-6',    name: 'Claude Opus 4.6',    category: 'Latest',    contextWindow: 200000, description: 'Most capable — complex reasoning & coding' },
    { id: 'claude-sonnet-4-6',  name: 'Claude Sonnet 4.6',  category: 'Latest',    contextWindow: 200000, description: 'Balanced — fast & highly capable' },
    { id: 'claude-haiku-4-5',   name: 'Claude Haiku 4.5',   category: 'Latest',    contextWindow: 200000, description: 'Fastest — best cost-efficiency' },
    // claude-4.5 series
    { id: 'claude-opus-4-5',    name: 'Claude Opus 4.5',    category: 'Previous',  contextWindow: 200000, description: 'Previous flagship' },
    { id: 'claude-sonnet-4-5',  name: 'Claude Sonnet 4.5',  category: 'Previous',  contextWindow: 200000, description: 'Previous balanced' },
  ],
  openai: [
    // Multimodal (GPT-4 family)
    { id: 'gpt-4o',           name: 'GPT-4o',           category: 'Multimodal', contextWindow: 128000,  description: 'Vision + text, fast' },
    { id: 'gpt-4o-mini',      name: 'GPT-4o Mini',      category: 'Multimodal', contextWindow: 128000,  description: 'Cost-efficient multimodal' },
    { id: 'gpt-4.1',          name: 'GPT-4.1',          category: 'Multimodal', contextWindow: 1047576, description: 'Latest GPT-4.1, 1M ctx' },
    { id: 'gpt-4.1-mini',     name: 'GPT-4.1 Mini',     category: 'Multimodal', contextWindow: 1047576, description: 'Fast GPT-4.1 mini' },
    { id: 'gpt-4.1-nano',     name: 'GPT-4.1 Nano',     category: 'Multimodal', contextWindow: 1047576, description: 'Fastest, cheapest GPT-4.1' },
    // Reasoning (o-series) — use developer role for system messages
    { id: 'o4-mini',          name: 'o4-mini',          category: 'Reasoning',  contextWindow: 200000,  description: 'Latest fast reasoning (uses developer role)' },
    { id: 'o3',               name: 'o3',               category: 'Reasoning',  contextWindow: 200000,  description: 'Deep reasoning, complex tasks' },
    { id: 'o3-mini',          name: 'o3-mini',          category: 'Reasoning',  contextWindow: 200000,  description: 'Fast reasoning' },
    { id: 'o1',               name: 'o1',               category: 'Reasoning',  contextWindow: 200000,  description: 'Advanced reasoning' },
    // Previous
    { id: 'gpt-4-turbo',      name: 'GPT-4 Turbo',      category: 'Previous',   contextWindow: 128000,  description: 'Previous generation' },
  ],
  gemini: [
    // Gemini 3 series (current frontier, April 2026)
    { id: 'gemini-3.1-pro-preview',  name: 'Gemini 3.1 Pro Preview',  category: 'Frontier', contextWindow: 1048576, description: 'Latest frontier — reasoning + coding' },
    { id: 'gemini-3-flash-preview',  name: 'Gemini 3 Flash Preview',  category: 'Frontier', contextWindow: 1048576, description: 'Fastest frontier model' },
    // Gemini 2.5 series (stable)
    { id: 'gemini-2.5-pro',          name: 'Gemini 2.5 Pro',          category: 'Stable',   contextWindow: 1048576, description: '1M context, reasoning' },
    { id: 'gemini-2.5-flash',        name: 'Gemini 2.5 Flash',        category: 'Stable',   contextWindow: 1048576, description: '1M context, fast (free tier)' },
    // Deprecated — shutting down June 1, 2026
    { id: 'gemini-2.0-flash',        name: 'Gemini 2.0 Flash (⚠ deprecated)',  category: 'Deprecated', contextWindow: 1048576, description: 'Shutting down June 1, 2026' },
  ],
  mistral: [
    { id: 'mistral-large-latest',  name: 'Mistral Large',   category: 'General', contextWindow: 131072, description: 'Most capable Mistral' },
    { id: 'mistral-small-latest',  name: 'Mistral Small',   category: 'General', contextWindow: 131072, description: 'Fast, cost-efficient' },
    { id: 'codestral-latest',      name: 'Codestral',       category: 'Code',    contextWindow: 262144, description: 'Coding specialist, 256K ctx' },
    { id: 'pixtral-large-latest',  name: 'Pixtral Large',   category: 'Vision',  contextWindow: 131072, description: 'Multimodal + OCR' },
    { id: 'pixtral-12b-2409',      name: 'Pixtral 12B',     category: 'Vision',  contextWindow: 131072, description: 'Lightweight multimodal' },
  ],
  ollama: [
    // Qwen 3 (latest generation, April 2026 — tool calling, 128K ctx)
    { id: 'qwen3:14b',              name: 'Qwen 3 14B',            category: 'Latest',   contextWindow: 131072, description: 'Best 14B — tool calling, 128K ctx' },
    { id: 'qwen3:7b',               name: 'Qwen 3 7B',             category: 'Latest',   contextWindow: 131072, description: 'Fast, tool calling, 128K ctx' },
    { id: 'qwen3:32b',              name: 'Qwen 3 32B',            category: 'Powerful', contextWindow: 131072, description: 'Top quality (high VRAM)' },
    { id: 'gemma3:12b',             name: 'Gemma 3 12B',           category: 'Latest',   contextWindow: 131072, description: 'Google Gemma 3, 128K, vision' },
    // Qwen 2.5 (previous stable)
    { id: 'qwen2.5:14b',            name: 'Qwen 2.5 14B',          category: 'General',  contextWindow: 32768,  description: 'Previous gen, reliable' },
    { id: 'qwen2.5:7b',             name: 'Qwen 2.5 7B',           category: 'General',  contextWindow: 32768,  description: 'Previous gen, fast' },
    { id: 'llama3.2:latest',        name: 'Llama 3.2 3B',          category: 'Tiny',     contextWindow: 131072, description: 'Tiny & fast, minimal VRAM' },
    { id: 'deepseek-coder-v2:latest', name: 'DeepSeek Coder v2',   category: 'Code',     contextWindow: 163840, description: 'Top local coding model' },
  ],
};

// ── HTTP helper ───────────────────────────────────────────────────────────────

function get(url: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = (mod as typeof https).get(url, { headers, timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        if ((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Provider fetchers ─────────────────────────────────────────────────────────

async function fetchAnthropic(apiKey: string): Promise<ModelInfo[]> {
  const raw = await get('https://api.anthropic.com/v1/models', {
    'x-api-key':         apiKey,
    'anthropic-version': '2023-06-01',
  });
  const data = JSON.parse(raw) as { data?: Array<{ id: string; display_name?: string }> };
  return (data.data ?? []).map((m) => ({
    id:   m.id,
    name: m.display_name ?? m.id,
  }));
}

/** Assign category from model id for API-fetched OpenAI models. */
function _openaiCategory(id: string): string {
  if (/^o\d/.test(id))     { return 'Reasoning'; }
  if (/^gpt-4o/.test(id))  { return 'Multimodal'; }
  if (/^gpt-4/.test(id))   { return 'GPT-4'; }
  if (/^gpt-3/.test(id))   { return 'GPT-3.5'; }
  if (/^chatgpt/.test(id)) { return 'ChatGPT'; }
  return 'Models';
}

async function fetchOpenAI(apiKey: string): Promise<ModelInfo[]> {
  const raw = await get('https://api.openai.com/v1/models', {
    'Authorization': `Bearer ${apiKey}`,
  });
  const data = JSON.parse(raw) as { data?: Array<{ id: string; created?: number }> };

  // Exclude non-chat model families (embeddings, audio, image, codex, legacy)
  const EXCLUDE = /(embed|whisper|tts-|dall-e|davinci-002|babbage-002|text-moderation|text-search|text-similarity|code-search|audio-|realtime|ft:|codex|text-davinci|text-babbage|text-ada|text-curie|code-davinci|code-cushman|computer-use|instruct)/i;

  return (data.data ?? [])
    .filter((m) => !EXCLUDE.test(m.id))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0)) // newest first
    .map((m) => ({
      id:       m.id,
      name:     m.id,
      category: _openaiCategory(m.id),
    }));
}

async function fetchGemini(apiKey: string): Promise<ModelInfo[]> {
  const raw = await get(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
  );
  const data = JSON.parse(raw) as {
    models?: Array<{ name: string; displayName?: string; description?: string; inputTokenLimit?: number }>;
  };
  return (data.models ?? [])
    .filter((m) => m.name.includes('gemini'))
    .map((m) => ({
      id:            m.name.replace('models/', ''),
      name:          m.displayName ?? m.name,
      description:   m.description,
      contextWindow: m.inputTokenLimit,
    }));
}

async function fetchMistral(apiKey: string): Promise<ModelInfo[]> {
  const raw = await get('https://api.mistral.ai/v1/models', {
    'Authorization': `Bearer ${apiKey}`,
  });
  const data = JSON.parse(raw) as { data?: Array<{ id: string; description?: string }> };
  return (data.data ?? []).map((m) => ({
    id:          m.id,
    name:        m.id,
    description: m.description,
  }));
}

async function fetchOllama(): Promise<ModelInfo[]> {
  // Use OllamaManager which merges installed + catalog + GPU-aware filtering
  const { OllamaManager } = await import('./OllamaManager');
  return OllamaManager.getAvailableModels();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch model list for a provider, using cached result if fresh.
 * Falls back to static list on any error.
 */
export async function fetchModels(provider: string, apiKey?: string): Promise<ModelInfo[]> {
  const cacheKey = `${provider}:${apiKey?.slice(0, 8) ?? ''}`;
  const cached = _cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.models;
  }

  try {
    let models: ModelInfo[];
    switch (provider) {
      case 'anthropic': models = await fetchAnthropic(apiKey ?? ''); break;
      case 'openai':    models = await fetchOpenAI(apiKey ?? '');    break;
      case 'gemini':    models = await fetchGemini(apiKey ?? '');     break;
      case 'mistral':   models = await fetchMistral(apiKey ?? '');    break;
      case 'ollama':    models = await fetchOllama();                  break;
      default:          models = STATIC[provider] ?? [];
    }

    if (models.length > 0) {
      _cache.set(cacheKey, { models, expiresAt: Date.now() + CACHE_TTL_MS });
      return models;
    }
  } catch {
    // fall through to static
  }

  return STATIC[provider] ?? [];
}

/** Return static fallback immediately (for initial render before API responds). */
export function getStaticModels(provider: string): ModelInfo[] {
  return STATIC[provider] ?? [];
}
