import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectPackageManager } from '../../src/engine/package-manager.js';
import { makeTmp } from './helpers.js';

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir, cleanup } = await makeTmp());
});
afterEach(async () => {
  await cleanup();
});

describe('detectPackageManager', () => {
  it.each([
    ['package-lock.json', 'npm'],
    ['yarn.lock', 'yarn'],
    ['pnpm-lock.yaml', 'pnpm'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['deno.lock', 'deno'],
  ])('%s maps to %s and reports the lockfile directory as root', async (lock, name) => {
    await writeFile(join(dir, lock), '');
    const r = await detectPackageManager(dir);
    expect(r?.name).toBe(name);
    expect(r?.root).toBe(dir);
  });

  it('bun.lock together with bun.lockb is still bun (not ambiguous)', async () => {
    await writeFile(join(dir, 'bun.lock'), '');
    await writeFile(join(dir, 'bun.lockb'), '');
    expect((await detectPackageManager(dir))?.name).toBe('bun');
  });

  it('returns null when two different lockfiles share a directory', async () => {
    await writeFile(join(dir, 'yarn.lock'), '');
    await writeFile(join(dir, 'package-lock.json'), '');
    expect(await detectPackageManager(dir)).toBeNull();
  });

  it('returns null when no lockfile exists up the tree', async () => {
    const sub = join(dir, 'a', 'b');
    await mkdir(sub, { recursive: true });
    // the tmp dir is under the OS tmpdir, which has no lockfiles above it
    expect(await detectPackageManager(sub)).toBeNull();
  });

  it('walks up and reports the directory where the lockfile was found', async () => {
    await writeFile(join(dir, 'pnpm-lock.yaml'), '');
    const sub = join(dir, 'apps', 'web');
    await mkdir(sub, { recursive: true });
    const r = await detectPackageManager(sub);
    expect(r?.name).toBe('pnpm');
    expect(r?.root).toBe(dir);
  });

  it('prefers the nearest lockfile over one further up', async () => {
    await writeFile(join(dir, 'pnpm-lock.yaml'), '');
    const sub = join(dir, 'inner');
    await mkdir(sub);
    await writeFile(join(sub, 'yarn.lock'), '');
    const r = await detectPackageManager(sub);
    expect(r?.name).toBe('yarn');
    expect(r?.root).toBe(sub);
  });

  it('gives up after 10 directories', async () => {
    await writeFile(join(dir, 'yarn.lock'), '');
    const at10 = join(dir, ...Array.from({ length: 10 }, (_, i) => `d${i}`));
    await mkdir(at10, { recursive: true });
    // start + 9 parents = 10 directories examined; at10 reaches dir on its 11th
    expect(await detectPackageManager(at10)).toBeNull();
    const at9 = join(dir, ...Array.from({ length: 9 }, (_, i) => `d${i}`));
    expect((await detectPackageManager(at9))?.root).toBe(dir);
  });

  it.each([
    ['package-lock.json', false, ['install', 'a', 'b']],
    ['package-lock.json', true, ['install', '-D', 'a', 'b']],
    ['yarn.lock', false, ['add', 'a', 'b']],
    ['yarn.lock', true, ['add', '-D', 'a', 'b']],
    ['pnpm-lock.yaml', false, ['add', 'a', 'b']],
    ['pnpm-lock.yaml', true, ['add', '-D', 'a', 'b']],
    ['bun.lock', false, ['add', 'a', 'b']],
    ['bun.lockb', true, ['add', '-D', 'a', 'b']],
    ['deno.lock', false, ['add', 'npm:a', 'npm:b']],
    ['deno.lock', true, ['add', '--dev', 'npm:a', 'npm:b']],
  ])('%s dev=%s installArgs', async (lock, dev, expected) => {
    await writeFile(join(dir, lock), '');
    const r = await detectPackageManager(dir);
    expect(r?.installArgs(['a', 'b'], dev)).toEqual(expected);
  });
});
