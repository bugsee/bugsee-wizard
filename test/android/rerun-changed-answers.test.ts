import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { configureBugseeBlockStep } from '../../src/recipes/android/steps/configure-bugsee-block.js';
import { injectManifestMetaStep } from '../../src/recipes/android/steps/inject-manifest-meta.js';
import {
  cleanup,
  makeAndroidContext,
  makeFixture,
  readFixture,
  SAMPLE_KOTLIN_APP_BUILD,
  SAMPLE_MANIFEST,
} from './helpers.js';

const GRADLE = 'app/build.gradle.kts';
const MANIFEST = 'app/src/main/AndroidManifest.xml';

let fixture: string | undefined;
afterEach(async () => {
  if (fixture) await cleanup(fixture);
  fixture = undefined;
});

const opts = (o: Record<string, unknown>) => ({
  initMode: 'automatic' as const,
  ndk: false,
  feedback: false,
  sizeAnalysis: false,
  providerProcessOverride: null,
  ...o,
});

describe('re-run with changed answers: bugsee {} block', () => {
  it('is satisfied for identical answers, pending for changed ones', async () => {
    fixture = await makeFixture({ [GRADLE]: SAMPLE_KOTLIN_APP_BUILD });
    const a = makeAndroidContext({ cwd: fixture, dsl: 'kotlin' });
    await configureBugseeBlockStep.apply(a);
    expect(await configureBugseeBlockStep.precheck(a)).toEqual({ kind: 'satisfied' });
    const b = makeAndroidContext({
      cwd: fixture,
      dsl: 'kotlin',
      androidOptions: opts({ ndk: true }),
    });
    expect((await configureBugseeBlockStep.precheck(b)).kind).toBe('pending');
  });

  it('updates the block in place (no duplicate) and rollback restores the pre-run file', async () => {
    fixture = await makeFixture({ [GRADLE]: SAMPLE_KOTLIN_APP_BUILD });
    const a = makeAndroidContext({ cwd: fixture, dsl: 'kotlin' });
    await configureBugseeBlockStep.apply(a);
    const afterFirst = await readFixture(fixture, GRADLE);

    const b = makeAndroidContext({
      cwd: fixture,
      dsl: 'kotlin',
      androidOptions: opts({ ndk: true, feedback: true }),
    });
    await configureBugseeBlockStep.apply(b);
    const updated = await readFixture(fixture, GRADLE);
    expect(updated).toContain('ndk(true)');
    expect(updated).toContain('feedback(true)');
    expect(updated.match(/bugsee:wizard/g)?.length).toBe(
      afterFirst.match(/bugsee:wizard/g)?.length,
    );
    expect(await configureBugseeBlockStep.precheck(b)).toEqual({ kind: 'satisfied' });

    await configureBugseeBlockStep.rollback(b);
    expect(await readFixture(fixture, GRADLE)).toBe(afterFirst);
  });

  it('uninstall rollback (no apply in this run) still strips the block', async () => {
    fixture = await makeFixture({ [GRADLE]: SAMPLE_KOTLIN_APP_BUILD });
    await configureBugseeBlockStep.apply(makeAndroidContext({ cwd: fixture, dsl: 'kotlin' }));
    await configureBugseeBlockStep.rollback(makeAndroidContext({ cwd: fixture, dsl: 'kotlin' }));
    expect(await readFixture(fixture, GRADLE)).toBe(SAMPLE_KOTLIN_APP_BUILD);
  });
});

describe('re-run: user edits and damaged markers (bugsee {} block)', () => {
  const setup = async (dsl: 'kotlin' | 'groovy' = 'kotlin') => {
    fixture = await makeFixture({ [GRADLE]: SAMPLE_KOTLIN_APP_BUILD });
    const a = makeAndroidContext({ cwd: fixture, dsl });
    await configureBugseeBlockStep.apply(a);
    return a;
  };

  it('keeps a user line inside the block when the answers are identical', async () => {
    const a = await setup();
    const file = join(fixture as string, GRADLE);
    const edited = (await readFixture(fixture as string, GRADLE)).replace(
      'bugsee {',
      'bugsee {\n    appToken("abc")',
    );
    await writeFile(file, edited);
    expect(await configureBugseeBlockStep.precheck(a)).toEqual({ kind: 'satisfied' });
  });

  it('keeps the user line when the answers change', async () => {
    const a = await setup();
    const file = join(fixture as string, GRADLE);
    await writeFile(
      file,
      (await readFixture(fixture as string, GRADLE)).replace(
        'bugsee {',
        'bugsee {\n    appToken("abc")',
      ),
    );
    const b = makeAndroidContext({
      cwd: fixture as string,
      dsl: 'kotlin',
      androidOptions: opts({ ndk: true }),
    });
    expect((await configureBugseeBlockStep.precheck(b)).kind).toBe('pending');
    await configureBugseeBlockStep.apply(b);
    const out = await readFixture(fixture as string, GRADLE);
    expect(out).toContain('appToken("abc")');
    expect(out).toContain('ndk(true)');
    expect(out.match(/bugsee \{/g)?.length).toBe(1);
    expect(a).toBeDefined();
  });

  const editBlock = async (fn: (t: string) => string) => {
    const file = join(fixture as string, GRADLE);
    await writeFile(file, fn(await readFixture(fixture as string, GRADLE)));
  };
  const withNdk = () =>
    makeAndroidContext({
      cwd: fixture as string,
      dsl: 'kotlin',
      androidOptions: opts({ ndk: true }),
    });

  it('keeps a note after the closing brace and writes a well-formed block', async () => {
    await setup();
    await editBlock((t) =>
      t.replace('// bugsee:wizard:bugsee-block:end', '// note\n// bugsee:wizard:bugsee-block:end'),
    );
    const b = withNdk();
    await configureBugseeBlockStep.apply(b);
    const out = await readFixture(fixture as string, GRADLE);
    expect(out).toContain('// note');
    expect(out).toContain('ndk(true)');
    const block = out.slice(out.indexOf('bugsee:wizard:bugsee-block:begin'));
    expect((block.match(/\{/g) ?? []).length).toBe((block.match(/\}/g) ?? []).length);
    expect(await configureBugseeBlockStep.precheck(b)).toEqual({ kind: 'satisfied' });
  });

  it('replaces a user-extended sizeAnalysis block instead of duplicating it', async () => {
    await setup();
    await editBlock((t) =>
      t.replace(
        'bugsee {',
        'bugsee {\n    sizeAnalysis {\n        enabled.set(true)\n        uploadMapping.set(true)\n    }',
      ),
    );
    const b = makeAndroidContext({
      cwd: fixture as string,
      dsl: 'kotlin',
      androidOptions: opts({ sizeAnalysis: true }),
    });
    expect(await configureBugseeBlockStep.precheck(b)).toEqual({ kind: 'satisfied' });
    const c = makeAndroidContext({
      cwd: fixture as string,
      dsl: 'kotlin',
      androidOptions: opts({ sizeAnalysis: true, ndk: true }),
    });
    await configureBugseeBlockStep.apply(c);
    const out = await readFixture(fixture as string, GRADLE);
    expect(out.match(/sizeAnalysis/g)?.length).toBe(1);
  });

  it('keeps a user-extended sizeAnalysis when only ndk changes', async () => {
    await setup();
    await editBlock((t) =>
      t.replace(
        'bugsee {',
        'bugsee {\n    sizeAnalysis {\n        enabled.set(true)\n        uploadMapping.set(true)\n    }',
      ),
    );
    const c = makeAndroidContext({
      cwd: fixture as string,
      dsl: 'kotlin',
      androidOptions: opts({ sizeAnalysis: true, ndk: true }),
    });
    await configureBugseeBlockStep.apply(c);
    const out = await readFixture(fixture as string, GRADLE);
    expect(out).toContain('uploadMapping.set(true)');
    expect(out).toContain('ndk(true)');
    expect(out.match(/sizeAnalysis/g)?.length).toBe(1);
    expect(out.match(/bugsee \{/g)?.length).toBe(1);
  });

  it('braces inside comments and strings do not confuse the block, no duplicate bugsee {}', async () => {
    await setup();
    await editBlock((t) =>
      t.replace('bugsee {', 'bugsee {\n    // TODO: wrap in { when flavor set\n    note("}")'),
    );
    await configureBugseeBlockStep.apply(withNdk());
    const out = await readFixture(fixture as string, GRADLE);
    expect(out.match(/bugsee \{/g)?.length).toBe(1);
    expect(out).toContain('// TODO: wrap in { when flavor set');
    expect(out).toContain('note("}")');
    expect(out).toContain('ndk(true)');
  });

  it('multi-line block comments with braces do not break the block (no duplicate)', async () => {
    await setup();
    await editBlock((t) =>
      t.replace('bugsee {', 'bugsee {\n    /* old config {\n       foo\n    */'),
    );
    await configureBugseeBlockStep.apply(withNdk());
    const out = await readFixture(fixture as string, GRADLE);
    expect(out.match(/bugsee \{/g)?.length).toBe(1);
    expect(out).toContain('/* old config {');
    expect(out).toContain('ndk(true)');
  });

  it('a one-line bugsee { ndk(true) } is satisfied when answers match, blocked (not rewritten) when they differ', async () => {
    const a = await setup();
    await editBlock((t) => t.replace(/bugsee \{[\s\S]*?\n\}/, 'bugsee { ndk(true) }'));
    expect(await configureBugseeBlockStep.precheck(withNdk())).toEqual({ kind: 'satisfied' });
    const before = await readFixture(fixture as string, GRADLE);
    expect((await configureBugseeBlockStep.precheck(a)).kind).toBe('blocked');
    expect(await readFixture(fixture as string, GRADLE)).toBe(before);
  });

  it('a toggle-named line nested in a user block is not a top-level answer and is left alone', async () => {
    const a = await setup();
    await editBlock((t) =>
      t.replace('bugsee {', 'bugsee {\n    variants {\n        ndk(true)\n    }'),
    );
    const b = withNdk();
    expect((await configureBugseeBlockStep.precheck(b)).kind).toBe('pending');
    await configureBugseeBlockStep.apply(b);
    const out = await readFixture(fixture as string, GRADLE);
    expect(out).toContain('variants {\n        ndk(true)\n    }');
    expect(out.match(/ndk\(true\)/g)?.length).toBe(2);
    expect(await configureBugseeBlockStep.precheck(a)).toEqual({ kind: 'pending' });
  });

  it('text on the bugsee { line or before the closing brace is blocked, not dropped', async () => {
    await setup();
    await editBlock((t) => t.replace('bugsee {', 'bugsee { appToken("x")'));
    const before = await readFixture(fixture as string, GRADLE);
    expect((await configureBugseeBlockStep.precheck(withNdk())).kind).toBe('blocked');
    expect(await readFixture(fixture as string, GRADLE)).toBe(before);
    await editBlock((t) =>
      t
        .replace('bugsee { appToken("x")', 'bugsee {')
        .replace(/\n\}\n(\/\/ bugsee:wizard:bugsee-block:end)/, '\n    appToken("y") }\n$1'),
    );
    expect((await configureBugseeBlockStep.precheck(withNdk())).kind).toBe('blocked');
  });

  it('text after the closing brace on the same line is blocked, not dropped', async () => {
    await setup();
    await editBlock((t) =>
      t.replace(/\n\}\n(\/\/ bugsee:wizard:bugsee-block:end)/, '\n} extra()\n$1'),
    );
    const before = await readFixture(fixture as string, GRADLE);
    expect((await configureBugseeBlockStep.precheck(withNdk())).kind).toBe('blocked');
    expect(await readFixture(fixture as string, GRADLE)).toBe(before);
  });

  it('a trailing comment mentioning false does not turn ndk(true) off', async () => {
    const a = await setup();
    await editBlock((t) => t.replace('bugsee {', 'bugsee {\n    ndk(true) // false on CI'));
    expect(await configureBugseeBlockStep.precheck(withNdk())).toEqual({ kind: 'satisfied' });
    expect((await configureBugseeBlockStep.precheck(a)).kind).toBe('pending');
  });

  it('a user ndk(false) is replaced by the generated ndk(true), not kept beside it', async () => {
    await setup();
    await editBlock((t) => t.replace('bugsee {', 'bugsee {\n    ndk(false)'));
    const b = withNdk();
    expect((await configureBugseeBlockStep.precheck(b)).kind).toBe('pending');
    await configureBugseeBlockStep.apply(b);
    const out = await readFixture(fixture as string, GRADLE);
    expect(out).toContain('ndk(true)');
    expect(out).not.toContain('ndk(false)');
  });

  it('a user ndk(false) with ndk answered no is satisfied and untouched', async () => {
    const a = await setup();
    await editBlock((t) => t.replace('bugsee {', 'bugsee {\n    ndk(false)'));
    expect(await configureBugseeBlockStep.precheck(a)).toEqual({ kind: 'satisfied' });
  });

  it('is satisfied on a CRLF file', async () => {
    const a = await setup();
    const file = join(fixture as string, GRADLE);
    const crlf = (await readFixture(fixture as string, GRADLE)).replace(/\n/g, '\r\n');
    await writeFile(file, crlf);
    expect(await configureBugseeBlockStep.precheck(a)).toEqual({ kind: 'satisfied' });
  });

  it('updates a CRLF file in place with CRLF line endings', async () => {
    await setup();
    const file = join(fixture as string, GRADLE);
    await writeFile(file, (await readFixture(fixture as string, GRADLE)).replace(/\n/g, '\r\n'));
    const b = makeAndroidContext({
      cwd: fixture as string,
      dsl: 'kotlin',
      androidOptions: opts({ feedback: true }),
    });
    await configureBugseeBlockStep.apply(b);
    const out = await readFixture(fixture as string, GRADLE);
    expect(out).toContain('feedback(true)');
    expect(out).not.toMatch(/[^\r]\n/);
  });

  it('blocks (does not report applied) when the END marker is missing', async () => {
    const a = await setup();
    const file = join(fixture as string, GRADLE);
    const text = await readFixture(fixture as string, GRADLE);
    await writeFile(file, text.replace(/^.*bugsee:wizard:bugsee-block:end.*\r?\n?/m, ''));
    const status = await configureBugseeBlockStep.precheck(a);
    expect(status.kind).toBe('blocked');
  });

  it('updates the groovy DSL variant in place', async () => {
    fixture = await makeFixture({ ['app/build.gradle']: SAMPLE_KOTLIN_APP_BUILD });
    const a = makeAndroidContext({ cwd: fixture, dsl: 'groovy' });
    await configureBugseeBlockStep.apply(a);
    const b = makeAndroidContext({
      cwd: fixture,
      dsl: 'groovy',
      androidOptions: opts({ ndk: true }),
    });
    await configureBugseeBlockStep.apply(b);
    const out = await readFixture(fixture, 'app/build.gradle');
    expect(out).toContain('ndk true');
    expect(out.match(/bugsee \{/g)?.length).toBe(1);
    expect(await configureBugseeBlockStep.precheck(b)).toEqual({ kind: 'satisfied' });
  });
});

describe('re-run: damaged or re-formatted manifest block', () => {
  it('is satisfied after CRLF + re-indent; blocked when the END marker is missing', async () => {
    fixture = await makeFixture({ [MANIFEST]: SAMPLE_MANIFEST });
    const a = makeAndroidContext({ cwd: fixture, dsl: 'kotlin' });
    await injectManifestMetaStep.apply(a);
    const file = join(fixture, MANIFEST);
    const text = await readFixture(fixture, MANIFEST);
    await writeFile(file, text.replace(/\n/g, '\r\n').replace(/^ {4}/gm, '\t'));
    expect(await injectManifestMetaStep.precheck(a)).toEqual({ kind: 'satisfied' });
    await writeFile(file, text.replace(/^.*bugsee:wizard:meta:end.*\r?\n?/m, ''));
    expect((await injectManifestMetaStep.precheck(a)).kind).toBe('blocked');
  });
});

describe('re-run with changed answers: manifest meta-data', () => {
  it('switching init mode updates the block in place; rollback restores the previous state', async () => {
    fixture = await makeFixture({ [MANIFEST]: SAMPLE_MANIFEST });
    const a = makeAndroidContext({ cwd: fixture, dsl: 'kotlin' });
    await injectManifestMetaStep.apply(a);
    expect(await injectManifestMetaStep.precheck(a)).toEqual({ kind: 'satisfied' });
    const afterFirst = await readFixture(fixture, MANIFEST);

    const b = makeAndroidContext({
      cwd: fixture,
      dsl: 'kotlin',
      androidOptions: opts({ initMode: 'manual' }),
    });
    expect((await injectManifestMetaStep.precheck(b)).kind).toBe('pending');
    await injectManifestMetaStep.apply(b);
    const updated = await readFixture(fixture, MANIFEST);
    expect(updated).toContain('com.bugsee.auto-init');
    expect(updated).not.toContain('com.bugsee.app-token');
    expect(await injectManifestMetaStep.precheck(b)).toEqual({ kind: 'satisfied' });

    await injectManifestMetaStep.rollback(b);
    expect(await readFixture(fixture, MANIFEST)).toBe(afterFirst);
  });

  it('keeps user content inside the markers and CRLF line endings on a mode change', async () => {
    fixture = await makeFixture({ [MANIFEST]: SAMPLE_MANIFEST });
    await injectManifestMetaStep.apply(makeAndroidContext({ cwd: fixture, dsl: 'kotlin' }));
    const file = join(fixture, MANIFEST);
    const edited = (await readFixture(fixture, MANIFEST))
      .replace(
        '<!-- bugsee:wizard:meta:end -->',
        '<meta-data android:name="my.key" android:value="1" />\n    <!-- bugsee:wizard:meta:end -->',
      )
      .replace(/\n/g, '\r\n');
    await writeFile(file, edited);
    const b = makeAndroidContext({
      cwd: fixture,
      dsl: 'kotlin',
      androidOptions: opts({ initMode: 'manual' }),
    });
    await injectManifestMetaStep.apply(b);
    const out = await readFixture(fixture, MANIFEST);
    expect(out).toContain('my.key');
    expect(out).toContain('com.bugsee.auto-init');
    expect(out).not.toContain('com.bugsee.app-token');
    expect(out).not.toMatch(/[^\r]\n/);
  });

  it('a kept user comment naming the other meta-data does not break idempotency', async () => {
    fixture = await makeFixture({ [MANIFEST]: SAMPLE_MANIFEST });
    await injectManifestMetaStep.apply(makeAndroidContext({ cwd: fixture, dsl: 'kotlin' }));
    const file = join(fixture, MANIFEST);
    await writeFile(
      file,
      (await readFixture(fixture, MANIFEST)).replace(
        '<!-- bugsee:wizard:meta:end -->',
        '<!-- was com.bugsee.auto-init before -->\n    <!-- bugsee:wizard:meta:end -->',
      ),
    );
    const b = makeAndroidContext({
      cwd: fixture,
      dsl: 'kotlin',
      androidOptions: opts({ initMode: 'manual' }),
    });
    await injectManifestMetaStep.apply(b);
    expect(await injectManifestMetaStep.precheck(b)).toEqual({ kind: 'satisfied' });
    expect(await readFixture(fixture, MANIFEST)).toContain('was com.bugsee.auto-init before');
  });

  it('uninstall rollback strips the block back to the original manifest', async () => {
    fixture = await makeFixture({ [MANIFEST]: SAMPLE_MANIFEST });
    await injectManifestMetaStep.apply(makeAndroidContext({ cwd: fixture, dsl: 'kotlin' }));
    await injectManifestMetaStep.rollback(makeAndroidContext({ cwd: fixture, dsl: 'kotlin' }));
    expect(await readFixture(fixture, MANIFEST)).toBe(SAMPLE_MANIFEST);
  });
});
