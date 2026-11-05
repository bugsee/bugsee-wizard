import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSync = vi.fn();
vi.mock('node:child_process', () => ({ spawnSync: (...a: unknown[]) => spawnSync(...a) }));

import {
  _resetManagerOnPathCache,
  isManagerOnPath,
} from '../../src/recipes/react-native/package-manager.js';

const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
const setPlatform = (value: string) => Object.defineProperty(process, 'platform', { value });

beforeEach(() => {
  spawnSync.mockReset();
  spawnSync.mockReturnValue({ status: 0 });
  _resetManagerOnPathCache();
  Object.defineProperty(process, 'platform', platform);
});

describe('isManagerOnPath', () => {
  it('on Windows the package managers are .cmd shims: the probe goes through a shell', () => {
    setPlatform('win32');
    expect(isManagerOnPath('npm')).toBe(true);
    // one command string, no args array (DEP0190)
    expect(spawnSync.mock.calls[0]?.[0]).toBe('npm --version');
    expect(spawnSync.mock.calls[0]?.[1]).toMatchObject({ shell: true });
  });

  it('elsewhere it spawns directly, without a shell', () => {
    setPlatform('linux');
    isManagerOnPath('pnpm');
    expect(spawnSync.mock.calls[0]?.slice(0, 2)).toEqual(['pnpm', ['--version']]);
    expect(spawnSync.mock.calls[0]?.[2]).not.toHaveProperty('shell');
  });

  it('the probe has a bounded timeout, and a timed-out probe is not cached as "not found"', () => {
    setPlatform('linux');
    spawnSync.mockReturnValueOnce({ status: null, error: { code: 'ETIMEDOUT' } });
    expect(isManagerOnPath('npm')).toBe(false);
    expect(spawnSync.mock.calls[0]?.[2]).toMatchObject({ timeout: 5000 });
    spawnSync.mockReturnValueOnce({ status: 0 });
    expect(isManagerOnPath('npm')).toBe(true); // asked again, not stuck on the slow answer
    setPlatform('win32');
    _resetManagerOnPathCache();
    isManagerOnPath('yarn');
    expect(spawnSync.mock.calls.at(-1)?.[1]).toMatchObject({ shell: true, timeout: 5000 });
  });

  it('a non-zero or failed probe reads as not on PATH, and is cached', () => {
    spawnSync.mockReturnValue({ status: 1 });
    expect(isManagerOnPath('yarn')).toBe(false);
    expect(isManagerOnPath('yarn')).toBe(false);
    expect(spawnSync).toHaveBeenCalledTimes(1);
    spawnSync.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(isManagerOnPath('bun')).toBe(false);
  });
});
