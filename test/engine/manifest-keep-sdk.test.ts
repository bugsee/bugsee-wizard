import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
    marker: 'bugsee-wizard:sdk-init',
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

  it('all dependency additions stay (the lockfile cannot follow a removal), the rest of the install is taken out', async () => {
    await wizardRun();
    await writeFile(
      p('package.json'),
      (await readFile(p('package.json'), 'utf8')).replace(
        '"name": "a"',
        '"name": "a", "scripts": { "x": "y" }',
      ),
    );
    await writeFile(
      p('server.js'),
      (await readFile(p('server.js'), 'utf8')).replace('start();', 'start(8080);'),
    );
    const res = await roll();
    const pkg = JSON.parse(await readFile(p('package.json'), 'utf8'));
    expect(pkg.dependencies['@bugsee/bugsee']).toBeDefined();
    expect(pkg.devDependencies['@bugsee/vite-plugin']).toBeDefined();
    expect(pkg.dependencies.express).toBe('4');
    const row = res.results.find((r) => r.file === 'package.json');
    expect(row?.note).toMatch(/kept.*@bugsee\/bugsee.*@bugsee\/vite-plugin/);
    // the lockfile still matches package.json, and the user is told the exact command
    expect(await readFile(p('package-lock.json'), 'utf8')).toBe(LOCK_AFTER);
    const lock = res.results.find((r) => r.file === 'package-lock.json');
    expect(lock?.outcome).toBe('manual');
    expect(lock?.note).toMatch(/belongs to the dependencies that were kept/);
    expect(row?.note).toContain('npm uninstall @bugsee/bugsee @bugsee/vite-plugin');
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

  it('a bundler-plugin edit that cannot be reverted keeps the dependencies too (the config still imports the plugin)', async () => {
    await wizardRun();
    const cfg = 'export default { plugins: [] };\n';
    const cfgAfter =
      "import { p } from '@bugsee/vite-plugin'; // bugsee-wizard\nexport default { plugins: [p()] };\n";
    await writeFile(p('vite.config.js'), cfgAfter.replace('plugins: [p()]', 'plugins: [ p( ) ]'));
    const rec = createManifestRecorder(tmp.dir, { wizard: 't', recipes: [] }, { cwd: tmp.dir });
    rec.record({
      file: 'vite.config.js',
      action: 'edited',
      before: cfg,
      after: cfgAfter,
      marker: 'bugsee-wizard',
    });
    await rec.flush();
    const res = await roll();
    expect(res.results.find((r) => r.file === 'vite.config.js')?.outcome).toBe('manual');
    expect(res.results.find((r) => r.file === 'server.js')?.outcome).toBe('reverted');
    const pkg = JSON.parse(await readFile(p('package.json'), 'utf8'));
    expect(pkg.devDependencies['@bugsee/vite-plugin']).toBeDefined();
    expect(await readFile(p('package-lock.json'), 'utf8')).toBe(LOCK_AFTER);
  });

  it('an init entry whose rollback throws also keeps the SDK (the package is not removed under an import that stays)', async () => {
    await wizardRun();
    // reading the entry fails (EISDIR), so reverting it throws instead of finishing
    await rm(p('server.js'));
    await mkdir(p('server.js'));
    const res = await roll();
    expect(res.failed).toBe(true);
    const pkg = JSON.parse(await readFile(p('package.json'), 'utf8'));
    expect(pkg.dependencies['@bugsee/bugsee']).toBeDefined();
    expect(await readFile(p('package-lock.json'), 'utf8')).toBe(LOCK_AFTER);
  });

  it('pnpm: files created by an install recorded AFTER the init edit are kept too (the decision is made before anything is reverted)', async () => {
    await wizardRun();
    // the @bugsee/cli install ran later and created pnpm-workspace.yaml (allowBuilds) for the kept @bugsee/cli
    const ws = "allowBuilds:\n  '@bugsee/cli': true\n";
    await writeFile(p('pnpm-workspace.yaml'), ws);
    const rec = createManifestRecorder(tmp.dir, { wizard: 't', recipes: [] }, { cwd: tmp.dir });
    rec.record({ file: 'pnpm-workspace.yaml', action: 'created', after: ws });
    await rec.flush();
    await writeFile(
      p('server.js'),
      (await readFile(p('server.js'), 'utf8')).replace('start();', 'start(8080);'),
    );
    const res = await roll();
    expect(await readFile(p('pnpm-workspace.yaml'), 'utf8')).toBe(ws);
    expect(res.results.find((r) => r.file === 'pnpm-workspace.yaml')?.outcome).toBe('manual');
    const pkg = JSON.parse(await readFile(p('package.json'), 'utf8'));
    expect(pkg.devDependencies['@bugsee/vite-plugin']).toBeDefined();
  });

  it('a kept set that includes @bugsee/cli keeps it (every package stays, none is picked)', async () => {
    const before = `${JSON.stringify({ name: 'a' }, null, 2)}\n`;
    const after = `${JSON.stringify({ name: 'a', devDependencies: { '@bugsee/cli': '^0.9.0' } }, null, 2)}\n`;
    await writeFile(p('package.json'), after);
    await writeFile(p('server.js'), "import 'x'; // bugsee-wizard\nstart(8080);\n");
    const rec = createManifestRecorder(tmp.dir, { wizard: 't', recipes: [] }, { cwd: tmp.dir });
    rec.record({ file: 'package.json', action: 'edited', before, after });
    rec.record({
      file: 'server.js',
      action: 'edited',
      before: "import 'x'; start();\n",
      after: "import 'x';\nimport { l } from '@bugsee/bugsee'; // bugsee-wizard\nstart();\n",
      marker: 'bugsee-wizard:sdk-init',
    });
    await rec.flush();
    await roll();
    expect(
      JSON.parse(await readFile(p('package.json'), 'utf8')).devDependencies['@bugsee/cli'],
    ).toBeDefined();
  });
});
