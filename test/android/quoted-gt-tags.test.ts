import { afterEach, describe, expect, it } from 'vitest';

import { findOpenTag, findOpenTags } from '../../src/recipes/android/io.js';
import { detectProcessConfig } from '../../src/recipes/android/process-config.js';
import { injectProviderOverrideStep } from '../../src/recipes/android/steps/inject-provider-override.js';
import { cleanup, makeAndroidContext, makeFixture, readFixture } from './helpers.js';

let fixture: string;
afterEach(async () => {
  if (fixture) await cleanup(fixture);
});

const REL = 'app/src/main/AndroidManifest.xml';
const QUOTES = ['"', "'"] as const;

describe('findOpenTag / findOpenTags', () => {
  it('is quote-aware, knows self-closing, skips -alias names, stops at unterminated', () => {
    const t = findOpenTag('<a><application x="1 > 2" y=\'/>\'/>', 'application');
    expect(t?.selfClosing).toBe(true);
    expect(t?.attrs).toBe(' x="1 > 2" y=\'/>\'');
    expect(findOpenTag('<activity-alias a="b"/>', 'activity')).toBeNull();
    const all = [
      ...findOpenTags('<activity a="x>y"/><service/><activity b="1">', ['activity', 'service']),
    ];
    expect(all.map((x) => x.name)).toEqual(['activity', 'service', 'activity']);
    expect(findOpenTag('<application a="x', 'application')).toBeNull();
    expect(findOpenTag('<application a="x>"', 'application')).toBeNull();
  });
});

describe('detectProcessConfig with a quoted ">" in attributes', () => {
  it.each(QUOTES)('finds the application process in both attribute orders (%s)', (q) => {
    const a = `<manifest><application android:label=${q}A > B${q} android:process=${q}:main${q}></application></manifest>`;
    const b = `<manifest><application android:process=${q}:main${q} android:label=${q}A > B${q}></application></manifest>`;
    expect(detectProcessConfig(a).applicationProcess).toBe(':main');
    expect(detectProcessConfig(b).applicationProcess).toBe(':main');
  });

  it.each(QUOTES)('finds component processes behind a quoted ">" (%s)', (q) => {
    const m = `<manifest><application><service android:label=${q}x > y${q} android:process=${q}:svc${q}/></application></manifest>`;
    expect(detectProcessConfig(m).componentProcesses).toEqual([':svc']);
  });
});

describe('injectProviderOverrideStep with a quoted ">" in <application>', () => {
  const opts = { providerProcessOverride: ':main' };
  const manifest = (app: string) =>
    `<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n${app}\n</manifest>\n`;

  it.each(QUOTES)('inserts after the full opening tag, both orders (%s)', async (q) => {
    for (const attrs of [
      `android:process=${q}:main${q} android:label=${q}A > B${q}`,
      `android:label=${q}A > B${q} android:process=${q}:main${q}`,
    ]) {
      fixture = await makeFixture({ [REL]: manifest(`<application ${attrs}>\n</application>`) });
      const ctx = makeAndroidContext({ cwd: fixture, dsl: 'kotlin', androidOptions: opts });
      expect(await injectProviderOverrideStep.precheck(ctx)).toEqual({ kind: 'pending' });
      await injectProviderOverrideStep.apply(ctx);
      const out = await readFixture(fixture, REL);
      const open = `<application ${attrs}>\n`;
      expect(out).toContain(open);
      expect(out.indexOf('<provider')).toBeGreaterThan(out.indexOf(open) + open.length - 1);
      await cleanup(fixture);
    }
  });

  it.each(QUOTES)('blocks a self-closing application with a quoted ">" (%s)', async (q) => {
    fixture = await makeFixture({ [REL]: manifest(`<application android:label=${q}A > B${q} />`) });
    const ctx = makeAndroidContext({ cwd: fixture, dsl: 'kotlin', androidOptions: opts });
    const st = await injectProviderOverrideStep.precheck(ctx);
    expect(st.kind).toBe('blocked');
    expect(JSON.stringify(st)).toContain('self-closing');
  });
});
