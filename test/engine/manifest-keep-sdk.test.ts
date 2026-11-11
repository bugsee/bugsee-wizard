import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createManifestRecorder,
  loadManifest,
  rollbackFromManifest,
} from '../../src/engine/manifest.js';
import { addSdkInit } from '../../src/engine/sdk-init-ast.js';
import { makeCtx, makeTmp } from './helpers.js';

let tmp: Awaited<ReturnType<typeof makeTmp>>;
beforeEach(async () => {
  tmp = await makeTmp();
});
afterEach(() => tmp.cleanup());

const p = (rel: string): string => join(tmp.dir, rel);
const PKG_BEFORE = `${JSON.stringify({ name: 'a', dependencies: { express: '4' } }, null, 2)}\n`;
const PKG_AFTER = `${JSON.stringify(
  {
    name: 'a',
    dependencies: { express: '4', '@bugsee/bugsee': '^0.1.0-beta.6' },
    devDependencies: { '@bugsee/vite-plugin': '^0.1.0-beta.6' },
  },
  null,
  2,
)}\n`;
const LOCK_BEFORE = '{"lock":1}\n';
const LOCK_AFTER = '{"lock":2,"bugsee":true}\n';
const ENTRY = "import express from 'express'; start();\n";

/** A project the wizard changed: package.json + lockfile (install), then the entry (init). */
async function wizardRun(): Promise<string> {
  await writeFile(p('package.json'), PKG_AFTER);
  await writeFile(p('package-lock.json'), LOCK_AFTER);
  const res = addSdkInit(ENTRY, {
    importFrom: '@bugsee/bugsee',
    token: 't',
    fileName: 'server.js',
    packageType: 'module',
    runtime: 'node',
    tokenExpr: 'process.env.BUGSEE_APP_TOKEN',
  });
  if (!('code' in res)) throw new Error('no code');
  await writeFile(p('server.js'), res.code);
  const rec = createManifestRecorder(tmp.dir, { wizard: 't', recipes: [] }, { cwd: tmp.dir });
  rec.record({ file: 'package.json', action: 'edited', before: PKG_BEFORE, after: PKG_AFTER });
  rec.record({
    file: 'package-lock.json',
    action: 'edited',
    before: LOCK_BEFORE,
    after: LOCK_AFTER,
  });
  rec.record({
    file: 'server.js',
    action: 'edited',
    before: ENTRY,
    after: res.code,
    marker: 'bugsee-wizard',
  });
  await rec.flush();
  return res.code;
}
const roll = (dryRun = false) =>
  rollbackFromManifest({ dir: tmp.dir, log: makeCtx(tmp.dir).log, dryRun });

describe('uninstall when the init cannot be taken out', () => {
  it('an untouched project is restored completely (the normal case)', async () => {
    await mkdir(tmp.dir, { recursive: true });
    await writeFile(p('package.json'), PKG_BEFORE);
    await wizardRun();
    const res = await roll();
    expect(res.failed).toBe(false);
    expect(await readFile(p('server.js'), 'utf8')).toBe(ENTRY);
    expect(await readFile(p('package.json'), 'utf8')).toBe(PKG_BEFORE);
    expect(await readFile(p('package-lock.json'), 'utf8')).toBe(LOCK_BEFORE);
  });

  it('a user edit on the split line: the hand fix never tells them to put the original line back', async () => {
    await wizardRun();
    await writeFile(
      p('server.js'),
      (await readFile(p('server.js'), 'utf8')).replace('start();', 'start(8080);'),
    );
    const res = await roll();
    const entry = res.results.find((r) => r.file === 'server.js');
    expect(entry?.outcome).toBe('manual');
    expect(entry?.note).toMatch(/remove/);
    expect(entry?.note).not.toMatch(/replace/);
    expect(entry?.note).not.toContain(ENTRY.trim());
    // nothing of the user's line was touched
    expect(await readFile(p('server.js'), 'utf8')).toContain('start(8080);');
  });

  it('the SDK dependency stays while its import stays; everything else of the install is taken out', async () => {
    await wizardRun();
    await writeFile(
      p('server.js'),
      (await readFile(p('server.js'), 'utf8')).replace('start();', 'start(8080);'),
    );
    const res = await roll();
    const pkg = JSON.parse(await readFile(p('package.json'), 'utf8'));
    expect(pkg.dependencies['@bugsee/bugsee']).toBeDefined();
    expect(pkg.devDependencies).toBeUndefined();
    expect(pkg.dependencies.express).toBe('4');
    const row = res.results.find((r) => r.file === 'package.json');
    expect(row?.note).toMatch(/kept.*@bugsee\/bugsee/);
    // the lockfile still describes the kept dependency: it is left alone
    expect(await readFile(p('package-lock.json'), 'utf8')).toBe(LOCK_AFTER);
    expect(res.results.find((r) => r.file === 'package-lock.json')?.outcome).toBe('manual');
  });

  it('the manifest keeps what is left, so a later uninstall finishes the job once the line is fixed', async () => {
    await wizardRun();
    await writeFile(
      p('server.js'),
      (await readFile(p('server.js'), 'utf8')).replace('start();', 'start(8080);'),
    );
    await roll();
    const left = await loadManifest(tmp.dir);
    expect(left?.entries.map((e) => e.file).sort()).toEqual([
      'package-lock.json',
      'package.json',
      'server.js',
    ]);
  });

  it('a dry run reports the same without touching anything', async () => {
    await wizardRun();
    await writeFile(
      p('server.js'),
      (await readFile(p('server.js'), 'utf8')).replace('start();', 'start(8080);'),
    );
    const before = await readFile(p('package.json'), 'utf8');
    const res = await roll(true);
    expect(await readFile(p('package.json'), 'utf8')).toBe(before);
    expect(res.results.find((r) => r.file === 'package.json')?.note).toMatch(/kept/);
  });
});
