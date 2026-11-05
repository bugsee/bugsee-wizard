import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { opToStep } from '../../../src/engine/ops/index.js';
import type { OpSpec, RecipeContext } from '../../../src/engine/recipe.js';
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

  it('keeps the install error primary when restoring also fails, and still restores the rest', async () => {
    process.env.FAKE_NPM_FAIL = '1';
    // a directory where package.json should be makes restoring it fail (EISDIR)
    const ctx = ctxFor();
    const pkg = join(project, 'package.json');
    const fs = await import('node:fs/promises');
    const step = opToStep(spec);
    // fake npm replaces package.json with a directory-hostile state: make the lockfile restorable
    await fs.writeFile(
      join(tmp.dir, 'bin', 'npm'),
      `#!/bin/sh\nrm -f package.json; mkdir package.json; echo partial > package-lock.json; echo "ERR! boom" >&2; exit 1\n`,
    );
    const err = await step.apply(ctx).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toContain('boom');
    expect(err?.message).toContain('also failed to restore');
    expect(err?.message).toContain('package.json');
    expect(await readFile(join(project, 'package-lock.json'), 'utf8')).toBe('lock v1\n');
    expect((await fs.stat(pkg)).isDirectory()).toBe(true);
  });

  // pnpm >= 10 writes `allowBuilds` (or a "set this to true or false" placeholder) into
  // pnpm-workspace.yaml during `pnpm add` — found by the e2e suite on pnpm 11.3 — so that file is
  // part of what an install changes, exactly like the lockfile.
  describe('pnpm-workspace.yaml (pnpm side file)', () => {
    const pnpmAt = (root: string) => ({ ...npmAt(root), name: 'pnpm' as const });
    const fakePnpm = async (body: string) => {
      await writeFile(join(tmp.dir, 'bin', 'pnpm'), `#!/bin/sh\n${body}\n`);
      await chmod(join(tmp.dir, 'bin', 'pnpm'), 0o755);
    };
    const yamlPath = () => join(project, 'pnpm-workspace.yaml');
    const one: OpSpec = { op: 'install-package', packages: ['@bugsee/cli'], dev: true };

    beforeEach(async () => {
      await writeFile(join(project, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    });

    it('a failed install restores an edited pnpm-workspace.yaml', async () => {
      await writeFile(yamlPath(), 'allowBuilds:\n  esbuild: true\n');
      await fakePnpm(
        [
          `printf 'allowBuilds:\\n  esbuild: true\\n  "@bugsee/cli": set this to true or false\\n' > pnpm-workspace.yaml`,
          'echo "ERR_PNPM_IGNORED_BUILDS" >&2; exit 1',
        ].join('\n'),
      );
      const ctx = makeCtx(tmp.dir, { packageDir: project, packageManager: pnpmAt(project) });
      await expect(opToStep(one).apply(ctx)).rejects.toThrow('ERR_PNPM_IGNORED_BUILDS');
      expect(await readFile(yamlPath(), 'utf8')).toBe('allowBuilds:\n  esbuild: true\n');
    });

    it('a failed install deletes a pnpm-workspace.yaml it created', async () => {
      await fakePnpm('echo "allowBuilds: {}" > pnpm-workspace.yaml; exit 1');
      const ctx = makeCtx(tmp.dir, { packageDir: project, packageManager: pnpmAt(project) });
      await expect(opToStep(one).apply(ctx)).rejects.toThrow();
      const fs = await import('node:fs/promises');
      await expect(fs.access(yamlPath())).rejects.toThrow();
    });

    it('a successful install records the edit (for uninstall) and rollback restores it', async () => {
      await writeFile(yamlPath(), 'allowBuilds:\n  esbuild: true\n');
      await fakePnpm(
        [
          `printf '{"devDependencies":{"@bugsee/cli":"0.8.2"}}\\n' > package.json`,
          `printf 'allowBuilds:\\n  esbuild: true\\n  "@bugsee/cli": true\\n' > pnpm-workspace.yaml`,
        ].join('\n'),
      );
      const ctx = makeCtx(tmp.dir, { packageDir: project, packageManager: pnpmAt(project) });
      const step = opToStep(one);
      await step.apply(ctx);
      const entry = ctx.entries.find((e) => e.file === 'project/pnpm-workspace.yaml');
      expect(entry).toMatchObject({
        action: 'edited',
        before: 'allowBuilds:\n  esbuild: true\n',
        after: 'allowBuilds:\n  esbuild: true\n  "@bugsee/cli": true\n',
      });
      await step.rollback(ctx);
      expect(await readFile(yamlPath(), 'utf8')).toBe('allowBuilds:\n  esbuild: true\n');
    });

    it('is not touched or recorded for other package managers', async () => {
      await writeFile(yamlPath(), 'allowBuilds: {}\n');
      const ctx = ctxFor();
      await opToStep(spec).apply(ctx);
      expect(ctx.entries.map((e) => e.file)).not.toContain('project/pnpm-workspace.yaml');
    });
  });

  it('rollback before apply is a no-op', async () => {
    await opToStep(spec).rollback(ctxFor());
    expect(await readFile(join(project, 'package.json'), 'utf8')).toBe('{"name":"x"}\n');
  });
});

// pnpm 11 fails an install whose dependency has an unapproved install script
// (ERR_PNPM_IGNORED_BUILDS). The wizard approves exactly the packages it installs in
// pnpm-workspace.yaml, merging with what is there (pnpm 11.3's own --allow-build replaces the map).
describe.skipIf(process.platform === 'win32')('install-package op with pnpm', () => {
  let dir: string;
  let proj: string;
  let log: string;
  const saved = process.env.PATH;
  const ws = () => join(proj, 'pnpm-workspace.yaml');
  const pnpmAt = (root: string) => ({
    name: 'pnpm' as const,
    root,
    installArgs: (pkgs: string[], dev: boolean) => ['add', ...(dev ? ['-D'] : []), ...pkgs],
  });
  const fakePnpm = async (version: string | null) => {
    const bin = join(dir, 'pbin');
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(bin, 'pnpm'),
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then',
        version === null ? '  exit 3' : `  echo "${version}"; exit 0`,
        'fi',
        `printf '%s\\n' "$@" > "${log}.args"`,
        `cat pnpm-workspace.yaml > "${log}.ws" 2>/dev/null || echo none > "${log}.ws"`,
        'echo "lock v2" > pnpm-lock.yaml',
      ].join('\n'),
    );
    await chmod(join(bin, 'pnpm'), 0o755);
    process.env.PATH = `${bin}:${saved}`;
  };
  beforeEach(async () => {
    const t = await makeTmp();
    dir = t.dir;
    proj = join(dir, 'p');
    log = join(dir, 'log');
    await mkdir(proj);
    await writeFile(join(proj, 'package.json'), '{"name":"x"}\n');
    await writeFile(join(proj, 'pnpm-lock.yaml'), 'lock v1\n');
    tmp = t;
  });
  afterEach(async () => {
    process.env.PATH = saved;
    await tmp.cleanup();
  });
  // `--yes` by default: the approval edits the project's pnpm settings, so it needs consent
  const run = (pkgs: string[], tag?: string, over: Partial<RecipeContext> = {}) => {
    const ctx = makeCtx(dir, {
      packageDir: proj,
      packageManager: pnpmAt(proj),
      yes: true,
      ...over,
    });
    const step = opToStep({
      op: 'install-package',
      packages: pkgs,
      dev: true,
      ...(tag ? { tag } : {}),
    });
    return { ctx, step, done: step.apply(ctx) };
  };
  const asker = (answer = true) => {
    const asked: string[] = [];
    return {
      asked,
      confirm: async (m: string) => {
        asked.push(m);
        return answer;
      },
    };
  };

  const args = async () => (await readFile(`${log}.args`, 'utf8')).trim().split('\n');

  it('on pnpm 11 approves the installed packages BEFORE the install and keeps the other entries and comments', async () => {
    await fakePnpm('11.3.0');
    await writeFile(
      ws(),
      '# my workspace\npackages:\n  - apps/*\nallowBuilds:\n  esbuild: true\n  sharp: false\n',
    );
    await run(['@bugsee/cli', 'left-pad'], 'beta').done;
    expect(await args()).toEqual(['add', '-D', '@bugsee/cli@beta', 'left-pad@beta']); // no flag
    // what pnpm saw while installing
    const seen = await readFile(`${log}.ws`, 'utf8');
    expect(seen).toContain('# my workspace');
    expect(seen).toContain('- apps/*');
    expect(seen).toMatch(/esbuild: true/);
    expect(seen).toMatch(/sharp: false/);
    expect(seen).toMatch(/['"]@bugsee\/cli['"]: true/);
    expect(seen).toMatch(/left-pad: true/);
  });

  it('creates pnpm-workspace.yaml when there is none, and records it as created', async () => {
    await fakePnpm('11.0.0');
    const { ctx, done } = run(['@bugsee/cli']);
    await done;
    expect(await readFile(ws(), 'utf8')).toMatch(/allowBuilds:\n\s+['"]@bugsee\/cli['"]: true/);
    expect(ctx.entries.find((e) => e.file.endsWith('pnpm-workspace.yaml'))?.action).toBe('created');
  });

  it("turns pnpm's undecided placeholder into true, and keeps an explicit false", async () => {
    await fakePnpm('11.3.0');
    await writeFile(
      ws(),
      "allowBuilds:\n  '@bugsee/cli': set this to true or false\n  other: false\n",
    );
    await run(['@bugsee/cli', 'other']).done;
    const seen = await readFile(`${log}.ws`, 'utf8');
    expect(seen).toMatch(/['"]@bugsee\/cli['"]: true/);
    expect(seen).toMatch(/other: false/);
  });

  it('rollback and a failed install restore pnpm-workspace.yaml byte for byte', async () => {
    await fakePnpm('11.3.0');
    const original = 'allowBuilds:\n  esbuild: true\n';
    await writeFile(ws(), original);
    const { ctx, step, done } = run(['@bugsee/cli']);
    await done;
    expect(await readFile(ws(), 'utf8')).not.toBe(original);
    await step.rollback(ctx);
    expect(await readFile(ws(), 'utf8')).toBe(original);
    // failure path
    await writeFile(
      join(dir, 'pbin', 'pnpm'),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 11.3.0; exit 0; fi\necho boom >&2; exit 1\n',
    );
    await expect(run(['@bugsee/cli']).done).rejects.toThrow(/boom/);
    expect(await readFile(ws(), 'utf8')).toBe(original);
  });

  it('treats a bare "allowBuilds:" key (null value) as an empty map', async () => {
    await fakePnpm('11.3.0');
    await writeFile(ws(), 'packages:\n  - apps/*\nallowBuilds:\n');
    await run(['@bugsee/cli']).done;
    const seen = await readFile(`${log}.ws`, 'utf8');
    expect(seen).toMatch(/['"]@bugsee\/cli['"]: true/);
    expect(seen).toContain('- apps/*');
  });

  describe('consent', () => {
    const failing = async () => {
      await fakePnpm('11.3.0');
      await writeFile(
        join(dir, 'pbin', 'pnpm'),
        '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 11.3.0; exit 0; fi\necho boom >&2; exit 1\n',
      );
    };
    it('--yes edits without asking', async () => {
      await fakePnpm('11.3.0');
      const a = asker(false);
      await run(['@bugsee/cli'], undefined, {
        yes: true,
        nonInteractive: false,
        confirm: a.confirm,
      }).done;
      expect(a.asked).toEqual([]);
      expect(await readFile(ws(), 'utf8')).toMatch(/@bugsee\/cli['"]: true/);
    });

    it('interactive: asks once, naming the packages and the file, and edits on yes', async () => {
      await fakePnpm('11.3.0');
      const a = asker(true);
      await run(['@bugsee/cli', 'left-pad'], undefined, {
        yes: false,
        nonInteractive: false,
        confirm: a.confirm,
      }).done;
      expect(a.asked).toHaveLength(1);
      expect(a.asked[0]).toContain('@bugsee/cli');
      expect(a.asked[0]).toContain('left-pad');
      expect(a.asked[0]).toContain('pnpm-workspace.yaml');
      expect(await readFile(ws(), 'utf8')).toMatch(/left-pad: true/);
    });

    it('interactive: on no, the file is untouched and a failing install points at the fix', async () => {
      await failing();
      const a = asker(false);
      await expect(
        run(['@bugsee/cli'], undefined, { yes: false, nonInteractive: false, confirm: a.confirm })
          .done,
      ).rejects.toThrow(/boom[\s\S]*approve-builds[\s\S]*--yes/);
      expect(a.asked).toHaveLength(1);
      await expect(readFile(ws())).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('interactive: on no, an install that succeeds anyway (strictDepBuilds off) is fine', async () => {
      await fakePnpm('11.3.0');
      await run(['@bugsee/cli'], undefined, {
        yes: false,
        nonInteractive: false,
        confirm: asker(false).confirm,
      }).done;
      expect(await args()).toEqual(['add', '-D', '@bugsee/cli']);
      await expect(readFile(ws())).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('non-interactive without --yes never edits and never asks', async () => {
      await failing();
      const a = asker(true);
      await expect(
        run(['@bugsee/cli'], undefined, { yes: false, nonInteractive: true, confirm: a.confirm })
          .done,
      ).rejects.toThrow(/approve-builds[\s\S]*--yes/);
      expect(a.asked).toEqual([]);
      await expect(readFile(ws())).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('does not ask when every package is already decided in allowBuilds', async () => {
      await fakePnpm('11.3.0');
      await writeFile(ws(), "allowBuilds:\n  '@bugsee/cli': true\n  other: false\n");
      const a = asker(true);
      await run(['@bugsee/cli', 'other'], undefined, {
        yes: false,
        nonInteractive: false,
        confirm: a.confirm,
      }).done;
      expect(a.asked).toEqual([]);
    });

    it('asks only about the packages that still need approval', async () => {
      await fakePnpm('11.3.0');
      await writeFile(ws(), "allowBuilds:\n  '@bugsee/cli': true\n");
      const a = asker(true);
      await run(['@bugsee/cli', 'left-pad'], undefined, {
        yes: false,
        nonInteractive: false,
        confirm: a.confirm,
      }).done;
      expect(a.asked[0]).toContain('left-pad');
      expect(a.asked[0]).not.toContain('@bugsee/cli');
    });
  });

  it('does nothing on pnpm 10, on an unreadable version, or on a workspace file it cannot parse', async () => {
    await fakePnpm('10.34.9');
    await run(['@bugsee/cli']).done;
    await expect(readFile(ws())).rejects.toMatchObject({ code: 'ENOENT' });
    await fakePnpm(null);
    await run(['@bugsee/cli']).done;
    await expect(readFile(ws())).rejects.toMatchObject({ code: 'ENOENT' });
    await fakePnpm('11.3.0');
    await writeFile(ws(), 'allowBuilds: [unclosed\n');
    await run(['@bugsee/cli']).done;
    expect(await readFile(ws(), 'utf8')).toBe('allowBuilds: [unclosed\n');
    const dup = 'allowBuilds:\n  a: true\nallowBuilds:\n  b: true\n'; // parses, with an error
    await writeFile(ws(), dup);
    await run(['@bugsee/cli']).done;
    expect(await readFile(ws(), 'utf8')).toBe(dup);
    await writeFile(ws(), 'allowBuilds: nope\n');
    const never = asker();
    await run(['@bugsee/cli'], undefined, {
      yes: false,
      nonInteractive: false,
      confirm: never.confirm,
    }).done;
    expect(never.asked).toEqual([]); // nothing to offer: no question either
    expect(await readFile(ws(), 'utf8')).toBe('allowBuilds: nope\n');
  });

  it('does not probe other package managers', async () => {
    const bin = join(dir, 'nbin');
    await mkdir(bin);
    await writeFile(join(bin, 'npm'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}.args"\n`);
    await chmod(join(bin, 'npm'), 0o755);
    process.env.PATH = `${bin}:${saved}`;
    await opToStep({ op: 'install-package', packages: ['left-pad'] }).apply(
      makeCtx(dir, { packageDir: proj, packageManager: npmAt(proj) }),
    );
    expect(await args()).toEqual(['install', 'left-pad']);
    await expect(readFile(ws())).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
