import { afterEach, describe, expect, it, vi } from 'vitest';

import { injectProviderOverrideStep } from '../../src/recipes/android/steps/inject-provider-override.js';
import {
  cleanup,
  makeAndroidContext,
  makeFixture,
  readFixture,
  SAMPLE_MANIFEST,
} from './helpers.js';

vi.mock('@clack/prompts', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    step: vi.fn(),
    message: vi.fn(),
  },
}));

let fixture: string | undefined;
afterEach(async () => {
  if (fixture) {
    await cleanup(fixture);
    fixture = undefined;
  }
});

const REL = 'app/src/main/AndroidManifest.xml';

describe('injectProviderOverrideStep', () => {
  it('is satisfied when no override is requested', async () => {
    fixture = await makeFixture({ [REL]: SAMPLE_MANIFEST });
    const ctx = makeAndroidContext({
      cwd: fixture,
      dsl: 'kotlin',
      androidOptions: { providerProcessOverride: null },
    });
    expect(await injectProviderOverrideStep.precheck(ctx)).toEqual({
      kind: 'satisfied',
      note: 'no application process override needed',
    });
  });

  it('inserts the provider override and adds the tools namespace', async () => {
    fixture = await makeFixture({ [REL]: SAMPLE_MANIFEST });
    const ctx = makeAndroidContext({
      cwd: fixture,
      dsl: 'kotlin',
      androidOptions: { providerProcessOverride: ':custom' },
    });
    expect(await injectProviderOverrideStep.precheck(ctx)).toEqual({ kind: 'pending' });
    await injectProviderOverrideStep.apply(ctx);
    const updated = await readFixture(fixture, REL);
    expect(updated).toContain('xmlns:tools="http://schemas.android.com/tools"');
    expect(updated).toContain('com.bugsee.library.BugseeInitProvider');
    expect(updated).toContain('android:process=":custom"');
    expect(updated).toContain('tools:replace="android:process"');
    expect(await injectProviderOverrideStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
  });

  it('does not duplicate the tools namespace when already present', async () => {
    const manifestWithTools = SAMPLE_MANIFEST.replace(
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools">',
    );
    fixture = await makeFixture({ [REL]: manifestWithTools });
    const ctx = makeAndroidContext({
      cwd: fixture,
      dsl: 'kotlin',
      androidOptions: { providerProcessOverride: ':custom' },
    });
    await injectProviderOverrideStep.apply(ctx);
    const updated = await readFixture(fixture, REL);
    const matches = updated.match(/xmlns:tools="http:\/\/schemas\.android\.com\/tools"/g);
    expect(matches?.length).toBe(1);
  });

  // C6 regression — self-closing <application/> has no body; the step must
  // block with a clear reason rather than splice the provider XML outside
  // the application element (which would yield an invalid manifest).
  it('blocks when <application/> is self-closing', async () => {
    const minimal = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="X" />
</manifest>
`;
    fixture = await makeFixture({ [REL]: minimal });
    const ctx = makeAndroidContext({
      cwd: fixture,
      dsl: 'kotlin',
      androidOptions: { providerProcessOverride: ':custom' },
    });
    const status = await injectProviderOverrideStep.precheck(ctx);
    expect(status.kind).toBe('blocked');
    if (status.kind === 'blocked') {
      expect(status.reason).toMatch(/self-closing/);
    }
  });

  // C4 regression — a malformed process name with XML metacharacters must
  // be escaped so the wizard doesn't emit invalid XML downstream.
  it('XML-escapes the process name in the emitted attribute', async () => {
    fixture = await makeFixture({ [REL]: SAMPLE_MANIFEST });
    const ctx = makeAndroidContext({
      cwd: fixture,
      dsl: 'kotlin',
      // A real process name will never have these characters, but the
      // escape path defends the wizard's output against a malformed source.
      androidOptions: { providerProcessOverride: ':"<&>' },
    });
    await injectProviderOverrideStep.apply(ctx);
    const updated = await readFixture(fixture, REL);
    expect(updated).toContain('android:process=":&quot;&lt;&amp;&gt;"');
  });

  it('rolls back the provider block (xmlns:tools intentionally kept)', async () => {
    fixture = await makeFixture({ [REL]: SAMPLE_MANIFEST });
    const ctx = makeAndroidContext({
      cwd: fixture,
      dsl: 'kotlin',
      androidOptions: { providerProcessOverride: ':custom' },
    });
    await injectProviderOverrideStep.apply(ctx);
    await injectProviderOverrideStep.rollback(ctx);
    const restored = await readFixture(fixture, REL);
    expect(restored).not.toContain('com.bugsee.library.BugseeInitProvider');
    expect(restored).not.toContain('tools:replace');
    // xmlns:tools is intentionally not removed (other tooling may rely on it).
    // The rest of the manifest should be intact:
    expect(restored).toContain('<application');
    expect(restored).toContain('<activity');
  });
});
