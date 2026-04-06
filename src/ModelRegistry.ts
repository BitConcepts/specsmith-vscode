// SPDX-License-Identifier: MIT
// Copyright (c) 2026 BitConcepts, LLC. All rights reserved.
/**
 * ModelRegistry — fetches live model lists from each provider's REST API.
 *
 * Results are cached in-memory for 5 minutes so repeat opens don't
 * hammer the network. Falls back to a static list on any error.
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

const STATIC: Record<string, ModelInfo[]> = {
  anthropic: [
    { id: 'claude-opus-4-5',    name: 'Claude Opus 4.5',    contextWindow: 200000 },
    { id: 'claude-sonnet-4-5',  name: 'Claude Sonnet 4.5',  contextWindow: 200000 },
    { id: 'claude-haiku-4-5',   name: 'Claude Haiku 4.5',   contextWindow: 200000 },
    { id: 'claude-opus-4-0',    name: 'Claude Opus 4.0',    contextWindow: 200000 },
    { id: 'claude-sonnet-4-0',  name: 'Claude Sonnet 4.0',  contextWindow: 200000 },
  ],
  openai: [
    { id: 'gpt-4o',       name: 'GPT-4o',         contextWindow: 128000 },
    { id: 'gpt-4o-mini',  name: 'GPT-4o Mini',    contextWindow: 128000 },
    { id: 'o3',           name: 'o3',              contextWindow: 200000 },
    { id: 'o3-mini',      name: 'o3-mini',         contextWindow: 200000 },
    { id: 'o1',           name: 'o1',              contextWindow: 200000 },
    { id: 'gpt-4-turbo',  name: 'GPT-4 Turbo',    contextWindow: 128000 },
  ],
  gemini: [
    { id: 'gemini-2.5-pro',    name: 'Gemini 2.5 Pro',    contextWindow: 1048576 },
    { id: 'gemini-2.5-flash',  name: 'Gemini 2.5 Flash',  contextWindow: 1048576 },
    { id: 'gemini-2.0-pro',    name: 'Gemini 2.0 Pro',    contextWindow: 1048576 },
    { id: 'gemini-2.0-flash',  name: 'Gemini 2.0 Flash',  contextWindow: 1048576 },
  ],
  mistral: [
    { id: 'mistral-large-latest',  name: 'Mistral Large',    contextWindow: 131072 },
    { id: 'mistral-small-latest',  name: 'Mistral Small',    contextWindow: 131072 },
    { id: 'codestral-latest',      name: 'Codestral',        contextWindow: 262144 },
    { id: 'pixtral-large-latest',  name: 'Pixtral Large (OCR)', contextWindow: 131072 },
  ],
  ollama: [
    { id: 'qwen2.5:14b',              name: 'Qwen 2.5 14B',          contextWindow: 32768 },
    { id: 'qwen2.5:7b',               name: 'Qwen 2.5 7B',           contextWindow: 32768 },
    { id: 'llama3.2:latest',          name: 'Llama 3.2',             contextWindow: 131072 },
    { id: 'deepseek-coder-v2:latest', name: 'DeepSeek Coder v2',     contextWindow: 163840 },
    { id: 'mistral:latest',           name: 'Mistral (Ollama)',       contextWindow: 32768 },
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

async function fetchOpenAI(apiKey: string): Promise<ModelInfo[]> {
  const raw = await get('https://api.openai.com/v1/models', {
    'Authorization': `Bearer ${apiKey}`,
  });
  const data = JSON.parse(raw) as { data?: Array<{ id: string }> };
  // Filter to GPT/O models only
  return (data.data ?? [])
    .filter((m) => /^(gpt-|o\d|chatgpt)/i.test(m.id))
    .sort((a, b) => a.id < b.id ? 1 : -1)
    .map((m) => ({ id: m.id, name: m.id }));
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
  // Ollama runs locally — no auth needed
  const raw = await get('http://localhost:11434/api/tags');
  const data = JSON.parse(raw) as { models?: Array<{ name: string; size?: number }> };
  return (data.models ?? []).map((m) => ({
    id:   m.name,
    name: m.name,
  }));
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
