import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { opToStep } from '../../../src/engine/ops/index.js';
import type { OpSpec } from '../../../src/engine/recipe.js';
import { makeCtx, makeTmp, npmAt } from '../helpers.js';

// A fake `npm` first on PATH, executed for real through runChild (shell: false).
const spec: OpSpec = {
  op: 'install-package',
  packages: ['@bugsee/browser', 'left-pad'],
  dev: true,
  tag: 'beta',
};
let tmp: Awaited<ReturnType<typeof makeTmp>>;
let project: string;
let argsFile: string;
const savedPath = process.env.PATH;

beforeEach(async () => {
  tmp = await makeTmp();
  project = join(tmp.dir, 'project');
  const bin = join(tmp.dir, 'bin');
  await mkdir(project);
  await mkdir(bin);
  argsFile = join(tmp.dir, 'args.txt');
  const script = [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > "${argsFile}"`,
    `pwd > "${argsFile}.cwd"`,
    'if [ "$FAKE_NPM_FAIL" = 1 ]; then',
    '  echo "partial" > package.json; echo "partial" > package-lock.json',
    '  echo "ERR! registry unreachable" >&2; exit 1',
    'fi',
    `printf '{"name":"x","devDependencies":{"@bugsee/browser":"1.0.0","left-pad":"1.0.0"}}\\n' > package.json`,
    'echo "lock v2" > package-lock.json',
  ].join('\n');
  await writeFile(join(bin, 'npm'), script);
  await chmod(join(bin, 'npm'), 0o755);
  process.env.PATH = `${bin}:${savedPath}`;
  await writeFile(join(project, 'package.json'), '{"name":"x"}\n');
  await writeFile(join(project, 'package-lock.json'), 'lock v1\n');
});
afterEach(async () => {
  process.env.PATH = savedPath;
  delete process.env.FAKE_NPM_FAIL;
  await tmp.cleanup();
});

const ctxFor = () => makeCtx(tmp.dir, { packageDir: project, packageManager: npmAt(project) });

describe.skipIf(process.platform === 'win32')('install-package op', () => {
  it('id and title', () => {
    const step = opToStep(spec);
    expect(step.id).toBe('install-package:@bugsee/browser,left-pad');
    expect(step.title).toContain('@bugsee/browser');
    expect(step.title).toContain('@beta');
  });

  it('runs <pm> <installArgs> in packageDir with tags appended and dev flag, records files', async () => {
    const ctx = ctxFor();
    const step = opToStep(spec);
    expect(await step.precheck(ctx)).toEqual({ kind: 'pending' });
    await step.apply(ctx);
    expect((await readFile(argsFile, 'utf8')).trim().split('\n')).toEqual([
      'install',
      '-D',
      '@bugsee/browser@beta',
      'left-pad@beta',
    ]);
    expect((await readFile(`${argsFile}.cwd`, 'utf8')).trim()).toContain('project');
    expect(ctx.entries.map((e) => [e.file, e.action])).toEqual([
      ['project/package.json', 'edited'],
      ['project/package-lock.json', 'edited'],
    ]);
    expect(ctx.entries[0]?.before).toBe('{"name":"x"}\n');
    expect(ctx.entries[1]).toMatchObject({ before: 'lock v1\n', after: 'lock v2\n' });
    expect(await step.precheck(ctx)).toEqual({ kind: 'satisfied' });
  });

  it('without a tag or dev flag the plain package names are used', async () => {
    const step = opToStep({ op: 'install-package', packages: ['left-pad'] });
    await step.apply(ctxFor());
    expect((await readFile(argsFile, 'utf8')).trim().split('\n')).toEqual(['install', 'left-pad']);
    expect(step.title).not.toContain('@');
  });

  it('rollback restores package.json and the lockfile byte-for-byte', async () => {
    const ctx = ctxFor();
    const step = opToStep(spec);
    await step.apply(ctx);
    await step.rollback(ctx);
    expect(await readFile(join(project, 'package.json'), 'utf8')).toBe('{"name":"x"}\n');
    expect(await readFile(join(project, 'package-lock.json'), 'utf8')).toBe('lock v1\n');
  });

  it('rollback deletes a lockfile the install created', async () => {
    await (await import('node:fs/promises')).rm(join(project, 'package-lock.json'));
    const ctx = ctxFor();
    const step = opToStep(spec);
    await step.apply(ctx);
    expect(ctx.entries.find((e) => e.file.endsWith('package-lock.json'))?.action).toBe('created');
    await step.rollback(ctx);
    await expect(readFile(join(project, 'package-lock.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('on failure throws with the stderr tail and leaves the repo exactly as it was', async () => {
    process.env.FAKE_NPM_FAIL = '1';
    const ctx = ctxFor();
    await expect(opToStep(spec).apply(ctx)).rejects.toThrow(/registry unreachable/);
    expect(await readFile(join(project, 'package.json'), 'utf8')).toBe('{"name":"x"}\n');
    expect(await readFile(join(project, 'package-lock.json'), 'utf8')).toBe('lock v1\n');
    expect(ctx.entries).toEqual([]);
  });

  it('is satisfied only when EVERY package is already declared (deps or devDeps)', async () => {
    await writeFile(
      join(project, 'package.json'),
      JSON.stringify({
        dependencies: { 'left-pad': '1' },
        devDependencies: { '@bugsee/browser': '1' },
      }),
    );
    expect(await opToStep(spec).precheck(ctxFor())).toEqual({ kind: 'satisfied' });
    await writeFile(
      join(project, 'package.json'),
      JSON.stringify({ dependencies: { 'left-pad': '1' } }),
    );
    expect(await opToStep(spec).precheck(ctxFor())).toEqual({ kind: 'pending' });
  });

  it('is blocked with a reason when no package manager is detected', async () => {
    const status = await opToStep(spec).precheck(makeCtx(tmp.dir, { packageDir: project }));
    expect(status).toMatchObject({ kind: 'blocked' });
    expect(status.kind === 'blocked' && status.reason).toContain('package manager');
  });

  it('apply without a package manager throws and runs nothing', async () => {
    await expect(opToStep(spec).apply(makeCtx(tmp.dir, { packageDir: project }))).rejects.toThrow(
      /package manager/,
    );
    await expect(readFile(argsFile)).rejects.toBeDefined();
  });

  it('pending when package.json does not exist yet', async () => {
    await (await import('node:fs/promises')).rm(join(project, 'package.json'));
    expect(await opToStep(spec).precheck(ctxFor())).toEqual({ kind: 'pending' });
  });

  it('a lockfile at the workspace root (above packageDir) is snapshotted and restored', async () => {
    await writeFile(join(tmp.dir, 'package-lock.json'), 'root lock v1\n');
    await (await import('node:fs/promises')).rm(join(project, 'package-lock.json'));
    const ctx = makeCtx(tmp.dir, { packageDir: project, packageManager: npmAt(tmp.dir) });
    const bin = join(tmp.dir, 'bin', 'npm');
    await writeFile(
      bin,
      `#!/bin/sh\necho "root lock v2" > "${join(tmp.dir, 'package-lock.json')}"\n`,
    );
    const step = opToStep(spec);
    await step.apply(ctx);
    expect(await readFile(join(tmp.dir, 'package-lock.json'), 'utf8')).toBe('root lock v2\n');
    await step.rollback(ctx);
    expect(await readFile(join(tmp.dir, 'package-lock.json'), 'utf8')).toBe('root lock v1\n');
  });

  it('a binary lockfile (bun.lockb) is restored byte-exact and not recorded as text', async () => {
    const bun = { ...npmAt(project), name: 'bun' as const };
    await writeFile(join(project, 'bun.lockb'), Buffer.from([0, 255, 1, 254]));
    await writeFile(
      join(tmp.dir, 'bin', 'bun'),
      `#!/bin/sh\nprintf '\\000\\001\\002' > bun.lockb\necho '{"devDependencies":{"left-pad":"1"}}' > package.json\n`,
    );
    await chmod(join(tmp.dir, 'bin', 'bun'), 0o755);
    const ctx = makeCtx(tmp.dir, { packageDir: project, packageManager: bun });
    const step = opToStep({ op: 'install-package', packages: ['left-pad'] });
    await step.apply(ctx);
    expect(ctx.entries.map((e) => e.file)).toEqual(['project/package.json']);
    await step.rollback(ctx);
    expect([...(await readFile(join(project, 'bun.lockb')))]).toEqual([0, 255, 1, 254]);
  });

  it('rollback before apply is a no-op', async () => {
    await opToStep(spec).rollback(ctxFor());
    expect(await readFile(join(project, 'package.json'), 'utf8')).toBe('{"name":"x"}\n');
  });
});
