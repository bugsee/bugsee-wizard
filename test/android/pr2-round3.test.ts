import { afterEach, describe, expect, it } from 'vitest';

import { ensureMavenCentralStep } from '../../src/recipes/android/steps/ensure-maven-central.js';
import { writeBugseePropertiesStep } from '../../src/recipes/android/steps/write-bugsee-properties.js';
import { cleanup, fixtureExists, makeAndroidContext, makeFixture, readFixture } from './helpers.js';

let fixture: string;
afterEach(async () => {
  if (fixture) await cleanup(fixture);
});

const FILE = 'bugsee.properties';
const ctxFor = (token?: string) =>
  makeAndroidContext({ cwd: fixture, dsl: 'kotlin', tokens: token ? { android: token } : {} });

describe('writeBugseePropertiesStep rollback ownership', () => {
  it('keeps a manually maintained token (no marker, not what we would write)', async () => {
    fixture = await makeFixture({ [FILE]: 'a=1\napp_token=mine\n' });
    await writeBugseePropertiesStep.rollback(ctxFor());
    expect(await readFixture(fixture, FILE)).toBe('a=1\napp_token=mine\n');
    await writeBugseePropertiesStep.rollback(ctxFor('other'));
    expect(await readFixture(fixture, FILE)).toBe('a=1\napp_token=mine\n');
  });

  it('removes only the wizard-written entry and keeps other lines', async () => {
    fixture = await makeFixture({ [FILE]: 'a=1\nb=2' });
    await writeBugseePropertiesStep.apply(ctxFor('t'));
    await writeBugseePropertiesStep.rollback(ctxFor());
    expect(await readFixture(fixture, FILE)).toBe('a=1\nb=2\n');
  });

  it('deletes a wizard-created file that becomes empty', async () => {
    fixture = await makeFixture({});
    await writeBugseePropertiesStep.apply(ctxFor('t'));
    await writeBugseePropertiesStep.rollback(ctxFor());
    expect(await fixtureExists(fixture, FILE)).toBe(false);
  });

  it('restores the original line (CRLF kept) after replacing a different token, even after two applies', async () => {
    fixture = await makeFixture({ [FILE]: 'a=1\r\napp_token=orig\r\n' });
    await writeBugseePropertiesStep.apply(ctxFor('n1'));
    await writeBugseePropertiesStep.apply(ctxFor('n2'));
    const mid = await readFixture(fixture, FILE);
    expect(mid.match(/bugsee:wizard/g)).toHaveLength(1);
    expect(mid).toContain('app_token=n2');
    await writeBugseePropertiesStep.rollback(ctxFor());
    expect(await readFixture(fixture, FILE)).toBe('a=1\r\napp_token=orig\r\n');
  });

  it('legacy unmarked install: removes the line only when it matches the supplied token', async () => {
    fixture = await makeFixture({ [FILE]: 'a=1\napp_token=t\n' });
    await writeBugseePropertiesStep.rollback(ctxFor('t'));
    expect(await readFixture(fixture, FILE)).toBe('a=1\n');
  });

  it('is a no-op when the file is missing', async () => {
    fixture = await makeFixture({});
    await writeBugseePropertiesStep.rollback(ctxFor('t'));
    expect(await fixtureExists(fixture, FILE)).toBe(false);
  });
});

describe('ensureMavenCentralStep one-line repositories', () => {
  it.each([
    ['settings.gradle', 'groovy'],
    ['settings.gradle.kts', 'kotlin'],
  ] as const)('%s: puts mavenCentral() on its own line', async (name, dsl) => {
    fixture = await makeFixture({
      [name]: 'pluginManagement {\n    repositories { gradlePluginPortal() }\n}\n',
    });
    const ctx = makeAndroidContext({ cwd: fixture, dsl });
    await ensureMavenCentralStep.apply(ctx);
    const out = await readFixture(fixture, name);
    expect(out).toBe(
      'pluginManagement {\n    repositories { gradlePluginPortal() \n        mavenCentral()\n    }\n}\n',
    );
    expect(await ensureMavenCentralStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
    await ensureMavenCentralStep.rollback(ctx);
    expect(await readFixture(fixture, name)).toBe(out);
  });
});

describe('round 4: duplicate token restore', () => {
  it('restores every removed app_token line in place and order (CRLF too)', async () => {
    for (const eol of ['\n', '\r\n']) {
      const orig = `app_token=a${eol}x=1${eol}app_token=b${eol}y=2${eol}`;
      fixture = await makeFixture({ [FILE]: orig });
      await writeBugseePropertiesStep.apply(ctxFor('c'));
      const mid = await readFixture(fixture, FILE);
      expect(mid.match(/^app_token=/gm)).toHaveLength(1);
      await writeBugseePropertiesStep.rollback(ctxFor());
      expect(await readFixture(fixture, FILE)).toBe(orig);
      await cleanup(fixture);
    }
  });
});
