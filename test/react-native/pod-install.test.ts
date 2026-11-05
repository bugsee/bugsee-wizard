import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetPodOnPathCache } from '../../src/recipes/ios/pod.js';
import { runRnPodInstallStep } from '../../src/recipes/react-native/steps/run-rn-pod-install.js';
import { cleanup, makeFixture, makeRnContext } from './helpers.js';

vi.mock('@clack/prompts', () => ({
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), error: vi.fn() }),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), step: vi.fn() },
}));

let fixture: string;
const savedPath = process.env.PATH;
beforeEach(() => _resetPodOnPathCache());
afterEach(async () => {
  process.env.PATH = savedPath;
  _resetPodOnPathCache();
  await cleanup(fixture);
});

/** A fake `pod` first on PATH: records its arguments and working directory. */
async function fakePod(exit = 0): Promise<string> {
  const bin = join(fixture, '..', `pod-bin-${Date.now()}`);
  await mkdir(bin, { recursive: true });
  const log = join(bin, 'log');
  await writeFile(
    join(bin, 'pod'),
    `#!/bin/sh\nprintf '%s|%s\\n' "$*" "$PWD" >> "${log}"\nexit ${exit}\n`,
  );
  await chmod(join(bin, 'pod'), 0o755);
  process.env.PATH = `${bin}:${savedPath}`;
  return log;
}

const files = {
  'package.json': '{}',
  'ios/App.xcodeproj/project.pbxproj': '',
  'ios/Podfile': "platform :ios, '15.1'\n",
};

describe('runRnPodInstallStep', () => {
  it('is satisfied when pod install was not asked for', async () => {
    fixture = await makeFixture(files);
    const ctx = await makeRnContext({ cwd: fixture, runPodInstall: false });
    expect(await runRnPodInstallStep.precheck(ctx)).toEqual({
      kind: 'satisfied',
      note: 'pod install not requested',
    });
  });

  it('is blocked, with the reason, when there is no Podfile', async () => {
    fixture = await makeFixture({ 'package.json': '{}', 'ios/.keep': '' });
    const status = await runRnPodInstallStep.precheck(
      await makeRnContext({ cwd: fixture, runPodInstall: true }),
    );
    expect(status).toMatchObject({ kind: 'blocked' });
    expect(status.kind === 'blocked' && status.reason).toContain('Podfile');
  });

  it('is blocked when pod is not on PATH', async () => {
    fixture = await makeFixture(files);
    process.env.PATH = '/nonexistent';
    const status = await runRnPodInstallStep.precheck(
      await makeRnContext({ cwd: fixture, runPodInstall: true }),
    );
    expect(status).toMatchObject({ kind: 'blocked' });
    expect(status.kind === 'blocked' && status.reason).toContain('pod');
  });

  it('runs `pod install` in the Podfile directory', async () => {
    fixture = await makeFixture(files);
    const log = await fakePod();
    const ctx = await makeRnContext({ cwd: fixture, runPodInstall: true });
    expect(await runRnPodInstallStep.precheck(ctx)).toEqual({ kind: 'pending' });
    await runRnPodInstallStep.apply(ctx);
    // the availability probe (`pod --version`) is logged first
    const [args, cwd] = (await readFile(log, 'utf8')).trim().split('\n').at(-1)?.split('|') ?? [];
    expect(args).toBe('install');
    expect(cwd).toMatch(/ios$/);
  });

  it('a failing pod install fails the step (the run rolls back)', async () => {
    fixture = await makeFixture(files);
    await fakePod(1);
    const ctx = await makeRnContext({ cwd: fixture, runPodInstall: true });
    await expect(runRnPodInstallStep.apply(ctx)).rejects.toThrow(/pod install/);
  });

  it('rollback leaves Pods/ alone', async () => {
    fixture = await makeFixture({ ...files, 'ios/Pods/keep': 'x' });
    const ctx = await makeRnContext({ cwd: fixture, runPodInstall: true });
    await runRnPodInstallStep.rollback(ctx);
    expect(await readFile(join(fixture, 'ios/Pods/keep'), 'utf8')).toBe('x');
  });
});
