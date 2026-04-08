// SPDX-License-Identifier: MIT
// Copyright (c) 2026 BitConcepts, LLC. All rights reserved.
/**
 * VenvManager — project-local Python venv for specsmith.
 *
 * Each project can have a `.specsmith/venv/` that contains its own pinned
 * copy of specsmith. The bridge prefers this over the system PATH, which
 * eliminates version conflicts when multiple specsmith installs exist.
 *
 * Layout:
 *   .specsmith/venv/           ← venv root
 *     Scripts/specsmith.exe    ← Windows binary
 *     bin/specsmith            ← macOS / Linux binary
 *     Scripts/python.exe       ← Windows Python
 *     bin/python               ← macOS / Linux Python
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export const VENV_DIR = '.specsmith/venv';

// ── Binary resolution ──────────────────────────────────────────────────────────

/** Return the path to the venv's specsmith binary, or null if no venv exists. */
export function getVenvSpecsmith(projectDir: string): string | null {
  const base = path.join(projectDir, VENV_DIR);
  const candidates = process.platform === 'win32'
    ? [
        path.join(base, 'Scripts', 'specsmith.exe'),
        path.join(base, 'Scripts', 'specsmith'),
      ]
    : [path.join(base, 'bin', 'specsmith')];

  for (const c of candidates) {
    if (fs.existsSync(c)) { return c; }
  }
  return null;
}

/** Return the path to the venv Python interpreter, or null. */
export function getVenvPython(projectDir: string): string | null {
  const base = path.join(projectDir, VENV_DIR);
  const candidates = process.platform === 'win32'
    ? [path.join(base, 'Scripts', 'python.exe')]
    : [path.join(base, 'bin', 'python3'), path.join(base, 'bin', 'python')];

  for (const c of candidates) {
    if (fs.existsSync(c)) { return c; }
  }
  return null;
}

/** Return the specsmith version installed in the venv, or null. */
export function getVenvSpecsmithVersion(projectDir: string): string | null {
  const binary = getVenvSpecsmith(projectDir);
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

// ── Terminal commands for create / update ─────────────────────────────────────

/**
 * Build the terminal commands to create the project venv and install specsmith.
 *
 * @param projectDir Absolute path to the project root.
 * @param channel    'stable' | 'pre-release'
 * @param providers  LLM provider packages to inject (e.g. ['anthropic', 'openai'])
 */
export function buildCreateVenvCommands(
  projectDir: string,
  channel: 'stable' | 'pre-release',
  providers: string[],
): string[] {
  const venvPath = path.join(projectDir, VENV_DIR);

  // Platform-specific pip/python paths inside the venv (before venv is created)
  const pip = process.platform === 'win32'
    ? `"${path.join(venvPath, 'Scripts', 'pip.exe')}"`
    : `"${path.join(venvPath, 'bin', 'pip')}"`;

  const specsmithPkg = channel === 'pre-release'
    ? 'specsmith --pre'
    : 'specsmith';

  const providerPkgs = providers.length > 0 ? providers.join(' ') : '';

  const cmds: string[] = [
    // Create venv
    `python -m venv "${venvPath}" --prompt specsmith-env`,
    // Upgrade pip silently
    `${pip} install --quiet --upgrade pip`,
    // Install specsmith (with channel flag)
    `${pip} install --quiet ${specsmithPkg}`,
    // Install provider packages if any
    ...(providerPkgs ? [`${pip} install --quiet ${providerPkgs}`] : []),
    // Confirm
    `echo "specsmith project environment ready at ${VENV_DIR}"`,
  ];

  return cmds;
}

/**
 * Build the terminal command to upgrade specsmith inside an existing venv.
 */
export function buildUpdateVenvCommand(
  projectDir: string,
  channel: 'stable' | 'pre-release',
): string {
  const venvPath = path.join(projectDir, VENV_DIR);
  const pip = process.platform === 'win32'
    ? `"${path.join(venvPath, 'Scripts', 'pip.exe')}"`
    : `"${path.join(venvPath, 'bin', 'pip')}"`;

  return channel === 'pre-release'
    ? `${pip} install --upgrade --pre specsmith`
    : `${pip} install --upgrade specsmith`;
}

/**
 * Build the terminal commands to delete the project venv.
 *
 * Removes the entire `.specsmith/venv/` directory.
 * Use for both 'Delete' and as the first step of 'Rebuild'.
 */
export function buildDeleteVenvCommands(projectDir: string): string[] {
  const venvPath = path.join(projectDir, VENV_DIR);
  if (process.platform === 'win32') {
    // PowerShell: check existence first to give a clean error instead of a scary exception
    return [
      `if (Test-Path "${venvPath}") { Remove-Item -Recurse -Force "${venvPath}"; Write-Host 'Project environment deleted.' } else { Write-Host 'No project environment found.' }`,
    ];
  }
  return [
    `[ -d "${venvPath}" ] && rm -rf "${venvPath}" && echo 'Project environment deleted.' || echo 'No project environment found.'`,
  ];
}

/** Return the .gitignore entry needed for the venv. */
export function gitignoreEntry(): string {
  return `${VENV_DIR}/`;
}

/** Ensure .specsmith/venv/ is in .gitignore if the file exists. */
export function ensureGitignored(projectDir: string): void {
  const giPath = path.join(projectDir, '.gitignore');
  const entry = gitignoreEntry();
  try {
    let content = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf8') : '';
    if (!content.includes(entry) && !content.includes(VENV_DIR)) {
      content = content.endsWith('\n') ? content : content + '\n';
      content += `\n# specsmith project environment\n${entry}\n`;
      fs.writeFileSync(giPath, content, 'utf8');
    }
  } catch { /* ignore — .gitignore edit is best-effort */ }
}
