import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeRecipe, InterruptedError } from '../../src/engine/execute.js';
import {
  createManifestRecorder,
  loadManifest,
  rollbackFromManifest,
} from '../../src/engine/manifest.js';
import { parseRecipe } from '../../src/engine/recipe.js';
import { makeCtx, makeTmp } from './helpers.js';

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir, cleanup } = await makeTmp());
});
afterEach(() => cleanup());

const META = { wizard: '1', recipes: [{ id: 'r', revision: '1' }] };
const rb = (dryRun = false) => rollbackFromManifest({ dir, log: makeCtx(dir).log, dryRun });
const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );
const json = async (f: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(dir, f), 'utf8')) as Record<string, unknown>;

const PKG0 = `${JSON.stringify({ name: 'app', scripts: { build: 'vite build' }, dependencies: { react: '^18' } }, null, 2)}\n`;

/** What `pnpm add -D @bugsee/vite-plugin` plus the wizard's script step leave in package.json. */
const PKG1 = `${JSON.stringify(
  {
    name: 'app',
    scripts: { build: 'vite build && npm run bugsee-upload', 'bugsee-upload': 'bugsee up' },
    dependencies: { react: '^18' },
    devDependencies: { '@bugsee/vite-plugin': '^0.1.0' },
  },
  null,
  2,
)}\n`;

async function installed(): Promise<void> {
  await writeFile(join(dir, 'package.json'), PKG1);
  await writeFile(join(dir, 'package-lock.json'), '{"v":2}\n');
  const r = createManifestRecorder(dir, META, { ignoreInGit: false });
  r.record({ file: 'package.json', action: 'edited', before: PKG0, after: PKG1 });
  r.record({
    file: 'package-lock.json',
    action: 'edited',
    before: '{"v":1}\n',
    after: '{"v":2}\n',
  });
  await r.flush();
}

describe('targeted revert of files the user kept editing', () => {
  it('package.json: removes only the dependency, script and chain suffix; keeps the user changes', async () => {
    await installed();
    const user = {
      name: 'app',
      version: '2.0.0',
      scripts: {
        build: 'vite build && npm run bugsee-upload && echo done',
        lint: 'biome check',
        'bugsee-upload': 'bugsee up',
      },
      dependencies: { zod: '^3', react: '^18' },
      devDependencies: { '@bugsee/vite-plugin': '^0.2.0', vitest: '^2' },
    };
    await writeFile(join(dir, 'package.json'), `${JSON.stringify(user, null, 2)}\n`);
    const out = await rb();
    const pkg = out.results.find((r) => r.file === 'package.json');
    expect(pkg).toMatchObject({ outcome: 'reverted' });
    expect(pkg?.note).toContain('your edits were kept');
    expect(await json('package.json')).toEqual({
      name: 'app',
      version: '2.0.0',
      scripts: { build: 'vite build && echo done', lint: 'biome check' },
      dependencies: { zod: '^3', react: '^18' },
      devDependencies: { vitest: '^2' },
    });
  });

  it('package.json: drops a dependency section the wizard created once it is empty', async () => {
    await installed();
    await writeFile(
      join(dir, 'package.json'),
      `${JSON.stringify({ ...(await json('package.json')), license: 'MIT' }, null, 2)}\n`,
    );
    await rb();
    const pkg = await json('package.json');
    expect(pkg.devDependencies).toBeUndefined();
    expect(pkg.license).toBe('MIT');
  });

  it('a script the user rewrote is left in place and named in the note', async () => {
    await installed();
    const cur = await json('package.json');
    (cur.scripts as Record<string, string>)['bugsee-upload'] = 'my own thing';
    (cur.scripts as Record<string, string>).build = 'tsc';
    await writeFile(join(dir, 'package.json'), `${JSON.stringify(cur, null, 2)}\n`);
    const out = await rb();
    const pkg = out.results.find((r) => r.file === 'package.json');
    expect(pkg?.outcome).toBe('manual');
    expect(pkg?.note).toContain('scripts.bugsee-upload');
    // the part that was safe still went
    expect((await json('package.json')).devDependencies).toBeUndefined();
  });

  it('lockfile: left alone, but the note names the packages and the command', async () => {
    await installed();
    await writeFile(join(dir, 'package-lock.json'), '{"v":3}\n');
    const out = await rb();
    const lock = out.results.find((r) => r.file === 'package-lock.json');
    expect(lock?.outcome).toBe('manual');
    expect(lock?.note).toContain('npm uninstall @bugsee/vite-plugin');
    expect(await readFile(join(dir, 'package-lock.json'), 'utf8')).toBe('{"v":3}\n');
  });

  it('text config: removes the wizard lines (import + plugin call), keeps the rest', async () => {
    const before = [
      "import react from '@vitejs/plugin-react';",
      '',
      'export default {',
      '  plugins: [',
      '    react(),',
      '  ],',
      '};',
      '',
    ].join('\n');
    const after = [
      "import react from '@vitejs/plugin-react';",
      "import { bugsee } from '@bugsee/vite-plugin'; // bugsee-wizard",
      '',
      'export default {',
      '  plugins: [',
      '    react(),',
      '    bugsee(),',
      '  ],',
      '};',
      '',
    ].join('\n');
    await writeFile(join(dir, 'vite.config.ts'), after);
    const r = createManifestRecorder(dir, META, { ignoreInGit: false });
    r.record({ file: 'vite.config.ts', action: 'edited', before, after, marker: 'bugsee-wizard' });
    await r.flush();
    const user = after
      .replace('react(),', 'react(),\n    legacy(),')
      .replace('export default', "import legacy from 'x';\nexport default");
    await writeFile(join(dir, 'vite.config.ts'), user);
    const out = await rb();
    expect(out.results[0]?.outcome).toBe('reverted');
    const now = await readFile(join(dir, 'vite.config.ts'), 'utf8');
    expect(now).not.toContain('bugsee');
    expect(now).toContain('legacy(),');
    expect(now).toContain("import legacy from 'x';");
  });

  it('text config: a wizard line the user rewrote is reported by name, file kept', async () => {
    await writeFile(join(dir, 'a.ts'), 'one\nbugsee(),\ntwo\n');
    const r = createManifestRecorder(dir, META, { ignoreInGit: false });
    r.record({
      file: 'a.ts',
      action: 'edited',
      before: 'one\ntwo\n',
      after: 'one\nbugsee(),\ntwo\n',
    });
    await r.flush();
    await writeFile(join(dir, 'a.ts'), 'one\nbugsee({ x: 1 }),\ntwo\nthree\n');
    const out = await rb();
    expect(out.results[0]?.outcome).toBe('manual');
    expect(out.results[0]?.note).toContain('remove the line "bugsee(),"');
    expect(await readFile(join(dir, 'a.ts'), 'utf8')).toContain('three');
  });

  it('.gitignore the wizard created: removes its lines, keeps the user lines, deletes it when nothing is left', async () => {
    const r = createManifestRecorder(dir, META, { ignoreInGit: false });
    await writeFile(join(dir, '.gitignore'), '.env.x\n.bugsee/\n');
    r.record({ file: '.gitignore', action: 'created', after: '.env.x\n' });
    r.record({
      file: '.gitignore',
      action: 'edited',
      before: '.env.x\n',
      after: '.env.x\n.bugsee/\n',
    });
    await r.flush();
    await writeFile(join(dir, '.gitignore'), 'dist\n.env.x\n.bugsee/\ncoverage\n');
    expect((await rb()).results[0]?.outcome).toBe('reverted');
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe('dist\ncoverage\n');
  });

  it('.gitignore: wizard lines only (user edit was whitespace) deletes the file', async () => {
    const r = createManifestRecorder(dir, META, { ignoreInGit: false });
    await writeFile(join(dir, '.gitignore'), '.env.x\n\n\n');
    r.record({ file: '.gitignore', action: 'created', after: '.env.x\n' });
    await r.flush();
    expect((await rb()).results[0]?.outcome).toBe('deleted');
    expect(await exists(join(dir, '.gitignore'))).toBe(false);
  });

  it('a created non-gitignore file the user changed is manual and says to delete it', async () => {
    await writeFile(join(dir, 'x.txt'), 'mine');
    const r = createManifestRecorder(dir, META, { ignoreInGit: false });
    r.record({ file: 'x.txt', action: 'created', after: 'theirs' });
    await r.flush();
    const out = await rb();
    expect(out.results[0]?.note).toContain('Delete it');
  });

  it('an older manifest (no edits) stays manual but points at the saved original', async () => {
    await writeFile(join(dir, 'package.json'), 'user');
    const r = createManifestRecorder(dir, META, { ignoreInGit: false });
    r.record({ file: 'package.json', action: 'edited', before: PKG0, after: PKG1 });
    await r.flush();
    const m = await loadManifest(dir);
    const entry = m?.entries[0];
    delete entry?.edits;
    await writeFile(join(dir, '.bugsee/wizard-manifest.json'), JSON.stringify(m));
    const out = await rb();
    expect(out.results[0]?.outcome).toBe('manual');
    expect(out.results[0]?.note).toContain('.bugsee/backup/');
  });

  it('dry run reports the same outcome and writes nothing', async () => {
    await installed();
    const cur = `${JSON.stringify({ ...(await json('package.json')), license: 'MIT' }, null, 2)}\n`;
    await writeFile(join(dir, 'package.json'), cur);
    const out = await rb(true);
    expect(out.results.find((r) => r.file === 'package.json')?.outcome).toBe('reverted');
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(cur);
  });

  it('rejects a manifest whose edits are malformed', async () => {
    await installed();
    const m = await loadManifest(dir);
    const bad = { ...m, entries: [{ ...m?.entries[0], edits: [{ kind: 'nope' }] }] };
    await writeFile(join(dir, '.bugsee/wizard-manifest.json'), JSON.stringify(bad));
    expect(await loadManifest(dir)).toBeNull();
  });
});

describe('changed JSON values', () => {
  const record = async (chain: [string, string][]): Promise<void> => {
    const r = createManifestRecorder(dir, META, { ignoreInGit: false });
    for (const [b, a] of chain)
      r.record({ file: 'package.json', action: 'edited', before: b, after: a });
    await r.flush();
  };

  it('a non-string value still equal to the wizard value is set back whole', async () => {
    const v0 = '{"files":["dist"]}';
    const v1 = '{"files":["dist","bugsee"]}';
    await writeFile(join(dir, 'package.json'), v1);
    await record([[v0, v1]]);
    await writeFile(join(dir, 'package.json'), '{"files":["dist","bugsee"],"x":1}');
    await rb();
    expect(await json('package.json')).toEqual({ files: ['dist'], x: 1 });
  });

  it('two chained edits of one value are undone newest first', async () => {
    const v = (s: string): string => JSON.stringify({ scripts: { build: s } });
    await record([
      [v('a'), v('a && b')],
      [v('a && b'), v('a && b && c')],
    ]);
    await writeFile(join(dir, 'package.json'), `${v('a && b && c')}\n`);
    await rb();
    expect(await json('package.json')).toEqual({ scripts: { build: 'a' } });
  });
});

describe('chained edits of one key', () => {
  it('a key the wizard added and then changed is removed (newest edit undone first)', async () => {
    const r = createManifestRecorder(dir, META, { ignoreInGit: false });
    r.record({ file: 'package.json', action: 'edited', before: '{"a":1}', after: '{"a":1,"k":1}' });
    r.record({
      file: 'package.json',
      action: 'edited',
      before: '{"a":1,"k":1}',
      after: '{"a":1,"k":2}',
    });
    await r.flush();
    await writeFile(join(dir, 'package.json'), '{"a":1,"k":2,"z":3}');
    expect((await rb()).results[0]?.outcome).toBe('reverted');
    expect(await json('package.json')).toEqual({ a: 1, z: 3 });
  });
});

describe('manifest is a prefix of what was done', () => {
  const recipe = parseRecipe({
    schema: 1,
    id: 'r',
    kind: 'buildtool',
    platform: 'javascript-vite',
    engine: { min: '1.0.0' },
    sdk: { range: '*' },
    detect: [],
    ops: [
      { op: 'write-file', path: 'a.txt', template: 'a' },
      { op: 'write-file', path: 'b.txt', template: 'b' },
      { op: 'write-file', path: 'c.txt', template: 'c' },
    ],
  });
  const recorderCtx = (): {
    ctx: ReturnType<typeof makeCtx>;
    rec: ReturnType<typeof createManifestRecorder>;
  } => {
    const rec = createManifestRecorder(dir, META, { ignoreInGit: false });
    return { ctx: makeCtx(dir, { manifest: rec }), rec };
  };

  it('flushes after every applied step: a kill mid-run leaves exactly the steps applied so far', async () => {
    const { ctx, rec } = recorderCtx();
    const seen: string[][] = [];
    // "kill": the process dies while step 3 is being recorded (the hook never returns)
    const never = new Promise<void>(() => undefined);
    let n = 0;
    void executeRecipe(recipe, ctx, {
      onStepApplied: async () => {
        await rec.flush();
        seen.push((await loadManifest(dir))?.entries.map((e) => e.file) ?? []);
        if (++n === 2) await never;
      },
    });
    while (n < 2) await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual([['a.txt'], ['a.txt', 'b.txt']]);
    expect(await exists(join(dir, 'c.txt'))).toBe(false);
    // the killed run's leftovers: a re-run records nothing twice, uninstall reverts them
    const rec2 = createManifestRecorder(dir, META, { ignoreInGit: false });
    const second = await executeRecipe(recipe, makeCtx(dir, { manifest: rec2 }), {
      onStepApplied: async () => void (await rec2.flush()),
    });
    expect(second.results.map((r) => r.outcome)).toEqual(['skipped', 'skipped', 'applied']);
    expect((await loadManifest(dir))?.entries.map((e) => e.file)).toEqual([
      'a.txt',
      'b.txt',
      'c.txt',
    ]);
    const out = await rb();
    expect(out.results.map((r) => r.outcome)).toEqual(['deleted', 'deleted', 'deleted']);
    expect(await exists(join(dir, 'c.txt'))).toBe(false);
    expect(await exists(join(dir, 'a.txt'))).toBe(false);
    expect(await exists(join(dir, 'b.txt'))).toBe(false);
  });

  it('a flush that throws rolls that step back and fails the run', async () => {
    const { ctx } = recorderCtx();
    const run = await executeRecipe(recipe, ctx, {
      onStepApplied: async () => {
        throw new Error('disk full');
      },
    });
    expect(run.failed).toBe(true);
    expect(run.results[0]).toMatchObject({ id: 'write-file:a.txt', outcome: 'failed' });
    expect(run.results[0]?.error?.message).toContain('Could not record the change');
    expect(run.results[0]?.error?.message).toContain('disk full');
    expect(await exists(join(dir, 'a.txt'))).toBe(false);
  });

  it('an abort signal stops before the next step and rolls the applied ones back', async () => {
    const { ctx } = recorderCtx();
    const abort = new AbortController();
    const run = await executeRecipe(recipe, ctx, {
      signal: abort.signal,
      onStepApplied: async () => {
        abort.abort();
      },
    });
    expect(run.failed).toBe(true);
    expect(run.results.map((r) => r.outcome)).toEqual(['applied', 'failed', 'rolled-back']);
    expect(run.results[1]?.error).toBeInstanceOf(InterruptedError);
    expect(await exists(join(dir, 'a.txt'))).toBe(false);
  });

  it('dry run never calls the hook', async () => {
    const { ctx } = recorderCtx();
    let calls = 0;
    await executeRecipe(
      recipe,
      { ...ctx, dryRun: true },
      { onStepApplied: async () => void calls++ },
    );
    expect(calls).toBe(0);
  });
});

describe('recorder.discard', () => {
  it('restores the previous manifest and removes the backups it added', async () => {
    const first = createManifestRecorder(dir, META, { ignoreInGit: false });
    first.record({ file: 'f', action: 'edited', before: 'v0', after: 'v1' });
    await first.flush();
    const saved = await readFile(join(dir, '.bugsee/wizard-manifest.json'), 'utf8');
    const backups = await readdir(join(dir, '.bugsee/backup'));
    const second = createManifestRecorder(dir, META, { ignoreInGit: false });
    second.record({ file: 'g', action: 'edited', before: 'w0', after: 'w1' });
    await second.flush();
    await second.discard();
    expect(await readFile(join(dir, '.bugsee/wizard-manifest.json'), 'utf8')).toBe(saved);
    expect(await readdir(join(dir, '.bugsee/backup'))).toEqual(backups);
  });

  it('removes .bugsee entirely when there was no manifest before; no-op before any flush', async () => {
    const r = createManifestRecorder(dir, META, { ignoreInGit: false });
    await r.discard();
    r.record({ file: 'f', action: 'edited', before: 'v0', after: 'v1' });
    await r.flush();
    await r.discard();
    expect(await exists(join(dir, '.bugsee'))).toBe(false);
  });

  it('keeps unrelated files in .bugsee', async () => {
    await mkdir(join(dir, '.bugsee'));
    await writeFile(join(dir, '.bugsee/other'), 'x');
    const r = createManifestRecorder(dir, META, { ignoreInGit: false });
    r.record({ file: 'f', action: 'created', after: 'v1' });
    await r.flush();
    await r.discard();
    expect(await readdir(join(dir, '.bugsee'))).toEqual(['other']);
  });
});
