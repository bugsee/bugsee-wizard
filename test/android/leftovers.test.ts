import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { configureBugseeBlockStep } from '../../src/recipes/android/steps/configure-bugsee-block.js';
import { injectManifestMetaStep } from '../../src/recipes/android/steps/inject-manifest-meta.js';
import { injectManifestPlaceholderStep } from '../../src/recipes/android/steps/inject-manifest-placeholder.js';
import { injectProviderOverrideStep } from '../../src/recipes/android/steps/inject-provider-override.js';
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

const gradleCtx = (o: Record<string, unknown> = {}) =>
  makeAndroidContext({ cwd: fixture as string, dsl: 'kotlin', androidOptions: opts(o) });

const rewrite = async (file: string, fn: (t: string) => string) =>
  writeFile(join(fixture as string, file), fn(await readFixture(fixture as string, file)));

describe('provider override re-run', () => {
  const ctxFor = (processName: string) =>
    makeAndroidContext({
      cwd: fixture as string,
      dsl: 'kotlin',
      androidOptions: opts({ providerProcessOverride: processName }),
    });

  it('is satisfied for the same process, pending (and updated in place) for a different one', async () => {
    fixture = await makeFixture({ [MANIFEST]: SAMPLE_MANIFEST });
    await injectProviderOverrideStep.apply(ctxFor(':one'));
    expect(await injectProviderOverrideStep.precheck(ctxFor(':one'))).toEqual({
      kind: 'satisfied',
    });
    const b = ctxFor(':two');
    expect((await injectProviderOverrideStep.precheck(b)).kind).toBe('pending');
    const before = await readFixture(fixture, MANIFEST);
    await injectProviderOverrideStep.apply(b);
    const out = await readFixture(fixture, MANIFEST);
    expect(out).toContain('android:process=":two"');
    expect(out).not.toContain(':one');
    expect(out.match(/BugseeInitProvider/g)?.length).toBe(1);
    expect(await injectProviderOverrideStep.precheck(b)).toEqual({ kind: 'satisfied' });
    await injectProviderOverrideStep.rollback(b);
    expect(await readFixture(fixture, MANIFEST)).toBe(before);
  });

  it('compares an escaped process name by its value', async () => {
    fixture = await makeFixture({ [MANIFEST]: SAMPLE_MANIFEST });
    await injectProviderOverrideStep.apply(ctxFor(':"<&>'));
    expect(await injectProviderOverrideStep.precheck(ctxFor(':"<&>'))).toEqual({
      kind: 'satisfied',
    });
  });

  it('is blocked, not satisfied, when the END marker is missing', async () => {
    fixture = await makeFixture({ [MANIFEST]: SAMPLE_MANIFEST });
    await injectProviderOverrideStep.apply(ctxFor(':one'));
    await rewrite(MANIFEST, (t) => t.replace(/.*provider-override:end.*\n/, ''));
    expect((await injectProviderOverrideStep.precheck(ctxFor(':one'))).kind).toBe('blocked');
  });
});

describe('manifest placeholder with a damaged marker', () => {
  it('is blocked when the END marker is missing', async () => {
    fixture = await makeFixture({ [GRADLE]: SAMPLE_KOTLIN_APP_BUILD });
    await injectManifestPlaceholderStep.apply(gradleCtx());
    await rewrite(GRADLE, (t) => t.replace(/.*manifest-placeholder:end.*\n/, ''));
    expect((await injectManifestPlaceholderStep.precheck(gradleCtx())).kind).toBe('blocked');
  });
});

describe('bugsee {} block: multi-line toggle and sizeAnalysis off', () => {
  it('treats `ndk(` / `false` / `)` as one toggle', async () => {
    fixture = await makeFixture({ [GRADLE]: SAMPLE_KOTLIN_APP_BUILD });
    await configureBugseeBlockStep.apply(gradleCtx());
    await rewrite(GRADLE, (t) =>
      t.replace(/ndk\(false\)|ndk\(true\)/, 'ndk(\n        false\n    )'),
    );
    expect(await configureBugseeBlockStep.precheck(gradleCtx())).toEqual({ kind: 'satisfied' });
    const b = gradleCtx({ ndk: true });
    await configureBugseeBlockStep.apply(b);
    const out = await readFixture(fixture, GRADLE);
    expect(out).toContain('ndk(true)');
    expect(out).not.toMatch(/^\s*false\s*$/m);
    expect(out).not.toMatch(/^\s*\)\s*$/m);
  });

  it('turning sizeAnalysis off keeps the user settings and flips only enabled', async () => {
    fixture = await makeFixture({ [GRADLE]: SAMPLE_KOTLIN_APP_BUILD });
    await configureBugseeBlockStep.apply(gradleCtx({ sizeAnalysis: true }));
    await rewrite(GRADLE, (t) =>
      t.replace(/(sizeAnalysis \{[^}]*)\}/, '$1    uploadMapping.set(true)\n    }'),
    );
    expect(await readFixture(fixture, GRADLE)).toContain('uploadMapping');
    const off = gradleCtx({ sizeAnalysis: false });
    expect((await configureBugseeBlockStep.precheck(off)).kind).toBe('pending');
    await configureBugseeBlockStep.apply(off);
    const out = await readFixture(fixture, GRADLE);
    expect(out).toContain('uploadMapping.set(true)');
    expect(out).toMatch(/enabled\.set\(false\)/);
    expect(await configureBugseeBlockStep.precheck(off)).toEqual({ kind: 'satisfied' });
    // and back on
    await configureBugseeBlockStep.apply(gradleCtx({ sizeAnalysis: true }));
    expect(await readFixture(fixture, GRADLE)).toMatch(/enabled\.set\(true\)/);
  });
});

describe('manifest meta-data in paired form', () => {
  it('a reformatted <meta-data></meta-data> is replaced on a mode change, not left beside the new one', async () => {
    fixture = await makeFixture({ [MANIFEST]: SAMPLE_MANIFEST });
    await injectManifestMetaStep.apply(
      makeAndroidContext({ cwd: fixture, dsl: 'kotlin', androidOptions: opts({}) }),
    );
    await rewrite(MANIFEST, (t) =>
      t.replace(
        /<meta-data[^>]*app-token[^>]*\/>/,
        '<meta-data android:name="com.bugsee.app-token" android:value="${bugseeAppToken}"></meta-data>',
      ),
    );
    await injectManifestMetaStep.apply(
      makeAndroidContext({
        cwd: fixture,
        dsl: 'kotlin',
        androidOptions: opts({ initMode: 'manual' }),
      }),
    );
    const out = await readFixture(fixture, MANIFEST);
    expect(out).toContain('com.bugsee.auto-init');
    expect(out).not.toContain('com.bugsee.app-token');
    expect(out).not.toContain('</meta-data>');
  });
});

describe('provider override: user lines, CRLF and removal', () => {
  const ctxFor = (processName: string | null) =>
    makeAndroidContext({
      cwd: fixture as string,
      dsl: 'kotlin',
      androidOptions: opts({ providerProcessOverride: processName }),
    });

  it('keeps a user line inside the markers and CRLF on a process change', async () => {
    fixture = await makeFixture({ [MANIFEST]: SAMPLE_MANIFEST });
    await injectProviderOverrideStep.apply(ctxFor(':one'));
    await rewrite(MANIFEST, (t) =>
      t
        .replace(
          '<!-- bugsee:wizard:provider-override:end -->',
          '<!-- mine -->\n    <!-- bugsee:wizard:provider-override:end -->',
        )
        .replace(/\n/g, '\r\n'),
    );
    await injectProviderOverrideStep.apply(ctxFor(':two'));
    const out = await readFixture(fixture, MANIFEST);
    expect(out).toContain('<!-- mine -->');
    expect(out).toContain('android:process=":two"');
    expect(out).not.toMatch(/[^\r]\n/);
  });

  it('removes an earlier override when none is wanted any more; rollback restores it', async () => {
    fixture = await makeFixture({ [MANIFEST]: SAMPLE_MANIFEST });
    await injectProviderOverrideStep.apply(ctxFor(':one'));
    const withOverride = await readFixture(fixture, MANIFEST);
    const off = ctxFor(null);
    expect((await injectProviderOverrideStep.precheck(off)).kind).toBe('pending');
    await injectProviderOverrideStep.apply(off);
    const out = await readFixture(fixture, MANIFEST);
    expect(out).not.toContain('BugseeInitProvider');
    expect(await injectProviderOverrideStep.precheck(off)).toMatchObject({ kind: 'satisfied' });
    await injectProviderOverrideStep.rollback(off);
    expect(await readFixture(fixture, MANIFEST)).toBe(withOverride);
  });

  it('is satisfied with no override and no earlier block', async () => {
    fixture = await makeFixture({ [MANIFEST]: SAMPLE_MANIFEST });
    expect(await injectProviderOverrideStep.precheck(ctxFor(null))).toMatchObject({
      kind: 'satisfied',
    });
  });
});

describe('sizeAnalysis flip is symmetric and ignores comments', () => {
  it('a comment naming enabled.set(true) is not edited; on again keeps the user settings', async () => {
    fixture = await makeFixture({ [GRADLE]: SAMPLE_KOTLIN_APP_BUILD });
    await configureBugseeBlockStep.apply(gradleCtx({ sizeAnalysis: true }));
    await rewrite(GRADLE, (t) =>
      t.replace(
        /sizeAnalysis \{/,
        'sizeAnalysis {\n        // enabled.set(true) to turn on\n        uploadMapping.set(true)',
      ),
    );
    await configureBugseeBlockStep.apply(gradleCtx({ sizeAnalysis: false }));
    let out = await readFixture(fixture, GRADLE);
    expect(out).toContain('// enabled.set(true) to turn on');
    expect(out).toContain('uploadMapping.set(true)');
    expect(out).toMatch(/^\s*enabled\.set\(false\)/m);
    await configureBugseeBlockStep.apply(gradleCtx({ sizeAnalysis: true }));
    out = await readFixture(fixture, GRADLE);
    expect(out).toContain('uploadMapping.set(true)');
    expect(out).toMatch(/^\s*enabled\.set\(true\)/m);
    expect(out.match(/sizeAnalysis/g)?.length).toBe(1);
  });
});
