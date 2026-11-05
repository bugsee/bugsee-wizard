import { chmodSync, readFileSync } from 'node:fs';
import { access, chmod, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadManifest } from '../../src/engine/manifest.js';
import { exitCodeFor } from '../../src/engine/noninteractive.js';
import { parseRecipe } from '../../src/engine/recipe.js';
import { type InterruptSignal, runJavaScriptInstall, type SignalHost } from '../../src/web/run.js';
import { runJavaScriptUninstall } from '../../src/web/uninstall.js';
import {
  baseOpts,
  captureOutput,
  makeDeps,
  type Sandbox,
  sandbox,
  tree,
  VITE_RECIPE,
} from './run-helpers.js';

const exists = (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false,
  );

class FakeSignals implements SignalHost {
  handlers = new Map<InterruptSignal, (() => void)[]>();
  exit = vi.fn<(code: number) => void>();
  on(sig: InterruptSignal, h: () => void): void {
    this.handlers.set(sig, [...(this.handlers.get(sig) ?? []), h]);
  }
  off(sig: InterruptSignal, h: () => void): void {
    this.handlers.set(
      sig,
      (this.handlers.get(sig) ?? []).filter((x) => x !== h),
    );
  }
  emit(sig: InterruptSignal): void {
    for (const h of [...(this.handlers.get(sig) ?? [])]) h();
  }
  count(): number {
    return [...this.handlers.values()].reduce((n, l) => n + l.length, 0);
  }
}

describe.skipIf(process.platform === 'win32')('interrupted and failing runs', () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await sandbox('vite-react-spa');
  });
  afterEach(async () => {
    await sb.cleanup();
  });

  /** Fire `fire` once the step whose title includes `after` has finished applying. */
  const hooked = (after: string, fire: () => void) => {
    const cap = captureOutput();
    const log = cap.output.log;
    const success = log.success;
    log.success = (m: string) => {
      success(m);
      if (m.includes(after)) fire();
    };
    return cap;
  };

  it('Ctrl-C between steps rolls everything back, leaves no manifest, exits 130, removes the handlers', async () => {
    const before = await tree(sb.project);
    const sig = new FakeSignals();
    const cap = hooked('Add the Bugsee plugin', () => sig.emit('SIGINT'));
    expect(sig.count()).toBe(0);
    const r = await runJavaScriptInstall(baseOpts(sb.project), makeDeps(cap, { signals: sig }));
    expect(r).toMatchObject({ ok: false, error: 'interrupted' });
    expect(exitCodeFor(r, true)).toBe(130);
    expect(await tree(sb.project)).toEqual(before);
    expect(await exists(join(sb.project, '.bugsee'))).toBe(false);
    expect(sig.count()).toBe(0);
    expect(sig.exit).not.toHaveBeenCalled();
    expect(cap.lines.join('\n')).toContain('Interrupted');
  });

  it('SIGTERM is reported as terminated (143)', async () => {
    const sig = new FakeSignals();
    const cap = hooked('Add the Bugsee plugin', () => sig.emit('SIGTERM'));
    const r = await runJavaScriptInstall(baseOpts(sb.project), makeDeps(cap, { signals: sig }));
    expect(r).toMatchObject({ error: 'terminated' });
    expect(exitCodeFor(r, true)).toBe(143);
  });

  it('a second signal quits at once; the manifest on disk then covers exactly the steps applied so far', async () => {
    const sig = new FakeSignals();
    const seen: { code: number; files: string[] }[] = [];
    sig.exit.mockImplementation((code) => {
      const m = JSON.parse(
        readFileSync(join(sb.project, '.bugsee/wizard-manifest.json'), 'utf8'),
      ) as { entries: { file: string }[] };
      seen.push({ code, files: m.entries.map((e) => e.file) });
    });
    const cap = hooked('Add the Bugsee plugin', () => {
      sig.emit('SIGINT');
      sig.emit('SIGINT');
    });
    await runJavaScriptInstall(baseOpts(sb.project), makeDeps(cap, { signals: sig }));
    expect(seen).toEqual([
      { code: 130, files: ['package.json', 'package-lock.json', 'vite.config.ts'] },
    ]);
  });

  it('handlers are removed after a normal run too', async () => {
    const sig = new FakeSignals();
    const r = await runJavaScriptInstall(
      baseOpts(sb.project),
      makeDeps(captureOutput(), { signals: sig }),
    );
    expect(r.ok).toBe(true);
    expect(sig.count()).toBe(0);
  });

  it('a manifest that cannot be written fails the run clearly and rolls everything back', async () => {
    const before = await tree(sb.project);
    await writeFile(join(sb.project, '.bugsee'), 'in the way'); // mkdir .bugsee fails
    const cap = captureOutput();
    const r = await runJavaScriptInstall(
      baseOpts(sb.project, { ignoreGitChanges: true }),
      makeDeps(cap),
    );
    expect(r).toMatchObject({ ok: false, error: 'step-failed' });
    expect(cap.lines.join('\n')).toContain('Could not record the change in the wizard manifest');
    expect({ ...(await tree(sb.project)), '.bugsee': undefined }).toEqual({
      ...before,
      '.bugsee': undefined,
    });
  });

  it('an interrupted-then-failed run keeps an earlier manifest as it was', async () => {
    const first = await runJavaScriptInstall(baseOpts(sb.project), makeDeps(captureOutput()));
    expect(first.ok).toBe(true);
    const manifestBefore = await readFile(join(sb.project, '.bugsee/wizard-manifest.json'), 'utf8');
    const other = parseRecipe({
      ...VITE_RECIPE,
      ops: [
        { op: 'write-file', path: 'extra.txt', template: 'x' },
        { op: 'set-json-key', file: 'package.json', path: ['a'], value: 1 },
      ],
    });
    const sig = new FakeSignals();
    const cap = hooked('Create extra.txt', () => sig.emit('SIGINT'));
    const r = await runJavaScriptInstall(
      baseOpts(sb.project, { ignoreGitChanges: true }),
      makeDeps(cap, {
        signals: sig,
        resolveRecipe: vi.fn(async () => ({
          recipe: other,
          revision: 'r2',
          source: 'snapshot' as const,
        })),
      }),
    );
    expect(r.error).toBe('interrupted');
    expect(await readFile(join(sb.project, '.bugsee/wizard-manifest.json'), 'utf8')).toBe(
      manifestBefore,
    );
    expect(await exists(join(sb.project, 'extra.txt'))).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'rollback that fails',
  () => {
    let sb: Sandbox;
    beforeEach(async () => {
      sb = await sandbox('vite-react-spa');
    });
    afterEach(async () => {
      await chmod(join(sb.project, 'package.json'), 0o644).catch(() => undefined);
      await sb.cleanup();
    });

    it('keeps the manifest and backups so uninstall can still revert', async () => {
      const original = await readFile(join(sb.project, 'package.json'), 'utf8');
      const recipe = parseRecipe({
        ...VITE_RECIPE,
        ops: [
          { op: 'add-package-script', name: 'bugsee-up', command: 'echo up' },
          // blocked: package.json exists with other content, so the run fails after step 1
          { op: 'write-file', path: 'package.json', template: 'x' },
        ],
      });
      const cap = captureOutput();
      const success = cap.output.log.success;
      cap.output.log.success = (m: string) => {
        success(m);
        // read-only before the rollback starts: restoring package.json then fails with EACCES
        if (m.includes('bugsee-up')) chmodSync(join(sb.project, 'package.json'), 0o444);
      };
      const r = await runJavaScriptInstall(
        baseOpts(sb.project),
        makeDeps(cap, {
          resolveRecipe: vi.fn(async () => ({
            recipe,
            revision: 'r',
            source: 'snapshot' as const,
          })),
        }),
      );
      expect(r).toMatchObject({ ok: false, error: 'step-failed' });
      expect(r.message).toContain('uninstall');
      expect(cap.lines.join('\n')).toContain('manifest was kept');
      expect(await readFile(join(sb.project, 'package.json'), 'utf8')).toContain('bugsee-up');
      expect((await loadManifest(sb.project))?.entries.map((e) => e.file)).toContain(
        'package.json',
      );
      expect(await readdir(join(sb.project, '.bugsee/backup'))).toHaveLength(1);

      await chmod(join(sb.project, 'package.json'), 0o644);
      const u = await runJavaScriptUninstall(
        baseOpts(sb.project, { yes: true }),
        makeDeps(captureOutput()),
      );
      expect(u.steps.find((s) => s.id === 'package.json')?.outcome).toBe('reverted');
      expect(await readFile(join(sb.project, 'package.json'), 'utf8')).toBe(original);
    });
  },
);

describe.skipIf(process.platform === 'win32')('a signal the steps never see', () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await sandbox('vite-react-spa');
  });
  afterEach(async () => {
    await sb.cleanup();
  });
  const run = (ops: unknown[], sig: FakeSignals, cap = captureOutput()) =>
    runJavaScriptInstall(
      baseOpts(sb.project),
      makeDeps(cap, {
        signals: sig,
        resolveRecipe: vi.fn(async () => ({
          recipe: parseRecipe({ ...VITE_RECIPE, ops }),
          revision: 'r',
          source: 'snapshot' as const,
        })),
      }),
    );
  const fireAfter = (title: string, sig: FakeSignals, which: InterruptSignal = 'SIGINT') => {
    const cap = captureOutput();
    const success = cap.output.log.success;
    cap.output.log.success = (m: string) => {
      success(m);
      if (m.includes(title)) sig.emit(which);
    };
    return cap;
  };

  it('arriving during the last applying step still rolls back and exits 130', async () => {
    const sig = new FakeSignals();
    const cap = fireAfter('Create a.txt', sig);
    const r = await run([{ op: 'write-file', path: 'a.txt', template: 'a' }], sig, cap);
    expect(r).toMatchObject({ ok: false, error: 'interrupted' });
    expect(exitCodeFor(r, true)).toBe(130);
    expect(await exists(join(sb.project, 'a.txt'))).toBe(false);
    expect(await exists(join(sb.project, '.bugsee'))).toBe(false);
  });

  it('arriving before a run of already-satisfied steps still rolls back (SIGTERM: 143)', async () => {
    await writeFile(join(sb.project, 'b.txt'), 'b');
    await writeFile(join(sb.project, 'c.txt'), 'c');
    const sig = new FakeSignals();
    const cap = fireAfter('Create a.txt', sig, 'SIGTERM');
    const r = await run(
      [
        { op: 'write-file', path: 'a.txt', template: 'a' },
        { op: 'write-file', path: 'b.txt', template: 'b' },
        { op: 'write-file', path: 'c.txt', template: 'c' },
      ],
      sig,
      cap,
    );
    expect(r).toMatchObject({ ok: false, error: 'terminated' });
    expect(exitCodeFor(r, true)).toBe(143);
    expect(await exists(join(sb.project, 'a.txt'))).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')(
  'install, then the user edits, then uninstall',
  () => {
    let sb: Sandbox;
    beforeEach(async () => {
      sb = await sandbox('vite-react-spa');
    });
    afterEach(async () => {
      await sb.cleanup();
    });

    it('removes only the Bugsee entries from package.json and the config; the lockfile note says what to run', async () => {
      const r = await runJavaScriptInstall(baseOpts(sb.project), makeDeps(captureOutput()));
      expect(r.ok).toBe(true);
      const pkgPath = join(sb.project, 'package.json');
      const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as Record<
        string,
        Record<string, string>
      >;
      // the user: adds a dependency, reorders keys, edits the config and the lockfile
      const edited = {
        dependencies: { zod: '^3.0.0', ...pkg.dependencies },
        devDependencies: Object.fromEntries(Object.entries(pkg.devDependencies ?? {}).reverse()),
        ...Object.fromEntries(Object.entries(pkg).filter(([k]) => !k.endsWith('ependencies'))),
      };
      edited.devDependencies.vitest = '^2.0.0';
      await writeFile(pkgPath, `${JSON.stringify(edited, null, 2)}\n`);
      const cfg = join(sb.project, 'vite.config.ts');
      await writeFile(cfg, `// mine\n${await readFile(cfg, 'utf8')}`);
      await writeFile(join(sb.project, 'package-lock.json'), '{"lockfileVersion":3,"mine":true}\n');

      const cap = captureOutput();
      const u = await runJavaScriptUninstall(baseOpts(sb.project, { yes: true }), makeDeps(cap));
      const outcome = (id: string) => u.steps.find((s) => s.id === id)?.outcome;
      expect(outcome('package.json')).toBe('reverted');
      expect(outcome('vite.config.ts')).toBe('reverted');
      expect(outcome('package-lock.json')).toBe('manual');
      expect(u.incomplete).toBe(true);
      const after = JSON.parse(await readFile(pkgPath, 'utf8')) as Record<
        string,
        Record<string, string>
      >;
      expect(after.dependencies?.zod).toBe('^3.0.0');
      expect(after.devDependencies).toEqual({
        vitest: '^2.0.0',
        ...Object.fromEntries(
          Object.entries(after.devDependencies ?? {}).filter(
            ([k]) => k !== '@bugsee/vite-plugin' && k !== 'vitest',
          ),
        ),
      });
      expect(JSON.stringify(after)).not.toContain('@bugsee');
      const cfgNow = await readFile(cfg, 'utf8');
      expect(cfgNow).toContain('// mine');
      expect(cfgNow).not.toContain('bugsee');
      expect(cap.lines.join('\n')).toContain('npm uninstall @bugsee/vite-plugin');
    });
  },
);
