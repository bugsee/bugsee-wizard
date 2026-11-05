import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const clack = vi.hoisted(() => ({
  confirm: vi.fn(),
  isCancel: (v: unknown) => v === Symbol.for('cancel'),
  log: { info: vi.fn() },
}));
vi.mock('@clack/prompts', () => clack);

import { rnPnpmBuildsStep } from '../../src/recipes/react-native/steps/pnpm-builds.js';
import { cleanup, makeFixture, makeRnContext } from './helpers.js';

let fixture: string;
const savedPath = process.env.PATH;
afterEach(async () => {
  process.env.PATH = savedPath;
  vi.clearAllMocks();
  await cleanup(fixture);
});

async function fakePnpm(version: string): Promise<void> {
  const bin = join(fixture, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'pnpm'), `#!/bin/sh\necho ${version}\n`);
  await chmod(join(bin, 'pnpm'), 0o755);
  process.env.PATH = `${bin}:${savedPath}`;
}
const ws = () => join(fixture, 'pnpm-workspace.yaml');
const pnpmProject = { 'package.json': '{}', 'pnpm-lock.yaml': 'lockfileVersion: 9\n' };

describe('rnPnpmBuildsStep (the wrapper depends on @bugsee/cli, whose install script pnpm 11 wants decided)', () => {
  it('is satisfied unless pnpm is the manager and the install was asked for', async () => {
    fixture = await makeFixture({ 'package.json': '{}', 'package-lock.json': '{}' });
    expect(
      (
        await rnPnpmBuildsStep.precheck(
          await makeRnContext({ cwd: fixture, runPackageInstall: true }),
        )
      ).kind,
    ).toBe('satisfied');
    await cleanup(fixture);
    fixture = await makeFixture(pnpmProject);
    expect(
      (
        await rnPnpmBuildsStep.precheck(
          await makeRnContext({ cwd: fixture, runPackageInstall: false }),
        )
      ).kind,
    ).toBe('satisfied');
    expect(
      (
        await rnPnpmBuildsStep.precheck(
          await makeRnContext({ cwd: fixture, runPackageInstall: true }),
        )
      ).kind,
    ).toBe('pending');
  });

  it('with --yes records `false` for @bugsee/cli (the README: true only for mirrors lacking the platform packages)', async () => {
    fixture = await makeFixture({ ...pnpmProject, 'pnpm-workspace.yaml': 'nodeLinker: hoisted\n' });
    await fakePnpm('11.3.0');
    const ctx = { ...(await makeRnContext({ cwd: fixture, runPackageInstall: true })), yes: true };
    await rnPnpmBuildsStep.apply(ctx);
    const yaml = await readFile(ws(), 'utf8');
    expect(yaml).toContain('nodeLinker: hoisted');
    expect(yaml).toMatch(/['"]@bugsee\/cli['"]: false/);
    expect(clack.confirm).not.toHaveBeenCalled();
  });

  it('asks without --yes, naming the package; a no leaves the file alone', async () => {
    fixture = await makeFixture(pnpmProject);
    await fakePnpm('11.3.0');
    clack.confirm.mockResolvedValueOnce(false);
    const ctx = await makeRnContext({ cwd: fixture, runPackageInstall: true });
    await rnPnpmBuildsStep.apply(ctx);
    expect(clack.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('@bugsee/cli') }),
    );
    await expect(readFile(ws())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does nothing on pnpm 10', async () => {
    fixture = await makeFixture(pnpmProject);
    await fakePnpm('10.34.9');
    const ctx = { ...(await makeRnContext({ cwd: fixture, runPackageInstall: true })), yes: true };
    await rnPnpmBuildsStep.apply(ctx);
    await expect(readFile(ws())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rollback restores the workspace file byte for byte, and deletes one it created', async () => {
    fixture = await makeFixture({
      ...pnpmProject,
      'pnpm-workspace.yaml': '# mine\nnodeLinker: hoisted\n',
    });
    await fakePnpm('11.3.0');
    const ctx = { ...(await makeRnContext({ cwd: fixture, runPackageInstall: true })), yes: true };
    await rnPnpmBuildsStep.apply(ctx);
    await rnPnpmBuildsStep.rollback(ctx);
    expect(await readFile(ws(), 'utf8')).toBe('# mine\nnodeLinker: hoisted\n');
    await cleanup(fixture);
    fixture = await makeFixture(pnpmProject);
    await fakePnpm('11.3.0');
    const ctx2 = { ...(await makeRnContext({ cwd: fixture, runPackageInstall: true })), yes: true };
    await rnPnpmBuildsStep.apply(ctx2);
    await rnPnpmBuildsStep.rollback(ctx2);
    await expect(readFile(ws())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it("rollback without a record (uninstall) leaves the project's decision alone", async () => {
    fixture = await makeFixture({
      ...pnpmProject,
      'pnpm-workspace.yaml': "allowBuilds:\n  '@bugsee/cli': false\n",
    });
    await rnPnpmBuildsStep.rollback(await makeRnContext({ cwd: fixture }));
    expect(await readFile(ws(), 'utf8')).toContain('@bugsee/cli');
  });
});
