// SPDX-License-Identifier: MIT
// Copyright (c) 2026 BitConcepts, LLC. All rights reserved.
/**
 * VenvManager — global user-level Python venv for specsmith.
 *
 * A single shared environment lives at:
 *   Windows:      %USERPROFILE%\.specsmith\venv\
 *   macOS/Linux:  ~/.specsmith/venv/
 *
 * All projects share this venv.  SpecsmithBridge automatically uses it instead
 * of any system-PATH specsmith binary, preventing version conflicts.
 *
 * Ollama is intentionally excluded — it is always installed globally.
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── Custom venv path (set from specsmith.envPath VS Code setting) ──────────────

/** Module-level override. Empty = use the default ~/.specsmith/venv. */
let _customVenvDir = '';

/**
 * Set a custom venv location.  Call this from extension.ts whenever
 * specsmith.envPath changes so all VenvManager functions pick it up.
 */
export function setVenvDir(dir: string): void {
  _customVenvDir = (dir ?? '').trim();
}

/** Absolute path to the global specsmith venv root. */
export function getGlobalVenvDir(): string {
  if (_customVenvDir) { return _customVenvDir; }
  return path.join(os.homedir(), '.specsmith', 'venv');
}

/** True if the global venv exists and contains a working specsmith binary. */
export function venvExists(): boolean {
  return getVenvSpecsmith() !== null;
}

/** Return the path to the venv specsmith binary, or null if no venv. */
export function getVenvSpecsmith(): string | null {
  const base = getGlobalVenvDir();
  const candidates = process.platform === 'win32'
    ? [path.join(base, 'Scripts', 'specsmith.exe'), path.join(base, 'Scripts', 'specsmith')]
    : [path.join(base, 'bin', 'specsmith')];
  for (const c of candidates) { if (fs.existsSync(c)) { return c; } }
  return null;
}

/** Return the path to the venv Python interpreter, or null. */
export function getVenvPython(): string | null {
  const base = getGlobalVenvDir();
  const candidates = process.platform === 'win32'
    ? [path.join(base, 'Scripts', 'python.exe')]
    : [path.join(base, 'bin', 'python3'), path.join(base, 'bin', 'python')];
  for (const c of candidates) { if (fs.existsSync(c)) { return c; } }
  return null;
}

/** Return the specsmith version installed in the venv, or null. */
export function getVenvSpecsmithVersion(): string | null {
  const binary = getVenvSpecsmith();
  if (!binary) { return null; }
  try {
    const r = cp.spawnSync(binary, ['--version'], { timeout: 5000, encoding: 'utf8' });
    if (r.status === 0) {
      const m = (r.stdout ?? '').match(/(\d+\.\d+\.\d+(?:\.dev\d+|a\d+|b\d+|rc\d+)?)/);
      return m?.[1] ?? null;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Build terminal commands to create the global venv and install specsmith.
 * @param channel   'stable' | 'pre-release'
 * @param providers LLM provider packages to co-install
 */
export function buildCreateVenvCommands(
  channel: 'stable' | 'pre-release',
  providers: string[],
): string[] {
  const venvPath = getGlobalVenvDir();
  // On Windows, quoted paths must be prefixed with the & call operator.
  // Without &, PowerShell treats '"C:\path\exe.exe"' as a string expression
  // and produces 'Expressions are only allowed as the first element of a pipeline'.
  const pip = process.platform === 'win32'
    ? `& "${path.join(venvPath, 'Scripts', 'pip.exe')}"`
    : `"${path.join(venvPath, 'bin', 'pip')}"`;
  // pip cannot upgrade itself on Windows — use python -m pip
  const pythonExe = process.platform === 'win32'
    ? `& "${path.join(venvPath, 'Scripts', 'python.exe')}"`
    : `"${path.join(venvPath, 'bin', 'python3')}"`;
  const specsmithPkg = channel === 'pre-release' ? 'specsmith --pre' : 'specsmith';
  const providerPkgs = providers.length > 0 ? providers.join(' ') : '';
  return [
    `python -m venv "${venvPath}" --prompt specsmith-env`,
    `${pythonExe} -m pip install --quiet --upgrade pip`,
    `${pip} install --quiet ${specsmithPkg}`,
    ...(providerPkgs ? [`${pip} install --quiet ${providerPkgs}`] : []),
    `Write-Host "specsmith environment ready at: ${venvPath}"`,
  ];
}

/** Build the terminal command to upgrade specsmith inside the existing venv. */
export function buildUpdateVenvCommand(channel: 'stable' | 'pre-release'): string {
  const venvPath = getGlobalVenvDir();
  const pip = process.platform === 'win32'
    ? `& "${path.join(venvPath, 'Scripts', 'pip.exe')}"`
    : `"${path.join(venvPath, 'bin', 'pip')}"`;
  return channel === 'pre-release'
    ? `${pip} install --upgrade --pre specsmith`
    : `${pip} install --upgrade specsmith`;
}

/** Build terminal commands to delete the global venv. */
export function buildDeleteVenvCommands(): string[] {
  const venvPath = getGlobalVenvDir();
  if (process.platform === 'win32') {
    return [`if (Test-Path "${venvPath}") { Remove-Item -Recurse -Force "${venvPath}"; Write-Host 'specsmith environment deleted.' } else { Write-Host 'No environment found.' }`];
  }
  return [`[ -d "${venvPath}" ] && rm -rf "${venvPath}" && echo 'specsmith environment deleted.' || echo 'No environment found.'`];
}
