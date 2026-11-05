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
    expect(spawnSync.mock.calls[0]?.[2]).toMatchObject({ shell: true });
  });

  it('elsewhere it spawns directly, without a shell', () => {
    setPlatform('linux');
    isManagerOnPath('pnpm');
    expect(spawnSync.mock.calls[0]?.[2]).toMatchObject({ shell: false });
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
