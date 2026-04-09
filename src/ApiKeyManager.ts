// SPDX-License-Identifier: MIT
// Copyright (c) 2026 BitConcepts, LLC. All rights reserved.
/**
 * ApiKeyManager — stores LLM provider API keys in VS Code SecretStorage.
 *
 * Keys are backed by the OS credential store (Windows Credential Manager,
 * macOS Keychain, libsecret on Linux). They never appear in settings.json
 * and are invisible to other extensions.
 *
 * Usage:
 *   // Store
 *   await ApiKeyManager.setKey(context.secrets, 'anthropic', 'sk-ant-...');
 *   // Read
 *   const key = await ApiKeyManager.getKey(context.secrets, 'anthropic');
 *   // Inject into child process
 *   const env = await ApiKeyManager.getAllEnv(context.secrets);
 *   cp.spawn('specsmith', args, { env: { ...process.env, ...env } });
 */
import * as vscode from 'vscode';

// ── Provider → SecretStorage key + environment variable name ─────────────────

export const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic (Claude)',  envVar: 'ANTHROPIC_API_KEY',  secretKey: 'specsmith.key.anthropic' },
  { id: 'openai',    label: 'OpenAI (GPT/O-series)', envVar: 'OPENAI_API_KEY',   secretKey: 'specsmith.key.openai'    },
  { id: 'gemini',    label: 'Google Gemini',        envVar: 'GOOGLE_API_KEY',    secretKey: 'specsmith.key.gemini'    },
  { id: 'mistral',   label: 'Mistral AI',           envVar: 'MISTRAL_API_KEY',   secretKey: 'specsmith.key.mistral'   },
  // Ollama is local — no API key
] as const;

export type ProviderId = typeof PROVIDERS[number]['id'];

function providerDef(id: string) {
  return PROVIDERS.find((p) => p.id === id);
}

// ── Public API ────────────────────────────────────────────────────────────────

export class ApiKeyManager {
  /**
   * Prompt the user to enter (or update) an API key for a provider.
   * Shows a QuickPick of providers then a password InputBox.
   */
  static async promptSetKey(secrets: vscode.SecretStorage): Promise<void> {
    const items = PROVIDERS.map((p) => ({
      label:       p.label,
      description: p.envVar,
      id:          p.id,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a provider to set its API key',
    });
    if (!picked) { return; }

    const def = providerDef(picked.id)!;
    const existing = await secrets.get(def.secretKey);

    const value = await vscode.window.showInputBox({
      title:      `specsmith — ${def.label} API Key`,
      prompt:     `Enter your ${def.envVar}. It will be stored in the OS credential store.`,
      value:      existing ?? '',
      password:   true,
      ignoreFocusOut: true,
      placeHolder: `${def.envVar}=...`,
    });

    if (value === undefined) { return; } // cancelled
    if (value === '') {
      await secrets.delete(def.secretKey);
      void vscode.window.showInformationMessage(`specsmith: ${def.label} API key cleared.`);
    } else {
      await secrets.store(def.secretKey, value);
      void vscode.window.showInformationMessage(`specsmith: ${def.label} API key saved securely ✓`);
    }
  }

  /**
   * Prompt the user to clear an API key.
   */
  static async promptClearKey(secrets: vscode.SecretStorage): Promise<void> {
    const items = PROVIDERS.map((p) => ({ label: p.label, id: p.id }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a provider to clear its stored API key',
    });
    if (!picked) { return; }
    const def = providerDef(picked.id)!;
    await secrets.delete(def.secretKey);
    void vscode.window.showInformationMessage(`specsmith: ${def.label} API key cleared.`);
  }

  /**
   * Get a stored key for a specific provider (undefined if not set).
   */
  static async getKey(secrets: vscode.SecretStorage, provider: string): Promise<string | undefined> {
    const def = providerDef(provider);
    if (!def) { return undefined; }
    return secrets.get(def.secretKey);
  }

  /**
   * Store a key programmatically.
   */
  static async setKey(secrets: vscode.SecretStorage, provider: string, key: string): Promise<void> {
    const def = providerDef(provider);
    if (!def) { return; }
    await secrets.store(def.secretKey, key);
  }

  /**
   * Return all stored keys as environment variable overrides ready for child process env.
   * Only includes providers that have a key stored.
   */
  static async getAllEnv(secrets: vscode.SecretStorage): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    for (const p of PROVIDERS) {
      const key = await secrets.get(p.secretKey);
      if (key) { env[p.envVar] = key; }
    }
    return env;
  }

  /**
   * Return the provider id to use for new sessions.
   * - No keys configured → ollama (local, no key needed)
   * - Exactly one key → that provider
   * - Multiple keys → the user's defaultProvider setting
   */
  static async getDefaultProvider(
    secrets: vscode.SecretStorage,
    fallback: string,
  ): Promise<{ provider: string; hasKeys: boolean }> {
    const configured: string[] = [];
    for (const p of PROVIDERS) {
      const key = await secrets.get(p.secretKey);
      if (key) { configured.push(p.id); }
    }
    let provider: string;
    if (configured.length === 0) { provider = 'ollama'; }
    else if (configured.length === 1) { provider = configured[0]; }
    else { provider = fallback; }
    return { provider, hasKeys: configured.length > 0 };
  }

  /**
   * Show a status notification listing which providers have keys configured.
   */
  static async showStatus(secrets: vscode.SecretStorage): Promise<void> {
    const lines: string[] = [];
    for (const p of PROVIDERS) {
      const key = await secrets.get(p.secretKey);
      const status = key ? '✓ set' : '— not set';
      lines.push(`${p.label}: ${status}`);
    }
    void vscode.window.showInformationMessage(
      `specsmith API Keys:\n${lines.join('\n')}`,
      { modal: true },
      'Set a Key…',
    ).then((action) => {
      if (action === 'Set a Key…') {
        void ApiKeyManager.promptSetKey(secrets);
      }
    });
  }
}
