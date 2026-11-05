import { afterEach, describe, expect, it } from 'vitest';

import {
  detectPackageManager,
  findLockfileRoot,
} from '../../src/recipes/react-native/package-manager.js';
import { cleanup, makeFixture } from './helpers.js';

let dir: string | undefined;
afterEach(async () => {
  if (dir) await cleanup(dir);
  dir = undefined;
});

describe('detectPackageManager', () => {
  it.each([
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'], // Bun 1.2+ writes the text lockfile
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
  ])('%s -> %s', async (file, manager) => {
    dir = await makeFixture({ 'package.json': '{}', [file]: '' });
    expect(await detectPackageManager(dir)).toBe(manager);
  });

  it('falls back to npm without a lockfile', async () => {
    dir = await makeFixture({ 'package.json': '{}' });
    expect(await detectPackageManager(dir)).toBe('npm');
  });

  it('finds the lockfile of a monorepo root above the app (a workspace root)', async () => {
    dir = await makeFixture({
      'yarn.lock': '',
      'package.json': JSON.stringify({ workspaces: ['apps/*'] }),
      'apps/mobile/package.json': '{}',
    });
    expect(await detectPackageManager(`${dir}/apps/mobile`)).toBe('yarn');
    expect(await findLockfileRoot(`${dir}/apps/mobile`)).toBe(dir);
  });

  it('a pnpm workspace root counts too', async () => {
    dir = await makeFixture({
      'pnpm-lock.yaml': '',
      'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
      'apps/mobile/package.json': '{}',
    });
    expect(await detectPackageManager(`${dir}/apps/mobile`)).toBe('pnpm');
  });

  it('ignores a stray lockfile above that is not a workspace root (it would run the wrong install)', async () => {
    dir = await makeFixture({
      'yarn.lock': '',
      'package.json': JSON.stringify({ name: 'unrelated' }),
      'apps/mobile/package.json': '{}',
    });
    expect(await detectPackageManager(`${dir}/apps/mobile`)).toBe('npm');
    expect(await findLockfileRoot(`${dir}/apps/mobile`)).toBe(`${dir}/apps/mobile`);
  });

  it('prefers the nearest lockfile', async () => {
    dir = await makeFixture({
      'yarn.lock': '',
      'package.json': JSON.stringify({ workspaces: ['apps/*'] }),
      'apps/mobile/pnpm-lock.yaml': '',
      'apps/mobile/package.json': '{}',
    });
    expect(await detectPackageManager(`${dir}/apps/mobile`)).toBe('pnpm');
    expect(await findLockfileRoot(`${dir}/apps/mobile`)).toBe(`${dir}/apps/mobile`);
  });

  it('the root is the app directory itself when there is no lockfile anywhere', async () => {
    dir = await makeFixture({ 'package.json': '{}' });
    expect(await findLockfileRoot(dir)).toBe(dir);
  });
});
