import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createManifestRecorder,
  isRecordedApplied,
  loadManifest,
  type Manifest,
  recordEntry,
  rollbackFromManifest,
} from '../../src/engine/manifest.js';
import { makeCtx, makeTmp } from './helpers.js';

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const META = { wizard: '1.2.3', recipes: [{ id: 'web', revision: 'r1' }] };
const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir, cleanup } = await makeTmp());
});
afterEach(() => cleanup());

const rb = (dryRun = false) => rollbackFromManifest({ dir, log: makeCtx(dir).log, dryRun });
const mpath = (): string => join(dir, '.bugsee', 'wizard-manifest.json');

describe('createManifestRecorder', () => {
  it('persists entries with hashes, a content-addressed backup, and gitignores .bugsee/', async () => {
    const r = createManifestRecorder(dir, META);
    r.record({ file: 'a.txt', action: 'created', after: 'new' });
    r.record({ file: 'b.txt', action: 'edited', before: 'old', after: 'new2' });
    r.record({ file: 'c.txt', action: 'manual' });
    r.record({ file: '.env', action: 'edited', marker: 'env:KEY' });
    expect(await exists(mpath())).toBe(false); // record() is only queued
    await r.flush();
    const m = JSON.parse(await readFile(mpath(), 'utf8')) as Manifest;
    expect(m.schema).toBe(1);
    expect(m.wizard).toBe('1.2.3');
    expect(m.recipes).toEqual([{ id: 'web', revision: 'r1' }]);
    expect(m.entries).toEqual([
      { file: 'a.txt', action: 'created', afterSha256: sha('new') },
      {
        file: 'b.txt',
        action: 'edited',
        beforeSha256: sha('old'),
        afterSha256: sha('new2'),
        backup: `.bugsee/backup/${sha('old')}`,
      },
      { file: 'c.txt', action: 'manual' },
      { file: '.env', action: 'edited', marker: 'env:KEY' },
    ]);
    expect(await readFile(join(dir, `.bugsee/backup/${sha('old')}`), 'utf8')).toBe('old');
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toContain('.bugsee/');
  });

  it('does not touch .gitignore when ignoreInGit is false', async () => {
    const r = createManifestRecorder(dir, META, { ignoreInGit: false });
    r.record({ file: 'a', action: 'created', after: 'x' });
    await r.flush();
    expect(await exists(join(dir, '.gitignore'))).toBe(false);
    expect(await exists(mpath())).toBe(true);
  });

  it('a later entry replaces the earlier but keeps the first before hash and backup', async () => {
    const r = createManifestRecorder(dir, META);
    r.record({ file: 'f', action: 'edited', before: 'orig', after: 'mid' });
    r.record({ file: 'f', action: 'edited', before: 'mid', after: 'last' });
    await r.flush();
    const m = await loadManifest(dir);
    expect(m?.entries).toEqual([
      {
        file: 'f',
        action: 'edited',
        beforeSha256: sha('orig'),
        afterSha256: sha('last'),
        backup: `.bugsee/backup/${sha('orig')}`,
      },
    ]);
    expect(await exists(join(dir, `.bugsee/backup/${sha('mid')}`))).toBe(false);
  });

  it('two edits to one file in the SAME batch still write the first before-state backup', async () => {
    const r = createManifestRecorder(dir, META);
    r.record({ file: 'p.json', action: 'edited', before: 'v0', after: 'v1' });
    r.record({ file: 'p.json', action: 'edited', before: 'v1', after: 'v2' });
    await r.flush();
    await writeFile(join(dir, 'p.json'), 'v2');
    expect(await readFile(join(dir, '.bugsee', 'backup', sha('v0')), 'utf8')).toBe('v0');
    const res = await rb();
    expect(res.failed).toBe(false);
    expect(res.results).toEqual([{ file: 'p.json', outcome: 'reverted' }]);
    expect(await readFile(join(dir, 'p.json'), 'utf8')).toBe('v0');
  });

  it('merges across flushes and keeps the original state through a second recorder', async () => {
    const r1 = createManifestRecorder(dir, META);
    r1.record({ file: 'f', action: 'edited', before: 'orig', after: 'mid' });
    r1.record({ file: 'g', action: 'created', after: 'g1' });
    await r1.flush();
    const r2 = createManifestRecorder(dir, {
      wizard: '2.0.0',
      recipes: [
        { id: 'web', revision: 'r2' },
        { id: 'x', revision: 'r' },
      ],
    });
    r2.record({ file: 'f', action: 'edited', before: 'mid', after: 'last' });
    await r2.flush();
    const m = await loadManifest(dir);
    expect(m?.wizard).toBe('2.0.0');
    expect(m?.recipes).toEqual([
      { id: 'web', revision: 'r2' },
      { id: 'x', revision: 'r' },
    ]);
    expect(m?.entries.map((e) => e.file)).toEqual(['f', 'g']);
    expect(m?.entries[0]?.beforeSha256).toBe(sha('orig'));
    expect(m?.entries[0]?.afterSha256).toBe(sha('last'));
  });

  it('a file created then edited stays created', async () => {
    const r = createManifestRecorder(dir, META);
    r.record({ file: 'n', action: 'created', after: 'one' });
    r.record({ file: 'n', action: 'edited', before: 'one', after: 'two' });
    await r.flush();
    const e = (await loadManifest(dir))?.entries[0];
    expect(e).toEqual({
      file: 'n',
      action: 'created',
      afterSha256: sha('two'),
    });
  });

  it('keeps separate entries per env marker and does not let manual clobber a real edit', async () => {
    const r = createManifestRecorder(dir, META);
    r.record({ file: '.env', action: 'created', marker: 'env:A' });
    r.record({ file: '.env', action: 'edited', marker: 'env:B' });
    r.record({ file: 'p', action: 'edited', before: 'a', after: 'b' });
    r.record({ file: 'p', action: 'manual' });
    r.record({ file: 'q', action: 'manual' });
    r.record({ file: 'q', action: 'created', after: 'z' });
    await r.flush();
    const m = await loadManifest(dir);
    expect(m?.entries.map((e) => `${e.file}|${e.action}|${e.marker ?? ''}`)).toEqual([
      '.env|created|env:A',
      '.env|edited|env:B',
      'p|edited|',
      'q|created|',
    ]);
  });

  it('normalises cwd-relative paths to the manifest dir', async () => {
    const pkg = join(dir, 'packages', 'web');
    await mkdir(pkg, { recursive: true });
    const r = createManifestRecorder(pkg, META, { cwd: dir });
    r.record({ file: 'packages/web/src/a.ts', action: 'created', after: 'x' });
    r.record({
      file: 'package-lock.json',
      action: 'edited',
      before: 'p',
      after: 'q',
    });
    await r.flush();
    const m = await loadManifest(pkg);
    expect(m?.entries.map((e) => e.file)).toEqual(['src/a.ts', '../../package-lock.json']);
  });
});

describe('loadManifest', () => {
  it('returns null when missing', async () => {
    expect(await loadManifest(dir)).toBeNull();
  });

  it.each([
    ['not json', '{nope'],
    ['wrong schema', JSON.stringify({ schema: 2, wizard: 'x', recipes: [], entries: [] })],
    ['entries not array', JSON.stringify({ schema: 1, wizard: 'x', recipes: [], entries: {} })],
    [
      'bad action',
      JSON.stringify({
        schema: 1,
        wizard: 'x',
        recipes: [],
        entries: [{ file: 'a', action: 'zap' }],
      }),
    ],
    [
      'absolute file',
      JSON.stringify({
        schema: 1,
        wizard: 'x',
        recipes: [],
        entries: [{ file: '/etc/passwd', action: 'created' }],
      }),
    ],
    [
      'bad recipe',
      JSON.stringify({
        schema: 1,
        wizard: 'x',
        recipes: [{ id: 1 }],
        entries: [],
      }),
    ],
    [
      'backup outside',
      JSON.stringify({
        schema: 1,
        wizard: 'x',
        recipes: [],
        entries: [{ file: 'a', action: 'edited', backup: '../x' }],
      }),
    ],
    ['null', 'null'],
    [
      'non-string sha',
      JSON.stringify({
        schema: 1,
        wizard: 'x',
        recipes: [],
        entries: [{ file: 'a', action: 'created', afterSha256: 5 }],
      }),
    ],
  ])('returns null for malformed: %s', async (_n, body) => {
    await mkdir(join(dir, '.bugsee'));
    await writeFile(mpath(), body);
    expect(await loadManifest(dir)).toBeNull();
  });

  it('loads a valid manifest', async () => {
    await recordEntry(dir, { file: 'a', action: 'created', after: 'x' });
    const m = await loadManifest(dir);
    expect(m?.entries).toEqual([{ file: 'a', action: 'created', afterSha256: sha('x') }]);
    expect(m?.schema).toBe(1);
  });
});

describe('isRecordedApplied', () => {
  const m: Manifest = {
    schema: 1,
    wizard: 'w',
    recipes: [],
    entries: [
      { file: 'a', action: 'edited' },
      { file: '.env', action: 'edited', marker: 'env:K' },
      { file: 'm', action: 'manual' },
    ],
  };
  it('matches file and optional marker, ignoring manual and null', () => {
    expect(isRecordedApplied(m, 'a')).toBe(true);
    expect(isRecordedApplied(m, 'b')).toBe(false);
    expect(isRecordedApplied(m, '.env', 'env:K')).toBe(true);
    expect(isRecordedApplied(m, '.env', 'env:Z')).toBe(false);
    expect(isRecordedApplied(m, 'a', 'env:K')).toBe(false);
    expect(isRecordedApplied(m, 'm')).toBe(false);
    expect(isRecordedApplied(null, 'a')).toBe(false);
  });
});

describe('rollbackFromManifest', () => {
  it('returns empty result without a manifest', async () => {
    expect(await rb()).toEqual({ results: [], failed: false });
  });

  it('deletes created and reverts edited files whose hash matches, then removes the manifest', async () => {
    await writeFile(join(dir, 'a.txt'), 'new');
    await writeFile(join(dir, 'b.txt'), 'new2');
    const r = createManifestRecorder(dir, META);
    r.record({ file: 'a.txt', action: 'created', after: 'new' });
    r.record({ file: 'b.txt', action: 'edited', before: 'old', after: 'new2' });
    await r.flush();
    const out = await rb();
    expect(out.failed).toBe(false);
    expect(out.results).toEqual([
      { file: 'a.txt', outcome: 'deleted' },
      { file: 'b.txt', outcome: 'reverted' },
    ]);
    expect(await exists(join(dir, 'a.txt'))).toBe(false);
    expect(await readFile(join(dir, 'b.txt'), 'utf8')).toBe('old');
    expect(await exists(join(dir, '.bugsee'))).toBe(false);
  });

  it('respects user edits: reports manual, touches nothing, keeps the manifest', async () => {
    await writeFile(join(dir, 'a.txt'), 'user changed');
    await writeFile(join(dir, 'b.txt'), 'user changed too');
    const r = createManifestRecorder(dir, META);
    r.record({ file: 'a.txt', action: 'created', after: 'new' });
    r.record({ file: 'b.txt', action: 'edited', before: 'old', after: 'new2' });
    await r.flush();
    const out = await rb();
    expect(out.failed).toBe(false);
    expect(out.results.map((x) => x.outcome)).toEqual(['manual', 'manual']);
    expect(out.results.every((x) => typeof x.note === 'string' && x.note.length > 0)).toBe(true);
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('user changed');
    expect(await readFile(join(dir, 'b.txt'), 'utf8')).toBe('user changed too');
    expect(await exists(mpath())).toBe(true);
  });

  it('reports missing files and manual entries', async () => {
    const r = createManifestRecorder(dir, META);
    r.record({ file: 'gone.txt', action: 'created', after: 'x' });
    r.record({ file: 'gone2.txt', action: 'edited', before: 'a', after: 'b' });
    r.record({ file: 'todo.txt', action: 'manual' });
    await r.flush();
    const out = await rb();
    expect(out.results.map((x) => x.outcome)).toEqual(['missing', 'missing', 'manual']);
    expect(out.failed).toBe(false);
    expect(await exists(mpath())).toBe(false); // nothing left for the user to resolve
  });

  it('edited entry without a backup is reported manual', async () => {
    await writeFile(join(dir, 'p'), 'b');
    const r = createManifestRecorder(dir, META);
    r.record({ file: 'p', action: 'edited', after: 'b' });
    await r.flush();
    const out = await rb();
    expect(out.results[0]?.outcome).toBe('manual');
    expect(await readFile(join(dir, 'p'), 'utf8')).toBe('b');
  });

  it('created entry without an after hash is reported manual, not deleted', async () => {
    await writeFile(join(dir, 'p'), 'b');
    await recordEntry(dir, { file: 'p', action: 'created' });
    const out = await rb();
    expect(out.results[0]?.outcome).toBe('manual');
    expect(await exists(join(dir, 'p'))).toBe(true);
  });

  it('removes only the marked env key and deletes a created env file that becomes empty', async () => {
    await writeFile(join(dir, '.env'), 'OTHER=1\nBUGSEE_APP_TOKEN=abc\nLAST=2\n');
    await writeFile(join(dir, '.env.local'), 'BUGSEE_APP_TOKEN=abc\n');
    const r = createManifestRecorder(dir, META);
    r.record({
      file: '.env',
      action: 'edited',
      marker: 'env:BUGSEE_APP_TOKEN',
    });
    r.record({
      file: '.env.local',
      action: 'created',
      marker: 'env:BUGSEE_APP_TOKEN',
    });
    await r.flush();
    const out = await rb();
    expect(out.results.map((x) => x.outcome)).toEqual(['reverted', 'deleted']);
    expect(await readFile(join(dir, '.env'), 'utf8')).toBe('OTHER=1\nLAST=2\n');
    expect(await exists(join(dir, '.env.local'))).toBe(false);
  });

  it('keeps an edited-or-created env file that still has other content; user-removed key is skipped', async () => {
    await writeFile(join(dir, '.env'), 'OTHER=1\nBUGSEE_APP_TOKEN=abc\n');
    await writeFile(join(dir, '.env.b'), 'OTHER=1\n');
    const r = createManifestRecorder(dir, META);
    r.record({
      file: '.env',
      action: 'created',
      marker: 'env:BUGSEE_APP_TOKEN',
    });
    r.record({
      file: '.env.b',
      action: 'edited',
      marker: 'env:BUGSEE_APP_TOKEN',
    });
    await r.flush();
    const out = await rb();
    expect(out.results.map((x) => x.outcome)).toEqual(['reverted', 'skipped']);
    expect(await readFile(join(dir, '.env'), 'utf8')).toBe('OTHER=1\n');
    expect(await readFile(join(dir, '.env.b'), 'utf8')).toBe('OTHER=1\n');
  });

  it('dry-run reports outcomes but changes nothing', async () => {
    await writeFile(join(dir, 'a.txt'), 'new');
    await writeFile(join(dir, 'b.txt'), 'new2');
    await writeFile(join(dir, '.env'), 'K=1\nOTHER=2\n');
    const r = createManifestRecorder(dir, META);
    r.record({ file: 'a.txt', action: 'created', after: 'new' });
    r.record({ file: 'b.txt', action: 'edited', before: 'old', after: 'new2' });
    r.record({ file: '.env', action: 'edited', marker: 'env:K' });
    await writeFile(join(dir, '.env.new'), 'K=1\n');
    r.record({ file: '.env.new', action: 'created', marker: 'env:K' });
    await r.flush();
    const out = await rb(true);
    expect(out.results.map((x) => x.outcome)).toEqual([
      'deleted',
      'reverted',
      'reverted',
      'deleted',
    ]);
    expect(await readFile(join(dir, '.env.new'), 'utf8')).toBe('K=1\n');
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('new');
    expect(await readFile(join(dir, 'b.txt'), 'utf8')).toBe('new2');
    expect(await readFile(join(dir, '.env'), 'utf8')).toBe('K=1\nOTHER=2\n');
    expect(await exists(mpath())).toBe(true);
  });

  it('collects an unexpected I/O error per entry, sets failed, and keeps the manifest', async () => {
    await mkdir(join(dir, 'isdir'));
    await writeFile(join(dir, 'ok.txt'), 'x');
    const r = createManifestRecorder(dir, META);
    r.record({ file: 'isdir', action: 'created', after: 'x' }); // reading a directory throws EISDIR
    r.record({ file: 'ok.txt', action: 'created', after: 'x' });
    await r.flush();
    const out = await rb();
    expect(out.failed).toBe(true);
    expect(out.results[0]?.file).toBe('isdir');
    expect(out.results[0]?.outcome).toBe('skipped');
    expect(out.results[0]?.note).toMatch(/EISDIR|directory/i);
    expect(out.results[1]?.outcome).toBe('deleted');
    expect(await exists(mpath())).toBe(true);
  });

  it('refuses a backup whose content no longer matches its hash', async () => {
    await writeFile(join(dir, 'b.txt'), 'new2');
    const r = createManifestRecorder(dir, META);
    r.record({ file: 'b.txt', action: 'edited', before: 'old', after: 'new2' });
    await r.flush();
    await writeFile(join(dir, `.bugsee/backup/${sha('old')}`), 'tampered');
    const out = await rb();
    expect(out.results[0]?.outcome).toBe('manual');
    expect(await readFile(join(dir, 'b.txt'), 'utf8')).toBe('new2');
  });

  it('leaves .bugsee in place when it holds other files, removing only manifest and backups', async () => {
    await writeFile(join(dir, 'a.txt'), 'n');
    await recordEntry(dir, { file: 'a.txt', action: 'created', after: 'n' });
    await writeFile(join(dir, '.bugsee', 'other.json'), '{}');
    await rb();
    expect(await readdir(join(dir, '.bugsee'))).toEqual(['other.json']);
  });

  it('resolves monorepo-root files outside the manifest dir', async () => {
    const pkg = join(dir, 'pkg');
    await mkdir(pkg);
    await mkdir(join(dir, '.git'));
    await writeFile(join(dir, 'lock.json'), 'newlock');
    const r = createManifestRecorder(pkg, META, { cwd: pkg });
    r.record({
      file: '../lock.json',
      action: 'edited',
      before: 'oldlock',
      after: 'newlock',
    });
    await r.flush();
    const out = await rollbackFromManifest({
      dir: pkg,
      log: makeCtx(pkg).log,
      dryRun: false,
    });
    expect(out.results[0]?.outcome).toBe('reverted');
    expect(await readFile(join(dir, 'lock.json'), 'utf8')).toBe('oldlock');
  });
});

const H = (c: string): string => sha(c);
const hand = async (entries: unknown[]): Promise<void> => {
  await mkdir(join(dir, '.bugsee', 'backup'), { recursive: true });
  await writeFile(mpath(), JSON.stringify({ schema: 1, wizard: 'x', recipes: [], entries }));
};

describe('containment (crafted manifests)', () => {
  const base = (over: Record<string, unknown>) => ({ file: 'a', action: 'created', ...over });
  it.each([
    [
      'backup not a hash name',
      { action: 'edited', beforeSha256: H('m'), backup: '.bugsee/backup/anything' },
    ],
    [
      'backup does not match beforeSha256',
      { action: 'edited', beforeSha256: H('m'), backup: `.bugsee/backup/${H('n')}` },
    ],
    ['backup without before hash', { action: 'edited', backup: `.bugsee/backup/${H('m')}` }],
    [
      'uppercase hash',
      {
        action: 'edited',
        beforeSha256: H('m').toUpperCase(),
        backup: `.bugsee/backup/${H('m').toUpperCase()}`,
      },
    ],
    [
      'backup with dotdot',
      { action: 'edited', beforeSha256: H('m'), backup: `.bugsee/backup/../${H('m')}` },
    ],
    [
      'backup with backslash',
      { action: 'edited', beforeSha256: H('m'), backup: `.bugsee\\backup\\${H('m')}` },
    ],
    ['file with NUL', { file: 'a\0b' }],
    ['file with backslash', { file: '..\\x' }],
  ])('loadManifest rejects: %s', async (_n, over) => {
    await hand([base(over)]);
    expect(await loadManifest(dir)).toBeNull();
  });

  it('the package.json/backup overwrite attack is rejected at load; nothing is touched', async () => {
    await writeFile(join(dir, 'package.json'), '{"name":"real"}');
    await hand([
      {
        file: 'package.json',
        action: 'edited',
        afterSha256: H('{"name":"real"}'),
        beforeSha256: H('evil'),
        backup: '.bugsee/backup/anything',
      },
    ]);
    await writeFile(join(dir, '.bugsee/backup/anything'), 'evil');
    expect(await rb()).toEqual({ results: [], failed: false });
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe('{"name":"real"}');
  });

  describe('root containment', () => {
    let proj: string;
    beforeEach(async () => {
      proj = join(dir, 'proj');
      await mkdir(join(proj, '.git'), { recursive: true });
    });
    const rbp = () => rollbackFromManifest({ dir: proj, log: makeCtx(proj).log, dryRun: false });
    const handp = async (entries: unknown[]): Promise<void> => {
      await mkdir(join(proj, '.bugsee'), { recursive: true });
      await writeFile(
        join(proj, '.bugsee', 'wizard-manifest.json'),
        JSON.stringify({ schema: 1, wizard: 'x', recipes: [], entries }),
      );
    };

    it('an env entry aimed outside the root is manual and strips nothing', async () => {
      await writeFile(join(dir, '.bashrc'), 'PATH=/x\nA=1\n');
      await handp([{ file: '../.bashrc', action: 'edited', marker: 'env:PATH' }]);
      const out = await rbp();
      expect(out.results[0]?.outcome).toBe('manual');
      expect(out.results[0]?.note).toBeTruthy();
      expect(await readFile(join(dir, '.bashrc'), 'utf8')).toBe('PATH=/x\nA=1\n');
    });

    it('a created entry escaping the root with a matching hash is not deleted', async () => {
      await writeFile(join(dir, 'victim'), 'known');
      await handp([{ file: '../victim', action: 'created', afterSha256: H('known') }]);
      const out = await rbp();
      expect(out.results[0]?.outcome).toBe('manual');
      expect(await readFile(join(dir, 'victim'), 'utf8')).toBe('known');
    });

    it('an edited entry escaping the root is not restored', async () => {
      await writeFile(join(dir, 'victim'), 'cur');
      await mkdir(join(proj, '.bugsee', 'backup'), { recursive: true });
      await writeFile(join(proj, '.bugsee', 'backup', H('evil')), 'evil');
      await handp([
        {
          file: '../victim',
          action: 'edited',
          afterSha256: H('cur'),
          beforeSha256: H('evil'),
          backup: `.bugsee/backup/${H('evil')}`,
        },
      ]);
      const out = await rbp();
      expect(out.results[0]?.outcome).toBe('manual');
      expect(await readFile(join(dir, 'victim'), 'utf8')).toBe('cur');
    });

    it('env rollback only applies to .env* files and valid keys', async () => {
      await writeFile(join(proj, 'package.json'), 'PATH=1\n');
      await writeFile(join(proj, '.env'), 'A B=1\nK=1\n');
      await handp([
        { file: 'package.json', action: 'edited', marker: 'env:PATH' },
        { file: '.env', action: 'edited', marker: 'env:A B' },
      ]);
      const out = await rbp();
      expect(out.results.map((r) => r.outcome)).toEqual(['manual', 'manual']);
      expect(await readFile(join(proj, 'package.json'), 'utf8')).toBe('PATH=1\n');
      expect(await readFile(join(proj, '.env'), 'utf8')).toBe('A B=1\nK=1\n');
    });

    it.skipIf(process.platform === 'win32')(
      'a symlink pointing outside the root is not followed',
      async () => {
        await writeFile(join(dir, 'secret'), 'known');
        await symlink(join(dir, 'secret'), join(proj, 'link'));
        await mkdir(join(dir, 'outdir'));
        await writeFile(join(dir, 'outdir', 'f'), 'known');
        await symlink(join(dir, 'outdir'), join(proj, 'dlink'));
        await handp([
          { file: 'link', action: 'created', afterSha256: H('known') },
          { file: 'dlink/f', action: 'created', afterSha256: H('known') },
        ]);
        const out = await rbp();
        expect(out.results.map((r) => r.outcome)).toEqual(['manual', 'manual']);
        expect(await readFile(join(dir, 'secret'), 'utf8')).toBe('known');
        expect(await readFile(join(dir, 'outdir', 'f'), 'utf8')).toBe('known');
      },
    );

    it.skipIf(process.platform === 'win32')(
      'a backup dir symlinked outside the root is not read',
      async () => {
        await mkdir(join(dir, 'outbk'));
        await writeFile(join(dir, 'outbk', H('evil')), 'evil');
        await mkdir(join(proj, '.bugsee'), { recursive: true });
        await symlink(join(dir, 'outbk'), join(proj, '.bugsee', 'backup'));
        await writeFile(join(proj, 'f.txt'), 'cur');
        await handp([
          {
            file: 'f.txt',
            action: 'edited',
            afterSha256: H('cur'),
            beforeSha256: H('evil'),
            backup: `.bugsee/backup/${H('evil')}`,
          },
        ]);
        const out = await rbp();
        expect(out.results[0]?.outcome).toBe('manual');
        expect(await readFile(join(proj, 'f.txt'), 'utf8')).toBe('cur');
      },
    );

    it('a workspace root above the package dir is the allowed root', async () => {
      await rm(join(proj, '.git'), { recursive: true });
      await writeFile(join(proj, 'package.json'), JSON.stringify({ workspaces: ['pkg'] }));
      const pkg = join(proj, 'pkg');
      await mkdir(pkg);
      await writeFile(join(proj, 'lock.json'), 'new');
      await mkdir(join(pkg, '.bugsee', 'backup'), { recursive: true });
      await writeFile(join(pkg, '.bugsee', 'backup', H('old')), 'old');
      await writeFile(
        join(pkg, '.bugsee', 'wizard-manifest.json'),
        JSON.stringify({
          schema: 1,
          wizard: 'x',
          recipes: [],
          entries: [
            {
              file: '../lock.json',
              action: 'edited',
              beforeSha256: H('old'),
              afterSha256: H('new'),
              backup: `.bugsee/backup/${H('old')}`,
            },
          ],
        }),
      );
      const out = await rollbackFromManifest({ dir: pkg, log: makeCtx(pkg).log, dryRun: false });
      expect(out.results[0]?.outcome).toBe('reverted');
      expect(await readFile(join(proj, 'lock.json'), 'utf8')).toBe('old');
    });
  });
});

describe('idempotent partial rollback', () => {
  it('re-running after a partial rollback converges and cleans up', async () => {
    await writeFile(join(dir, 'a.txt'), 'a-new');
    await writeFile(join(dir, 'b.txt'), 'b-new');
    await writeFile(join(dir, 'c.txt'), 'c-new');
    const r = createManifestRecorder(dir, META);
    r.record({ file: 'a.txt', action: 'edited', before: 'a-old', after: 'a-new' });
    r.record({ file: 'b.txt', action: 'edited', before: 'b-old', after: 'b-new' });
    r.record({ file: 'c.txt', action: 'created', after: 'c-new' });
    r.record({ file: 'm.txt', action: 'manual' });
    await r.flush();
    await writeFile(join(dir, 'b.txt'), 'user edit');
    const one = await rb();
    expect(one.results.map((x) => x.outcome)).toEqual(['reverted', 'manual', 'deleted', 'manual']);
    expect(await exists(mpath())).toBe(true);
    // resolved entries are pruned from the kept manifest
    expect((await loadManifest(dir))?.entries.map((e) => e.file)).toEqual(['b.txt', 'm.txt']);
    expect(await readdir(join(dir, '.bugsee', 'backup'))).toEqual([H('b-old')]);
    const two = await rb();
    expect(two.results.map((x) => x.file)).toEqual(['b.txt', 'm.txt']);
    expect(two.results[0]?.outcome).toBe('manual');
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('a-old');
    await writeFile(join(dir, 'b.txt'), 'b-new'); // the user puts it back
    const three = await rb();
    expect(three.results.map((x) => x.outcome)).toEqual(['reverted', 'manual']);
    expect(await readFile(join(dir, 'b.txt'), 'utf8')).toBe('b-old');
    expect(await exists(join(dir, '.bugsee'))).toBe(false);
  });

  it('an edited file already back at its pre-wizard content counts as reverted', async () => {
    await writeFile(join(dir, 'a.txt'), 'a-old');
    await recordEntry(dir, { file: 'a.txt', action: 'edited', before: 'a-old', after: 'a-new' });
    const out = await rb();
    expect(out.results[0]?.outcome).toBe('reverted');
    expect(await exists(join(dir, '.bugsee'))).toBe(false);
  });

  it('a dry run prunes nothing', async () => {
    await writeFile(join(dir, 'a.txt'), 'a-new');
    await writeFile(join(dir, 'b.txt'), 'user');
    const r = createManifestRecorder(dir, META);
    r.record({ file: 'a.txt', action: 'created', after: 'a-new' });
    r.record({ file: 'b.txt', action: 'created', after: 'b-new' });
    await r.flush();
    await rb(true);
    expect((await loadManifest(dir))?.entries).toHaveLength(2);
  });
});

describe('flush safety', () => {
  it('quarantines an invalid existing manifest instead of overwriting it', async () => {
    await mkdir(join(dir, '.bugsee'));
    const bad = JSON.stringify({ schema: 2, wizard: 'future', recipes: [], entries: [] });
    await writeFile(mpath(), bad);
    const r = createManifestRecorder(dir, META);
    r.record({ file: 'a', action: 'created', after: 'x' });
    const res = await r.flush();
    expect(res.quarantined).toMatch(/wizard-manifest\.json\.bad-/);
    expect(await readFile(join(dir, res.quarantined ?? ''), 'utf8')).toBe(bad);
    expect((await loadManifest(dir))?.entries).toHaveLength(1);
    await writeFile(mpath(), '{trunc');
    const r2 = createManifestRecorder(dir, META);
    r2.record({ file: 'b', action: 'created', after: 'x' });
    const res2 = await r2.flush();
    expect(res2.quarantined).not.toBe(res.quarantined);
    expect(await readFile(join(dir, res.quarantined ?? ''), 'utf8')).toBe(bad);
  });

  it('reports no quarantine when the manifest is fine or missing', async () => {
    const r = createManifestRecorder(dir, META);
    r.record({ file: 'a', action: 'created', after: 'x' });
    expect((await r.flush()).quarantined).toBeUndefined();
    r.record({ file: 'b', action: 'created', after: 'x' });
    expect((await r.flush()).quarantined).toBeUndefined();
  });

  it('writes the manifest atomically (no temp files left, first write included)', async () => {
    await recordEntry(dir, { file: 'a', action: 'created', after: 'x' });
    expect(await readdir(join(dir, '.bugsee'))).toEqual(['wizard-manifest.json']);
  });

  it('does not duplicate the .gitignore line across flushes', async () => {
    const r = createManifestRecorder(dir, META);
    r.record({ file: 'a', action: 'created', after: 'x' });
    await r.flush();
    r.record({ file: 'b', action: 'created', after: 'x' });
    await r.flush();
    const lines = (await readFile(join(dir, '.gitignore'), 'utf8'))
      .split('\n')
      .filter((l) => l === '.bugsee/');
    expect(lines).toHaveLength(1);
  });
});
