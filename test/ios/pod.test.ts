import { chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _resetPodOnPathCache,
  isPodOnPath,
  POD_PROBE_TIMEOUT_MS,
} from '../../src/recipes/ios/pod.js';
import { cleanup, makeFixture } from './helpers.js';

const originalPath = process.env.PATH;
let dir: string | undefined;

async function fakePod(script: string): Promise<void> {
  dir = await makeFixture({});
  const bin = path.join(dir, 'pod');
  await writeFile(bin, `#!/bin/sh\n${script}\n`);
  await chmod(bin, 0o755);
  process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
}

beforeEach(() => _resetPodOnPathCache());
afterEach(async () => {
  process.env.PATH = originalPath;
  _resetPodOnPathCache();
  if (dir) await cleanup(dir);
  dir = undefined;
});

describe('isPodOnPath', () => {
  it('defaults the probe timeout to 5s', () => {
    expect(POD_PROBE_TIMEOUT_MS).toBe(5000);
  });

  it('is true when `pod --version` exits 0', async () => {
    await fakePod('exit 0');
    expect(isPodOnPath()).toBe(true);
  });

  it('is false when `pod --version` exits non-zero', async () => {
    await fakePod('exit 3');
    expect(isPodOnPath()).toBe(false);
  });

  it('reads a hung `pod` as unavailable once the timeout elapses', async () => {
    await fakePod('sleep 30');
    const started = Date.now();
    expect(isPodOnPath(200)).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('does not cache a timed-out probe: a later probe can still succeed', async () => {
    await fakePod('sleep 30');
    expect(isPodOnPath(200)).toBe(false);
    await fakePod('exit 0');
    expect(isPodOnPath()).toBe(true);
  });

  it('caches the first answer', async () => {
    await fakePod('exit 0');
    expect(isPodOnPath()).toBe(true);
    await fakePod('exit 3');
    expect(isPodOnPath()).toBe(true);
  });
});
