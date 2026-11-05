import { writeFile } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { runSteps } from '../../src/core/step.js';
import {
  expoPluginSnippet,
  expoPluginStep,
} from '../../src/recipes/react-native/steps/expo-plugin.js';
import { cleanup, makeFixture, makeRnContext, readFixture } from './helpers.js';

const PKG = JSON.stringify({ name: 'x', dependencies: { expo: '52.0.0' } });
const dirs: string[] = [];

async function setup(appJson: string, tokens?: Record<string, string>) {
  const dir = await makeFixture({ 'package.json': PKG, 'app.json': appJson });
  dirs.push(dir);
  const ctx = await makeRnContext({ cwd: dir, ...(tokens ? { tokens } : {}) });
  return { dir, ctx };
}
const plugins = async (dir: string) =>
  (JSON.parse(await readFixture(dir, 'app.json')) as { expo: { plugins?: unknown[] } }).expo
    .plugins;

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(cleanup));
});

const base = (extra: object = {}, indent: string | number = 2) =>
  `${JSON.stringify({ expo: { name: 'a', ...extra } }, null, indent)}\n`;

describe('expoPluginStep', () => {
  it('is satisfied with a note when the project is not Expo', async () => {
    const dir = await makeFixture({ 'package.json': '{"name":"x"}' });
    dirs.push(dir);
    const ctx = await makeRnContext({ cwd: dir });
    const s = await expoPluginStep.precheck(ctx);
    expect(s).toMatchObject({ kind: 'satisfied' });
    expect((s as { note?: string }).note).toMatch(/not an Expo/);
    await expect(expoPluginStep.apply(ctx)).resolves.toBeUndefined();
    await expoPluginStep.rollback(ctx);
  });

  it('creates expo.plugins with a per-platform token object and keeps indent + newline', async () => {
    const { dir, ctx } = await setup(base({}, 4));
    expect(await expoPluginStep.precheck(ctx)).toEqual({ kind: 'pending' });
    await expoPluginStep.apply(ctx);
    expect(await plugins(dir)).toEqual([
      ['@bugsee/react-native', { appToken: { ios: 'IOS_TOKEN', android: 'AND_TOK' } }],
    ]);
    const text = await readFixture(dir, 'app.json');
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n    "expo": {');
    expect(text).toContain('        "name": "a"');
  });

  it('preserves tab indent and a missing trailing newline', async () => {
    const { dir, ctx } = await setup(JSON.stringify({ expo: { name: 'a' } }, null, '\t'));
    await expoPluginStep.apply(ctx);
    const text = await readFixture(dir, 'app.json');
    expect(text.endsWith('\n')).toBe(false);
    expect(text).toContain('\n\t\t"name": "a"');
  });

  it('uses a single string when both tokens are equal', async () => {
    const { dir, ctx } = await setup(base(), { ios: 'T', android: 'T' });
    await expoPluginStep.apply(ctx);
    expect(await plugins(dir)).toEqual([['@bugsee/react-native', { appToken: 'T' }]]);
  });

  it('uses a single string when only one token is known', async () => {
    const { dir, ctx } = await setup(base(), { ios: 'ONLY' });
    await expoPluginStep.apply(ctx);
    expect(await plugins(dir)).toEqual([['@bugsee/react-native', { appToken: 'ONLY' }]]);
  });

  it('adds the bare name when no token is known', async () => {
    const { dir, ctx } = await setup(base(), {});
    await expoPluginStep.apply(ctx);
    expect(await plugins(dir)).toEqual(['@bugsee/react-native']);
  });

  it('appends after existing plugins', async () => {
    const { dir, ctx } = await setup(base({ plugins: ['expo-router', ['other', { a: 1 }]] }));
    await expoPluginStep.apply(ctx);
    const p = (await plugins(dir)) as unknown[];
    expect(p.slice(0, 2)).toEqual(['expo-router', ['other', { a: 1 }]]);
    expect(p).toHaveLength(3);
  });

  it.each([
    ['string', ['@bugsee/react-native']],
    ['array', [['@bugsee/react-native', { appToken: 'MINE', uploadSymbols: false }]]],
  ])('is satisfied and untouched for an existing %s entry', async (_n, existing) => {
    const text = base({ plugins: existing });
    const { dir, ctx } = await setup(text);
    expect(await expoPluginStep.precheck(ctx)).toMatchObject({ kind: 'satisfied' });
    const res = await runSteps([expoPluginStep], ctx);
    expect(res.results[0]?.outcome).toBe('skipped');
    expect(await readFixture(dir, 'app.json')).toBe(text);
  });

  it('second run changes nothing', async () => {
    const { dir, ctx } = await setup(base());
    await runSteps([expoPluginStep], ctx);
    const once = await readFixture(dir, 'app.json');
    const res = await runSteps([expoPluginStep], ctx);
    expect(res.results[0]?.outcome).toBe('skipped');
    expect(await readFixture(dir, 'app.json')).toBe(once);
  });

  it('rollback restores the original bytes when it created plugins', async () => {
    const text = base({}, 4);
    const { dir, ctx } = await setup(text);
    await expoPluginStep.apply(ctx);
    await expoPluginStep.rollback(ctx);
    expect(await readFixture(dir, 'app.json')).toBe(text);
  });

  it('rollback after other edits removes only our entry and the plugins key we created', async () => {
    const { dir, ctx } = await setup(base());
    await expoPluginStep.apply(ctx);
    const edited = JSON.parse(await readFixture(dir, 'app.json'));
    edited.expo.version = '9';
    await writeFile(`${dir}/app.json`, `${JSON.stringify(edited, null, 2)}\n`);
    await expoPluginStep.rollback(ctx);
    const after = JSON.parse(await readFixture(dir, 'app.json'));
    expect(after.expo).toEqual({ name: 'a', version: '9' });
  });

  it('rollback keeps other plugins and a plugins key that pre-existed', async () => {
    const { dir, ctx } = await setup(base({ plugins: ['expo-router'] }));
    await expoPluginStep.apply(ctx);
    const edited = JSON.parse(await readFixture(dir, 'app.json'));
    edited.expo.plugins.push('later');
    await writeFile(`${dir}/app.json`, JSON.stringify(edited, null, 2));
    await expoPluginStep.rollback(ctx);
    expect(await plugins(dir)).toEqual(['expo-router', 'later']);
  });

  it('rollback leaves an entry the user changed since', async () => {
    const { dir, ctx } = await setup(base());
    await expoPluginStep.apply(ctx);
    const edited = JSON.parse(await readFixture(dir, 'app.json'));
    edited.expo.plugins[0][1].uploadSymbols = false;
    await writeFile(`${dir}/app.json`, JSON.stringify(edited, null, 2));
    const before = await readFixture(dir, 'app.json');
    await expoPluginStep.rollback(ctx);
    expect(await readFixture(dir, 'app.json')).toBe(before);
  });

  it('rollback tolerates the file becoming unreadable or invalid', async () => {
    const { dir, ctx } = await setup(base());
    await expoPluginStep.apply(ctx);
    await writeFile(`${dir}/app.json`, '{ nope');
    await expoPluginStep.rollback(ctx);
    expect(await readFixture(dir, 'app.json')).toBe('{ nope');

    const b = await setup(base());
    await expoPluginStep.apply(b.ctx);
    await writeFile(`${b.dir}/app.json`, JSON.stringify({ expo: { plugins: 'x' } }));
    await expoPluginStep.rollback(b.ctx);
    expect(JSON.parse(await readFixture(b.dir, 'app.json')).expo.plugins).toBe('x');

    const c = await setup(base());
    await expoPluginStep.apply(c.ctx);
    await cleanup(c.dir);
    await expect(expoPluginStep.rollback(c.ctx)).resolves.toBeUndefined();
  });

  it('blocks on malformed config or non-array plugins', async () => {
    const a = await setup(base({ plugins: 'x' }));
    expect(await expoPluginStep.precheck(a.ctx)).toMatchObject({ kind: 'blocked' });
    const b = await setup(base());
    await writeFile(`${b.dir}/app.json`, '[1]');
    expect(await expoPluginStep.precheck(b.ctx)).toMatchObject({ kind: 'blocked' });
    await writeFile(`${b.dir}/app.json`, '{ bad');
    expect(await expoPluginStep.precheck(b.ctx)).toMatchObject({ kind: 'blocked' });
    await cleanup(b.dir);
    expect(await expoPluginStep.precheck(b.ctx)).toMatchObject({ kind: 'blocked' });
    await expect(expoPluginStep.apply(b.ctx)).rejects.toThrow(/not found/);
    const c = await setup(base());
    await writeFile(`${c.dir}/app.json`, '{ bad');
    await expect(expoPluginStep.apply(c.ctx)).rejects.toThrow(/valid JSON/);
  });

  it('dry-run writes nothing', async () => {
    const text = base();
    const { dir, ctx } = await setup(text);
    const res = await runSteps([expoPluginStep], { ...ctx, dryRun: true });
    expect(res.results[0]?.outcome).toBe('applied');
    expect(await readFixture(dir, 'app.json')).toBe(text);
  });
});

describe('expoPluginStep rollback precision', () => {
  it('restores hand-formatted bytes exactly when untouched', async () => {
    const text = '{\n  "expo": {"name": "a",\n    "tags": [1,2]}\n}\n';
    const { dir, ctx } = await setup(text);
    await expoPluginStep.apply(ctx);
    await expoPluginStep.rollback(ctx);
    expect(await readFixture(dir, 'app.json')).toBe(text);
  });

  it('keeps a pre-existing empty plugins array after an unrelated edit', async () => {
    const { dir, ctx } = await setup(base({ plugins: [] }));
    await expoPluginStep.apply(ctx);
    const edited = JSON.parse(await readFixture(dir, 'app.json'));
    edited.expo.version = '2';
    await writeFile(`${dir}/app.json`, JSON.stringify(edited, null, 2));
    await expoPluginStep.rollback(ctx);
    expect((JSON.parse(await readFixture(dir, 'app.json')) as { expo: object }).expo).toEqual({
      name: 'a',
      plugins: [],
      version: '2',
    });
  });
});

describe('expoPluginStep rollback without a record (uninstall)', () => {
  it.each([
    ['string', '@bugsee/react-native'],
    ['array', ['@bugsee/react-native', { appToken: 'MINE' }]],
  ])('removes a user-written %s entry, keeps others, and is idempotent', async (_n, entry) => {
    const { dir, ctx } = await setup(
      base({ plugins: ['expo-router', entry, ['other', { a: 1 }]] }, 4),
    );
    await expoPluginStep.rollback(ctx);
    expect(await plugins(dir)).toEqual(['expo-router', ['other', { a: 1 }]]);
    const once = await readFixture(dir, 'app.json');
    expect(once.endsWith('\n')).toBe(true);
    expect(once).toContain('\n        "name"');
    await expoPluginStep.rollback(ctx);
    expect(await readFixture(dir, 'app.json')).toBe(once);
  });

  it('keeps an empty plugins array it did not create', async () => {
    const { dir, ctx } = await setup(base({ plugins: ['@bugsee/react-native'] }));
    await expoPluginStep.rollback(ctx);
    expect(await plugins(dir)).toEqual([]);
  });

  it('is a no-op without an entry, without plugins, or with a missing/bad file', async () => {
    const a = await setup(base({ plugins: ['expo-router'] }));
    const textA = await readFixture(a.dir, 'app.json');
    await expoPluginStep.rollback(a.ctx);
    expect(await readFixture(a.dir, 'app.json')).toBe(textA);
    const b = await setup(base());
    await expoPluginStep.rollback(b.ctx);
    expect(await readFixture(b.dir, 'app.json')).toBe(base());
    await writeFile(`${b.dir}/app.json`, '{ bad');
    await expoPluginStep.rollback(b.ctx);
    expect(await readFixture(b.dir, 'app.json')).toBe('{ bad');
    await cleanup(b.dir);
    await expect(expoPluginStep.rollback(b.ctx)).resolves.toBeUndefined();
  });

  it('a failed run that did not touch the entry never removes it', async () => {
    const text = base({ plugins: [['@bugsee/react-native', { appToken: 'MINE' }]] });
    const { dir, ctx } = await setup(text);
    const boom = {
      id: 'boom',
      title: 'boom',
      precheck: async () => ({ kind: 'pending' as const }),
      apply: async () => {
        throw new Error('x');
      },
      rollback: async () => {},
    };
    const res = await runSteps([expoPluginStep, boom], ctx);
    expect(res.failed).toBe(true);
    expect(await readFixture(dir, 'app.json')).toBe(text);
  });

  it('a failed run that added the entry removes exactly it and restores bytes', async () => {
    const text = base();
    const { dir, ctx } = await setup(text);
    const boom = {
      id: 'boom',
      title: 'boom',
      precheck: async () => ({ kind: 'pending' as const }),
      apply: async () => {
        throw new Error('x');
      },
      rollback: async () => {},
    };
    const res = await runSteps([expoPluginStep, boom], ctx);
    expect(res.failed).toBe(true);
    expect(await readFixture(dir, 'app.json')).toBe(text);
  });
});

describe('expoPluginStep record lifetime', () => {
  it('a second rollback after a failed-run rollback uses uninstall rules, not the stale record', async () => {
    const { dir, ctx } = await setup(base({ plugins: ['expo-router'] }));
    await expoPluginStep.apply(ctx);
    await expoPluginStep.rollback(ctx);
    // The user re-adds the entry in another form afterwards; a stale record would match it exactly.
    const edited = JSON.parse(await readFixture(dir, 'app.json'));
    edited.expo.plugins.push('@bugsee/react-native');
    edited.expo.plugins.unshift('first');
    await writeFile(`${dir}/app.json`, JSON.stringify(edited, null, 2));
    await expoPluginStep.rollback(ctx);
    expect(await plugins(dir)).toEqual(['first', 'expo-router']);
  });
});

describe('expoPluginSnippet', () => {
  it('shows per-platform tokens only where given', () => {
    expect(JSON.parse(expoPluginSnippet({ ios: 'I', android: 'A' }))).toEqual([
      '@bugsee/react-native',
      { appToken: { ios: 'I', android: 'A' } },
    ]);
    expect(JSON.parse(expoPluginSnippet({ android: 'A' }))).toEqual([
      '@bugsee/react-native',
      { appToken: 'A' },
    ]);
    expect(expoPluginSnippet({})).toBe('"@bugsee/react-native"');
    expect(expoPluginSnippet({ ios: 'S', android: 'S' })).toContain('"appToken": "S"');
  });
});
