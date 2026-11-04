import { spawnSync } from 'node:child_process';

/**
 * Check whether the `pod` binary is callable on the current PATH. Used by
 * the iOS recipe to decide whether to default the `pod install` confirm to
 * "yes" and to block the run-pod-install step early with a useful message.
 *
 * Implemented via a one-shot `pod --version`. Output is suppressed; we only
 * care about the exit code. Caches the answer for the lifetime of the
 * process to avoid paying the spawn cost twice (prompt + step precheck).
 */
let cached: boolean | null = null;

export function isPodOnPath(): boolean {
  if (cached !== null) return cached;
  try {
    const result = spawnSync('pod', ['--version'], { stdio: 'ignore' });
    cached = result.status === 0;
  } catch {
    cached = false;
  }
  return cached;
}

/** For tests — reset the cache between runs. */
export function _resetPodOnPathCache(): void {
  cached = null;
}
