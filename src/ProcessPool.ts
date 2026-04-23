// SPDX-License-Identifier: MIT
// Copyright (c) 2026 BitConcepts, LLC. All rights reserved.
/**
 * ProcessPool — reuses SpecsmithBridge instances across session tab
 * open/close cycles to avoid cold-starting the Python process + Ollama
 * model load on every session open.
 *
 * Usage:
 *   acquire(key, factory) → returns a pooled bridge or creates one via factory()
 *   release(key)          → marks bridge as idle, starts 10-min kill timer
 *   dispose(key)          → immediately kills the bridge process
 *   disposeAll()          → kills all pooled processes (extension deactivate)
 */

import { SpecsmithBridge } from './bridge';

interface PoolEntry {
  bridge: SpecsmithBridge;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  idle: boolean;
}

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

const _pool = new Map<string, PoolEntry>();

/**
 * Acquire a bridge for `key`.  If an idle bridge exists in the pool,
 * return it (cancelling the idle timer).  Otherwise call `factory` to
 * create a new one and register it.
 */
export function acquire(key: string, factory: () => SpecsmithBridge): SpecsmithBridge {
  const existing = _pool.get(key);
  if (existing) {
    // Cancel idle kill timer and mark as active
    if (existing.idleTimer !== undefined) {
      clearTimeout(existing.idleTimer);
      existing.idleTimer = undefined;
    }
    existing.idle = false;
    return existing.bridge;
  }
  const bridge = factory();
  _pool.set(key, { bridge, idleTimer: undefined, idle: false });
  return bridge;
}

/**
 * Release a bridge back to the pool.  It stays alive for
 * `IDLE_TIMEOUT_MS` and is then disposed automatically.
 */
export function release(key: string): void {
  const entry = _pool.get(key);
  if (!entry) { return; }
  entry.idle = true;
  // Start idle countdown — process will be killed if no one re-acquires
  if (entry.idleTimer !== undefined) { clearTimeout(entry.idleTimer); }
  entry.idleTimer = setTimeout(() => {
    dispose(key);
  }, IDLE_TIMEOUT_MS);
}

/** Immediately kill the bridge and remove from the pool. */
export function dispose(key: string): void {
  const entry = _pool.get(key);
  if (!entry) { return; }
  if (entry.idleTimer !== undefined) { clearTimeout(entry.idleTimer); }
  entry.bridge.dispose();
  _pool.delete(key);
}

/** Kill all pooled processes (call on extension deactivate). */
export function disposeAll(): void {
  for (const [key] of _pool) { dispose(key); }
}

/** True if a bridge for `key` exists in the pool (idle or active). */
export function has(key: string): boolean {
  return _pool.has(key);
}
