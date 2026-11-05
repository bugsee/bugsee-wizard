import { afterEach, describe, expect, it } from 'vitest';

import { injectManifestMetaStep } from '../../src/recipes/android/steps/inject-manifest-meta.js';
import { cleanup, makeAndroidContext, makeFixture, readFixture } from './helpers.js';

let fixture: string;
afterEach(async () => {
  if (fixture) await cleanup(fixture);
});
const M = 'app/src/main/AndroidManifest.xml';
const wrap = (app: string) => `<manifest>\n${app}\n</manifest>\n`;

describe('inject-manifest-meta with a quoted ">" in the application tag', () => {
  it.each(['"', "'"])('self-closing with %s quotes is blocked', async (q) => {
    fixture = await makeFixture({ [M]: wrap(`<application android:label=${q}A > B${q} />`) });
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'kotlin' });
    expect((await injectManifestMetaStep.precheck(ctx)).kind).toBe('blocked');
    await expect(injectManifestMetaStep.apply(ctx)).rejects.toThrow(/self-closing/);
  });

  it.each(['"', "'"])('paired with %s quotes inserts after the full opening tag', async (q) => {
    fixture = await makeFixture({
      [M]: wrap(`<application android:label=${q}A > B${q}>\n</application>`),
    });
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'kotlin' });
    expect(await injectManifestMetaStep.precheck(ctx)).toEqual({ kind: 'pending' });
    await injectManifestMetaStep.apply(ctx);
    const out = await readFixture(fixture, M);
    expect(out).toContain(
      `<application android:label=${q}A > B${q}>\n    <!--`.replace('<!--', ''),
    );
    expect(out.indexOf('<meta-data')).toBeGreaterThan(out.indexOf(`B${q}>`));
  });

  it('unterminated opening tag counts as no application element', async () => {
    fixture = await makeFixture({ [M]: '<manifest><application android:label="x' });
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'kotlin' });
    expect((await injectManifestMetaStep.precheck(ctx)).kind).toBe('blocked');
  });
});
