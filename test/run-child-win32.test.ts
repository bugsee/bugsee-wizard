import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...a: unknown[]) => spawnMock(...a) }));

import { runChild } from '../src/core/run-child.js';

function fakeChild(code = 0): EventEmitter {
  const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
  child.stderr = new EventEmitter();
  setImmediate(() => child.emit('close', code));
  return child;
}

const base = { cwd: '/x', forwardStdout: false };

describe('runChild platform handling', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => fakeChild());
  });

  it('win32 + a package manager: spawns through the shell', async () => {
    await runChild('npm', ['install', '-D', '@bugsee/browser@beta'], {
      ...base,
      platform: 'win32',
    });
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({ shell: true, cwd: '/x' });
    // one command string and no args array: with shell: true an args array raises Node 24's
    // DEP0190 warning (the arguments are validated against the safe set first)
    expect(spawnMock.mock.calls[0]?.[0]).toBe('npm install -D @bugsee/browser@beta');
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([]);
  });

  it('accepts every closed-set manager and npm: specifiers on win32', async () => {
    for (const cmd of ['npm', 'yarn', 'pnpm', 'bun']) {
      await runChild(cmd, ['add', '--dev', 'npm:@scope/pkg@1.2.3-beta.1', 'a_b=c+d~e'], {
        ...base,
        platform: 'win32',
      });
    }
    expect(
      spawnMock.mock.calls.map((c) => [
        String(c[0]).split(' ')[0],
        (c[2] as { shell: boolean }).shell,
      ]),
    ).toEqual(['npm', 'yarn', 'pnpm', 'bun'].map((c) => [c, true]));
  });

  it('win32: any argument with a shell metacharacter is refused BEFORE spawning', async () => {
    for (const bad of [
      'a&b',
      'a|b',
      'a;b',
      'a b',
      '$(x)',
      '`x`',
      'a>b',
      'a<b',
      '^x',
      '%PATH%',
      '"x"',
      "a'b",
      'a\nb',
      '',
    ]) {
      await expect(
        runChild('npm', ['install', bad], { ...base, platform: 'win32' }),
        JSON.stringify(bad),
      ).rejects.toThrow(/Refusing to run/);
    }
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('win32 + a command outside the closed set: no shell (and no argument filtering)', async () => {
    await runChild('pod', ['install', 'a b'], { ...base, platform: 'win32' });
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({ shell: false });
  });

  it('non-win32: never a shell, arguments are not filtered', async () => {
    for (const platform of ['linux', 'darwin'] as const) {
      await runChild('npm', ['install', 'a b;c'], { ...base, platform });
    }
    for (const call of spawnMock.mock.calls) expect(call[2]).toMatchObject({ shell: false });
  });

  it('defaults to the real process.platform', async () => {
    await runChild('npm', ['install'], base);
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({ shell: process.platform === 'win32' });
  });
});
