import { spawnSync } from 'node:child_process';
import { access, cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SNAPSHOT = join(ROOT, 'snapshot');
const VALIDATE = join(ROOT, 'scripts', 'validate-snapshot.mjs');
const BUILD = join(ROOT, 'scripts', 'build-snapshot.mjs');

function run(script: string, dir: string): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [script, dir], { encoding: 'utf8', shell: false });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const recipe = (platform: string, over: Record<string, unknown> = {}) => ({
  schema: 1,
  id: platform,
  kind: 'buildtool',
  platform,
  engine: { min: '0.0.0' },
  sdk: { range: '>=0.1.0-beta.5' },
  detect: [],
  ops: [{ op: 'ensure-gitignore', line: '.env.x' }],
  ...over,
});

describe('snapshot tools', () => {
  let tmp: string;
  let snap: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'bugsee-snap-'));
    snap = join(tmp, 'snapshot');
    await cp(SNAPSHOT, snap, { recursive: true });
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  describe('validate-snapshot.mjs', () => {
    it('accepts the committed snapshot', () => {
      const r = run(VALIDATE, SNAPSHOT);
      expect(r.out).toMatch(/snapshot OK/);
      expect(r.status).toBe(0);
    });

    it('defaults to the repository snapshot when no directory is given', async () => {
      const r = spawnSync(process.execPath, [VALIDATE], { encoding: 'utf8', cwd: tmp });
      expect(r.status).toBe(0);
      const n = (await readdir(SNAPSHOT, { withFileTypes: true })).filter((e) =>
        e.isDirectory(),
      ).length;
      expect(r.stdout).toContain(`snapshot OK: ${n} recipe(s) in ${n} platform(s)`);
    });

    it('fails on a recipe whose bytes no longer match the index sha256', async () => {
      const file = join(snap, 'javascript-vite', 'r1.json');
      await writeFile(file, `${await readFile(file, 'utf8')} `);
      const r = run(VALIDATE, snap);
      expect(r.status).toBe(1);
      expect(r.out).toMatch(/javascript-vite.*sha256/);
    });

    it('fails on a recipe the real parser rejects', async () => {
      await writeFile(
        join(snap, 'javascript-vite', 'r1.json'),
        JSON.stringify(recipe('javascript-vite', { ops: [{ op: 'rm-rf' }] })),
      );
      const r = run(VALIDATE, snap);
      expect(r.status).toBe(1);
      expect(r.out).toMatch(/javascript-vite.*unknown operation/);
    });

    it.each([
      ['id', { id: 'javascript-other' }, /id "javascript-other" is not "javascript-vite"/],
      [
        'platform',
        { platform: 'javascript-other' },
        /platform "javascript-other" is not "javascript-vite"/,
      ],
    ])('fails when the recipe %s disagrees with its directory', async (_, over, re) => {
      await writeFile(
        join(snap, 'javascript-vite', 'r1.json'),
        JSON.stringify(recipe('javascript-vite', over)),
      );
      await rebuild();
      const r = run(VALIDATE, snap);
      expect(r.status).toBe(1);
      expect(r.out).toMatch(re);
    });

    it('fails when the index range or engineMin disagrees with the recipe', async () => {
      const path = join(snap, 'javascript-vite', 'index.json');
      const index = JSON.parse(await readFile(path, 'utf8'));
      index.entries[0].range = '>=9.0.0';
      index.entries[0].engineMin = '1.0.0';
      await writeFile(path, JSON.stringify(index));
      const r = run(VALIDATE, snap);
      expect(r.status).toBe(1);
      expect(r.out).toMatch(/range/);
      expect(r.out).toMatch(/engineMin/);
    });

    it('fails on an index url that is not a bare file name, or a missing file', async () => {
      const path = join(snap, 'javascript-vite', 'index.json');
      const index = JSON.parse(await readFile(path, 'utf8'));
      index.entries.push({ ...index.entries[0], revision: 'r2', url: '../x/r1.json' });
      index.entries.push({ ...index.entries[0], revision: 'r3', url: 'r3.json' });
      index.entries.push({ ...index.entries[0], revision: 'r1', url: 'sub/r1.json' });
      await writeFile(path, JSON.stringify(index));
      const r = run(VALIDATE, snap);
      expect(r.status).toBe(1);
      expect(r.out).toContain('url "../x/r1.json" must be a bare file name');
      expect(r.out).toContain('url "sub/r1.json" must be a bare file name');
      expect(r.out).toMatch(/r3\.json.*missing/);
    });

    describe('token files must be ignored before they are written', () => {
      const env = { op: 'write-env-var', file: '.env.x', key: 'K', from: 'token' };
      const ignore = (line: string) => ({ op: 'ensure-gitignore', line });
      const check = async (ops: unknown[]) => {
        await writeFile(
          join(snap, 'javascript-vite', 'r1.json'),
          JSON.stringify(recipe('javascript-vite', { ops })),
        );
        await rebuild();
        return run(VALIDATE, snap);
      };

      it('rejects write-env-var that comes before its ensure-gitignore', async () => {
        const r = await check([env, ignore('.env.x')]);
        expect(r.status).toBe(1);
        expect(r.out).toMatch(/javascript-vite\/r1\.json.*ops\[0\].*\.env\.x.*ensure-gitignore/);
      });

      it('rejects write-env-var with no ensure-gitignore, or one for another file', async () => {
        expect((await check([env])).status).toBe(1);
        expect((await check([ignore('.env.y'), env])).status).toBe(1);
      });

      it('accepts the ignore first, in either spelling of the path', async () => {
        expect((await check([ignore('.env.x'), env])).status).toBe(0);
        expect((await check([ignore('/.env.x'), env])).status).toBe(0);
        expect((await check([ignore('./.env.x'), env])).status).toBe(0);
      });
    });

    it('fails on a wrong index schema / platform, a file the index does not list, a stray root file', async () => {
      const path = join(snap, 'javascript-vite', 'index.json');
      const index = JSON.parse(await readFile(path, 'utf8'));
      await writeFile(path, JSON.stringify({ ...index, schema: 2, platform: 'x' }));
      await writeFile(join(snap, 'javascript-webpack', 'r9.json'), '{}');
      await writeFile(join(snap, 'stray.json'), '{}');
      const r = run(VALIDATE, snap);
      expect(r.status).toBe(1);
      expect(r.out).toContain('schema must be 1, not 2');
      expect(r.out).toContain('platform "x" is not the directory name');
      expect(r.out).toMatch(/r9\.json.*not listed/);
      expect(r.out).toMatch(/stray\.json/);
    });

    it('fails when an entry revision does not match its file name', async () => {
      const path = join(snap, 'javascript-vite', 'index.json');
      const index = JSON.parse(await readFile(path, 'utf8'));
      index.entries[0].revision = 'r7';
      await writeFile(path, JSON.stringify(index));
      const r = run(VALIDATE, snap);
      expect(r.status).toBe(1);
      expect(r.out).toContain('revision "r7" does not match the file name');
    });

    it('fails on an empty snapshot', async () => {
      const empty = join(tmp, 'empty');
      await cp(join(snap, 'javascript-vite'), join(empty, 'x'), { recursive: true });
      await rm(join(empty, 'x'), { recursive: true });
      const r = run(VALIDATE, empty);
      expect(r.status).toBe(1);
      expect(r.out).toMatch(/no recipes/);
    });
  });

  describe('build-snapshot.mjs', () => {
    it('reproduces the committed indexes byte for byte', async () => {
      const r = run(BUILD, snap);
      expect(r.status).toBe(0);
      const platforms = (await readdir(SNAPSHOT, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      expect(platforms.length).toBeGreaterThanOrEqual(7);
      for (const p of platforms) {
        expect(await readFile(join(snap, p, 'index.json'), 'utf8')).toBe(
          await readFile(join(SNAPSHOT, p, 'index.json'), 'utf8'),
        );
      }
    });

    it('derives every index field from the recipe files (hash, range, engineMin, revision)', async () => {
      const dir = join(snap, 'javascript-vite');
      const body = `${JSON.stringify(recipe('javascript-vite', { sdk: { range: '>=2.0.0' }, engine: { min: '0.0.0' } }), null, 2)}\n`;
      await writeFile(join(dir, 'r2.json'), body);
      expect(run(BUILD, snap).status).toBe(0);
      const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'));
      expect(index.schema).toBe(1);
      expect(index.platform).toBe('javascript-vite');
      expect(index.entries.map((e: { revision: string }) => e.revision)).toEqual(['r1', 'r2']);
      const { createHash } = await import('node:crypto');
      expect(index.entries[1]).toEqual({
        range: '>=2.0.0',
        revision: 'r2',
        url: 'r2.json',
        sha256: createHash('sha256').update(body).digest('hex'),
        engineMin: '0.0.0',
      });
      expect(run(VALIDATE, snap).status).toBe(0);
    });

    it('refuses to index a recipe the real parser rejects, and writes no partial index for that platform', async () => {
      await rm(join(snap, 'javascript-vite', 'index.json'));
      await writeFile(join(snap, 'javascript-vite', 'r2.json'), JSON.stringify({ schema: 1 }));
      const r = run(BUILD, snap);
      expect(r.status).toBe(1);
      expect(r.out).toContain('javascript-vite/r2.json');
      await expect(access(join(snap, 'javascript-vite', 'index.json'))).rejects.toThrow();
    });

    it('orders revisions numerically (r10 after r2)', async () => {
      const dir = join(snap, 'javascript-vite');
      for (const n of [10, 2]) {
        await writeFile(
          join(dir, `r${n}.json`),
          JSON.stringify(recipe('javascript-vite', { sdk: { range: `>=${n}.0.0` } })),
        );
      }
      expect(run(BUILD, snap).status).toBe(0);
      const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'));
      expect(index.entries.map((e: { revision: string }) => e.revision)).toEqual([
        'r1',
        'r2',
        'r10',
      ]);
    });
  });

  async function rebuild(): Promise<void> {
    expect(run(BUILD, snap).status).toBe(0);
  }
});
