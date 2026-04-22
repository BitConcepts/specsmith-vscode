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

/** Path to the version marker file inside the venv. */
function _versionMarkerPath(): string {
  return path.join(getGlobalVenvDir(), '.specsmith-version');
}

/** Read the version from the marker file (fast, no process spawn). */
export function readVersionMarker(): string | null {
  try {
    const content = fs.readFileSync(_versionMarkerPath(), 'utf8').trim();
    return content || null;
  } catch { return null; }
}

/** Write the version marker file. Called after successful installs. */
export function writeVersionMarker(version: string): void {
  try {
    const dir = getGlobalVenvDir();
    if (fs.existsSync(dir)) {
      fs.writeFileSync(_versionMarkerPath(), version + '\n', 'utf8');
    }
  } catch { /* ignore */ }
}

/**
 * Watch the version marker file for changes. Calls `onChange` with the
 * new version whenever the file is written (e.g. after pip install).
 * Returns a dispose function to stop watching.
 */
export function watchVersionMarker(onChange: (ver: string) => void): () => void {
  const fp = _versionMarkerPath();
  let last = readVersionMarker() ?? '';
  const interval = 2000; // poll every 2s (fs.watchFile is polling-based)
  fs.watchFile(fp, { interval }, () => {
    const cur = readVersionMarker() ?? '';
    if (cur && cur !== last) {
      last = cur;
      onChange(cur);
    }
  });
  return () => fs.unwatchFile(fp);
}

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

/** Return the specsmith version installed in the venv, or null.
 *  Prefers the fast marker file; falls back to spawning specsmith --version. */
export function getVenvSpecsmithVersion(): string | null {
  // Fast path: read marker file (no process spawn)
  const marker = readVersionMarker();
  if (marker) { return marker; }
  // Slow path: spawn specsmith --version
  const binary = getVenvSpecsmith();
  if (!binary) { return null; }
  try {
    const r = cp.spawnSync(binary, ['--version'], { timeout: 5000, encoding: 'utf8' });
    if (r.status === 0) {
      const m = (r.stdout ?? '').match(/(\d+\.\d+\.\d+(?:\.dev\d+|a\d+|b\d+|rc\d+)?)/);
      const ver = m?.[1] ?? null;
      if (ver) { writeVersionMarker(ver); } // seed the marker for next time
      return ver;
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

/** Build the terminal command to upgrade specsmith inside the existing venv.
 *  Appends a version-marker write so the extension detects completion instantly. */
export function buildUpdateVenvCommand(channel: 'stable' | 'pre-release'): string {
  const venvPath = getGlobalVenvDir();
  const pip = process.platform === 'win32'
    ? `& "${path.join(venvPath, 'Scripts', 'pip.exe')}"`
    : `"${path.join(venvPath, 'bin', 'pip')}"`;
  const specsmith = process.platform === 'win32'
    ? `& "${path.join(venvPath, 'Scripts', 'specsmith.exe')}"`
    : `"${path.join(venvPath, 'bin', 'specsmith')}"`;
  const markerPath = _versionMarkerPath().replace(/\\/g, '/');
  // Write version marker after install so the extension detects completion via fs.watchFile
  const writeMarker = process.platform === 'win32'
    ? `${specsmith} --version | Out-File -Encoding utf8 -FilePath "${markerPath}"`
    : `${specsmith} --version > "${markerPath}"`;
  // Stable: --force-reinstall is needed to downgrade from a pre-release
  // (pip considers 0.3.13.dev213 > 0.3.10 and won't downgrade with just --upgrade).
  // Use `;` not `&&` — PowerShell 5 (powershell.exe) doesn't support `&&`.
  if (channel === 'pre-release') {
    return `${pip} install --upgrade --pre specsmith; ${writeMarker}`;
  }
  return `${pip} install --force-reinstall --no-deps specsmith; ${pip} install specsmith; ${writeMarker}`;
}

/** Build terminal commands to delete the global venv. */
export function buildDeleteVenvCommands(): string[] {
  const venvPath = getGlobalVenvDir();
  if (process.platform === 'win32') {
    return [`if (Test-Path "${venvPath}") { Remove-Item -Recurse -Force "${venvPath}"; Write-Host 'specsmith environment deleted.' } else { Write-Host 'No environment found.' }`];
  }
  return [`[ -d "${venvPath}" ] && rm -rf "${venvPath}" && echo 'specsmith environment deleted.' || echo 'No environment found.'`];
}
