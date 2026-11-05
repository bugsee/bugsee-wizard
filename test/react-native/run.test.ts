import { chmod, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clack = vi.hoisted(() => ({
  note: vi.fn(),
  cancel: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(),
  isCancel: (v: unknown) => v === Symbol.for('cancel'),
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), error: vi.fn() }),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), step: vi.fn() },
}));
vi.mock('@clack/prompts', () => clack);

vi.mock('../../src/recipes/android/run.js', () => ({
  runAndroidRollback: vi.fn(async () => 'ok'),
}));
vi.mock('../../src/recipes/ios/run.js', () => ({ runIosRollback: vi.fn(async () => 'ok') }));

import { _resetPodOnPathCache } from '../../src/recipes/ios/pod.js';
import { _resetManagerOnPathCache } from '../../src/recipes/react-native/package-manager.js';
import {
  runReactNativeRecipe,
  runReactNativeRollback,
} from '../../src/recipes/react-native/run.js';
import {
  cleanup,
  makeFixture,
  readFixture,
  SAMPLE_APP_TSX,
  SAMPLE_RN_PACKAGE_JSON,
} from './helpers.js';
import { BARE_ANDROID_FILES, BARE_IOS_FILES } from './native-fixtures.js';

let fixture: string;
const opts = (over: Record<string, unknown> = {}) => ({
  cwd: fixture,
  debug: false,
  dryRun: false,
  nonInteractive: false,
  json: false,
  ignoreGitChanges: false,
  yes: false,
  ...over,
});

/** The confirmations by what they ask about; anything not listed is answered "no". */
interface Answers {
  inject?: boolean;
  install?: boolean;
  native?: boolean;
  pod?: boolean;
}
function answer(a: Answers = {}): void {
  clack.select.mockResolvedValue('both');
  clack.text.mockResolvedValue('TOKEN');
  clack.confirm.mockImplementation(async ({ message }: { message: string }) => {
    if (/Add the Bugsee launch/.test(message)) return a.inject ?? true;
    // the question reads differently when the manager is not on this machine's PATH
    if (/`(?:npm|yarn|pnpm|bun) install` now/.test(message)) return a.install ?? false;
    if (/Apply the native edits/.test(message)) return a.native ?? false;
    if (/pod install/.test(message)) return a.pod ?? false;
    throw new Error(`unexpected question: ${message}`);
  });
}
const messages = (fn: { mock: { calls: unknown[][] } }): string[] =>
  fn.mock.calls.map((c) => String((c[0] as { message?: string })?.message ?? c[0]));
const logged = (fn: { mock: { calls: unknown[][] } }): string =>
  fn.mock.calls.map((c) => String(c[0])).join('\n');

const rnPackage = (extra: Record<string, string> = {}, rn = '0.83.0') =>
  JSON.stringify({ name: 'app', dependencies: { 'react-native': rn, ...extra } }, null, 2);

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  _resetPodOnPathCache();
  _resetManagerOnPathCache();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanup(fixture);
});

describe('runReactNativeRecipe: what it refuses', () => {
  it('stops at the old react-native-bugsee, which @bugsee/react-native replaces, and touches nothing', async () => {
    fixture = await makeFixture({
      'package.json': rnPackage({ 'react-native-bugsee': '^6.0.0' }),
      'App.tsx': SAMPLE_APP_TSX,
      'android/.keep': '',
    });
    answer();
    expect(await runReactNativeRecipe(opts())).toBe('failed');
    const error = logged(clack.log.error);
    expect(error).toContain('react-native-bugsee');
    expect(error).toContain('@bugsee/react-native');
    expect(error).toMatch(/not an upgrade in place/);
    expect(clack.confirm).not.toHaveBeenCalled();
    expect(clack.text).not.toHaveBeenCalled();
    expect(await readFixture(fixture, 'App.tsx')).toBe(SAMPLE_APP_TSX);
    expect(JSON.parse(await readFixture(fixture, 'package.json')).dependencies).not.toHaveProperty(
      '@bugsee/react-native',
    );
  });

  it('stops below React Native 0.81, naming the version found', async () => {
    fixture = await makeFixture({ 'package.json': rnPackage({}, '0.76.7'), 'android/.keep': '' });
    answer();
    expect(await runReactNativeRecipe(opts())).toBe('failed');
    expect(logged(clack.log.error)).toMatch(/0\.81.*found 0\.76\.7/);
    expect(clack.text).not.toHaveBeenCalled();
  });

  it('does not refuse a version it cannot know (a tag): that is checked at install', async () => {
    fixture = await makeFixture({
      'package.json': rnPackage({}, 'latest'),
      'App.tsx': SAMPLE_APP_TSX,
      'android/.keep': '',
    });
    answer();
    expect(await runReactNativeRecipe(opts())).toBe('ok');
  });

  it('fails when there is nothing native to set up and it is not an Expo project', async () => {
    fixture = await makeFixture({ 'package.json': rnPackage() });
    expect(await runReactNativeRecipe(opts())).toBe('failed');
    expect(logged(clack.log.warn)).toContain('No `android/` or `ios/`');
  });
});

describe('runReactNativeRecipe: the JS side', () => {
  it('says up front that @bugsee/react-native is a beta whose API can still change', async () => {
    fixture = await makeFixture({
      'package.json': rnPackage(),
      'App.tsx': SAMPLE_APP_TSX,
      'android/.keep': '',
    });
    answer();
    await runReactNativeRecipe(opts());
    expect(logged(clack.log.info)).toMatch(
      /@bugsee\/react-native[\s\S]*beta[\s\S]*API can still change/,
    );
  });

  it('shows the plain version in the beta notice (no range caret)', async () => {
    fixture = await makeFixture({
      'package.json': rnPackage(),
      'App.tsx': SAMPLE_APP_TSX,
      'android/.keep': '',
    });
    answer();
    await runReactNativeRecipe(opts());
    expect(logged(clack.log.info)).toContain('(7.0.0-beta3)');
    expect(logged(clack.log.info)).not.toContain('^7.0.0-beta3');
  });

  it('adds @bugsee/react-native and the JS launch, with the token per platform', async () => {
    fixture = await makeFixture({
      'package.json': rnPackage(),
      'App.tsx': SAMPLE_APP_TSX,
      'android/.keep': '',
      'ios/App.xcodeproj/project.pbxproj': '',
    });
    answer();
    clack.text.mockImplementation(async ({ message }: { message: string }) =>
      /iOS/.test(message) ? 'IOS_T' : 'AND_T',
    );
    expect(await runReactNativeRecipe(opts())).toBe('ok');
    expect(JSON.parse(await readFixture(fixture, 'package.json')).dependencies).toMatchObject({
      '@bugsee/react-native': '^7.0.0-beta3',
    });
    const app = await readFixture(fixture, 'App.tsx');
    expect(app).toContain(`import Bugsee from '@bugsee/react-native'`);
    expect(app).toContain(`BugseePlatform.OS === 'ios' ? 'IOS_T' : 'AND_T'`);
    expect(app).not.toContain('Bugsee.initialize');
  });

  it('with only an Android directory it is not asked which platform, and asks one token', async () => {
    fixture = await makeFixture({
      'package.json': rnPackage(),
      'App.tsx': SAMPLE_APP_TSX,
      'android/.keep': '',
    });
    answer();
    await runReactNativeRecipe(opts());
    expect(clack.select).not.toHaveBeenCalled();
    expect(messages(clack.text)).toEqual(['Bugsee app token (Android)']);
  });

  it('prints the snippet instead when the launch is not auto-added', async () => {
    fixture = await makeFixture({
      'package.json': rnPackage(),
      'App.tsx': SAMPLE_APP_TSX,
      'android/.keep': '',
    });
    answer({ inject: false });
    await runReactNativeRecipe(opts());
    expect(await readFixture(fixture, 'App.tsx')).toBe(SAMPLE_APP_TSX);
    expect(logged(clack.note)).toContain("if (Platform.OS === 'android') {");
  });

  it('prints the snippet when there is no JS entry even though the launch was accepted', async () => {
    fixture = await makeFixture({ 'package.json': rnPackage(), 'android/.keep': '' });
    answer({ inject: true });
    await runReactNativeRecipe(opts());
    expect(logged(clack.note)).toContain("if (Platform.OS === 'android') {");
  });

  it('the printed snippet never carries a placeholder token for a platform that was not picked', async () => {
    fixture = await makeFixture({
      'package.json': rnPackage(),
      'App.tsx': SAMPLE_APP_TSX,
      'android/.keep': '',
    });
    answer({ inject: false });
    clack.select.mockResolvedValue('android');
    await runReactNativeRecipe(opts());
    const out = logged(clack.note);
    expect(out).toContain("  Bugsee.launch('TOKEN');");
    expect(out).not.toMatch(/<(IOS|ANDROID)_TOKEN>/);
  });

  it('prints the snippet when the entry file cannot be read, as the step promised', async () => {
    fixture = await makeFixture({
      'package.json': rnPackage(),
      'App.tsx/keep': '', // App.tsx exists but is a directory: not readable as a file
      'android/.keep': '',
    });
    answer({ inject: true });
    expect(await runReactNativeRecipe(opts())).toBe('ok');
    expect(logged(clack.note)).toContain('Bugsee.launch(');
  });

  it('does not print the snippet when the launch is already in the entry file', async () => {
    fixture = await makeFixture({
      'package.json': rnPackage(),
      'App.tsx': SAMPLE_APP_TSX,
      'android/.keep': '',
    });
    answer({ inject: true });
    clack.text.mockResolvedValue('TOK');
    await runReactNativeRecipe(opts());
    vi.clearAllMocks();
    answer({ inject: true });
    clack.text.mockResolvedValue('TOK');
    await runReactNativeRecipe(opts()); // second run: the exact block is there, nothing to hand over
    const done = clack.note.mock.calls.find((c) => c[1] === 'Done')?.[0] as string;
    expect(done).not.toContain('Add to your App.tsx');
  });

  it('summarises what is left: install, pod install, the native edits, the requirements', async () => {
    fixture = await makeFixture({
      'package.json': rnPackage(),
      'App.tsx': SAMPLE_APP_TSX,
      'android/.keep': '',
      'ios/App.xcodeproj/project.pbxproj': '',
    });
    answer({ install: false, native: false });
    await runReactNativeRecipe(opts());
    const done = clack.note.mock.calls.find((c) => c[1] === 'Done')?.[0] as string;
    expect(done).toContain('install` to fetch @bugsee/react-native');
    expect(done).toContain('pod install');
    expect(done).toContain('native edits');
    expect(done).toContain('New Architecture and Hermes');
    expect(done).toContain('Bugsee.wrap(App)');
  });

  it('from React Native 0.87 iOS needs no pod install: SPM resolves the SDK', async () => {
    fixture = await makeFixture({
      'package.json': rnPackage({}, '0.87.1'),
      'App.tsx': SAMPLE_APP_TSX,
      'ios/App.xcodeproj/project.pbxproj': '',
    });
    answer({ install: false });
    await runReactNativeRecipe(opts());
    expect(messages(clack.confirm).some((m) => /pod install/.test(m))).toBe(false);
  });

  it('a dry run writes nothing', async () => {
    fixture = await makeFixture({
      'package.json': rnPackage(),
      'App.tsx': SAMPLE_APP_TSX,
      'android/.keep': '',
    });
    answer();
    expect(await runReactNativeRecipe(opts({ dryRun: true }))).toBe('ok');
    expect(await readFixture(fixture, 'App.tsx')).toBe(SAMPLE_APP_TSX);
    expect(JSON.parse(await readFixture(fixture, 'package.json')).dependencies).not.toHaveProperty(
      '@bugsee/react-native',
    );
  });

  it('a dry run prints no "Done" summary or snippets, and says nothing was changed', async () => {
    fixture = await makeFixture({
      'package.json': rnPackage(),
      'App.tsx': SAMPLE_APP_TSX,
      'android/.keep': '',
    });
    answer({ inject: false });
    expect(await runReactNativeRecipe(opts({ dryRun: true }))).toBe('ok');
    expect(clack.note.mock.calls.map((c) => c[1])).not.toContain('Done');
    expect(logged(clack.log.info)).toContain('Dry run: nothing was changed.');
  });
});

describe('runReactNativeRecipe: Expo', () => {
  const appJson = JSON.stringify({ expo: { name: 'app', plugins: ['expo-router'] } }, null, 2);

  it('adds the config plugin to app.json: both platforms, no platform question, no native edits asked', async () => {
    fixture = await makeFixture({
      'package.json': rnPackage({ expo: '~55.0.0' }),
      'app.json': appJson,
      'App.tsx': SAMPLE_APP_TSX,
    });
    answer();
    clack.text.mockImplementation(async ({ message }: { message: string }) =>
      /iOS/.test(message) ? 'IOS_T' : 'AND_T',
    );
    expect(await runReactNativeRecipe(opts())).toBe('ok');
    expect(clack.select).not.toHaveBeenCalled();
    expect(messages(clack.confirm).some((m) => /native edits/.test(m))).toBe(false);
    const plugins = JSON.parse(await readFixture(fixture, 'app.json')).expo.plugins;
    expect(plugins[0]).toBe('expo-router');
    expect(plugins[1]).toEqual([
      '@bugsee/react-native',
      { appToken: { ios: 'IOS_T', android: 'AND_T' } },
    ]);
  });

  it("an Expo project with prebuilt android/ and ios/ gets the config plugin only: the native files are the plugin's to write", async () => {
    fixture = await makeFixture({
      'package.json': rnPackage({ expo: '~55.0.0' }),
      'app.json': appJson,
      'App.tsx': SAMPLE_APP_TSX,
      ...BARE_ANDROID_FILES,
      ...BARE_IOS_FILES,
    });
    const original = await tree(fixture);
    answer({ native: true });
    expect(await runReactNativeRecipe(opts())).toBe('ok');
    const after = await tree(fixture);
    for (const file of Object.keys(original)) {
      if (file.startsWith('android/') || file.startsWith('ios/'))
        expect(after[file], file).toBe(original[file]);
    }
    expect(Object.keys(after).filter((f) => /bugsee\.properties|xcode\.env/.test(f))).toEqual([]);
    expect(JSON.parse(after['app.json'] ?? '{}').expo.plugins).toHaveLength(2);
  });

  it('tells an Expo user what else matters: prebuild for committed native dirs, no Expo Go', async () => {
    fixture = await makeFixture({
      'package.json': rnPackage({ expo: '~55.0.0' }),
      'app.json': appJson,
      'App.tsx': SAMPLE_APP_TSX,
    });
    answer();
    await runReactNativeRecipe(opts());
    const done = clack.note.mock.calls.find((c) => c[1] === 'Done')?.[0] as string;
    expect(done).toContain('expo prebuild');
    expect(done).toContain('Expo Go');
  });

  it('prints the plugin snippet when the config is app.config.js, which it cannot edit', async () => {
    fixture = await makeFixture({
      'package.json': rnPackage({ expo: '~55.0.0' }),
      'app.config.js': 'module.exports = {};\n',
      'App.tsx': SAMPLE_APP_TSX,
    });
    answer();
    expect(await runReactNativeRecipe(opts())).toBe('ok');
    const note = clack.note.mock.calls.find((c) => c[1] === 'Expo config plugin')?.[0] as string;
    expect(note).toContain('@bugsee/react-native');
    expect(note).toContain('app.json');
  });
});

describe('runReactNativeRecipe --yes', () => {
  it('takes every default without asking, and still asks for the tokens', async () => {
    fixture = await makeFixture({
      'package.json': rnPackage(),
      'App.tsx': SAMPLE_APP_TSX,
      ...BARE_ANDROID_FILES,
      ...BARE_IOS_FILES,
    });
    // the default is to install when the manager is on PATH and to run pod install when pod is:
    // fakes, no network
    const bin = await mkdtemp(join(tmpdir(), 'rn-yes-bin-'));
    for (const name of ['npm', 'pod']) {
      await writeFile(join(bin, name), '#!/bin/sh\nexit 0\n');
      await chmod(join(bin, name), 0o755);
    }
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    clack.text.mockResolvedValue('TOKEN');
    await runReactNativeRecipe(opts({ yes: true }));
    expect(clack.select).not.toHaveBeenCalled();
    expect(clack.confirm).not.toHaveBeenCalled();
    expect(clack.text).toHaveBeenCalledTimes(2);
    expect(await readFixture(fixture, 'App.tsx')).toContain('Bugsee.launch(');
    // and the native edits it defaults to
    expect(await readFixture(fixture, 'android/app/build.gradle')).toContain(
      'com.bugsee.android.gradle',
    );
    expect(await readFixture(fixture, 'ios/.xcode.env.local')).toContain('BUGSEE_TOKEN_IOS');
  }, 30_000);
});

/** Every file under a directory, by relative path. */
async function tree(dir: string, rel = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
    const r = join(rel, e.name);
    if (e.isDirectory()) Object.assign(out, await tree(dir, r));
    else out[r] = await readFile(join(dir, r), 'utf8');
  }
  return out;
}

describe('runReactNativeRecipe: a bare app with the native edits', () => {
  const bare = () => ({
    'package.json': rnPackage(),
    'App.tsx': SAMPLE_APP_TSX,
    ...BARE_ANDROID_FILES,
    ...BARE_IOS_FILES,
  });

  it('edits Android and iOS, changes nothing the second time, and uninstall restores every byte', async () => {
    fixture = await makeFixture(bare());
    const original = await tree(fixture);
    answer({ native: true });
    clack.text.mockImplementation(async ({ message }: { message: string }) =>
      /iOS/.test(message) ? 'IOS_TOKEN_1' : 'AND_TOKEN_1',
    );

    expect(await runReactNativeRecipe(opts())).toBe('ok');
    const installed = await tree(fixture);
    expect(installed['android/build.gradle']).toContain(
      "id 'com.bugsee.android.gradle' version '4.0.8'",
    );
    expect(installed['android/app/build.gradle']).toContain('bugsee-sourcemaps.gradle');
    expect(installed['android/bugsee.properties']).toContain('app_token=AND_TOKEN_1');
    expect(installed['ios/MyApp.xcodeproj/project.pbxproj']).toContain('bugsee-xcode.sh');
    expect(installed['ios/.xcode.env.local']).toContain('BUGSEE_TOKEN_IOS=IOS_TOKEN_1');
    // each token only where it belongs: the Android token never reaches iOS files, nor the reverse
    for (const [file, text] of Object.entries(installed)) {
      if (file.startsWith('ios/') && file !== 'ios/.xcode.env.local')
        expect(text, file).not.toContain('IOS_TOKEN_1');
      if (file.startsWith('android/') && file !== 'android/bugsee.properties')
        expect(text, file).not.toContain('AND_TOKEN_1');
    }

    expect(await runReactNativeRecipe(opts())).toBe('ok');
    expect(await tree(fixture)).toEqual(installed);

    expect(await runReactNativeRollback(opts())).toBe('ok');
    expect(await tree(fixture)).toEqual(original);
  });

  it('a file it cannot edit becomes a manual snippet; the rest still applies', async () => {
    const files: Record<string, string> = bare();
    delete files['android/app/build.gradle'];
    fixture = await makeFixture(files);
    answer({ native: true });
    expect(await runReactNativeRecipe(opts())).toBe('ok');
    const note = clack.note.mock.calls.find((c) => /app\/build\.gradle/.test(String(c[0])));
    expect(note).toBeDefined();
    expect(await readFixture(fixture, 'ios/.xcode.env.local')).toContain('BUGSEE_TOKEN_IOS');
  });

  it('a step that fails rolls everything back, the package edit included', async () => {
    fixture = await makeFixture(bare());
    const original = await tree(fixture);
    // npm exists (a fake), pod does not: the pod install the user asked for is blocked
    const bin = await mkdtemp(join(tmpdir(), 'rn-fail-bin-'));
    await writeFile(join(bin, 'npm'), '#!/bin/sh\nexit 0\n');
    await chmod(join(bin, 'npm'), 0o755);
    vi.stubEnv('PATH', bin);
    answer({ native: true, install: true, pod: true });
    expect(await runReactNativeRecipe(opts())).toBe('failed');
    expect(await tree(fixture)).toEqual(original);
    // the install ran and package.json is back: say how to clear node_modules and the lockfile
    expect(logged(clack.log.warn)).toMatch(/node_modules[\s\S]*npm remove @bugsee\/react-native/);
  });

  it('a failure never removes a dependency the user already had (and does not suggest removing it)', async () => {
    const files = bare();
    files['package.json'] = rnPackage({ '@bugsee/react-native': '^7.0.0-beta3' });
    fixture = await makeFixture(files);
    const original = await tree(fixture);
    const bin = await mkdtemp(join(tmpdir(), 'rn-fail2-bin-'));
    await writeFile(join(bin, 'npm'), '#!/bin/sh\nexit 0\n');
    await chmod(join(bin, 'npm'), 0o755);
    vi.stubEnv('PATH', bin);
    answer({ native: true, install: true, pod: true });
    expect(await runReactNativeRecipe(opts())).toBe('failed');
    expect(await tree(fixture)).toEqual(original);
    expect(logged(clack.log.warn)).not.toContain('npm remove');
  });

  it('under pnpm it reminds that React Native needs nodeLinker: hoisted', async () => {
    fixture = await makeFixture({ ...bare(), 'pnpm-lock.yaml': 'lockfileVersion: 9\n' });
    answer({ native: false });
    await runReactNativeRecipe(opts());
    const done = clack.note.mock.calls.find((c) => c[1] === 'Done')?.[0] as string;
    expect(done).toContain('nodeLinker: hoisted');
  });

  it('warns when the New Architecture is switched off (Android gradle.properties)', async () => {
    fixture = await makeFixture({
      ...bare(),
      'android/gradle.properties': 'org.gradle.jvmargs=-Xmx2g\nnewArchEnabled=false\n',
    });
    answer({ native: false });
    await runReactNativeRecipe(opts());
    expect(logged(clack.log.warn)).toMatch(/New Architecture/);
  });

  it('warns when the New Architecture is switched off in a prebuilt Expo project (Podfile.properties.json)', async () => {
    fixture = await makeFixture({
      'package.json': rnPackage({ expo: '~55.0.0' }),
      'app.json': JSON.stringify({ expo: { plugins: [] } }),
      'ios/Podfile.properties.json': JSON.stringify({ newArchEnabled: 'false' }),
      'App.tsx': SAMPLE_APP_TSX,
    });
    answer();
    await runReactNativeRecipe(opts());
    expect(logged(clack.log.warn)).toMatch(/New Architecture/);
  });

  it('warns when the New Architecture is switched off (app.json)', async () => {
    fixture = await makeFixture({
      'package.json': rnPackage({ expo: '~55.0.0' }),
      'app.json': JSON.stringify({ expo: { newArchEnabled: false, plugins: [] } }),
      'App.tsx': SAMPLE_APP_TSX,
    });
    answer();
    await runReactNativeRecipe(opts());
    expect(logged(clack.log.warn)).toMatch(/New Architecture/);
  });

  it('does not tell a 0.87+ app to pod install just because the package install was declined; an older one is told', async () => {
    fixture = await makeFixture({
      'package.json': rnPackage({}, '0.87.1'),
      'App.tsx': SAMPLE_APP_TSX,
      'ios/App.xcodeproj/project.pbxproj': '',
    });
    answer({ install: false });
    await runReactNativeRecipe(opts());
    let done = clack.note.mock.calls.find((c) => c[1] === 'Done')?.[0] as string;
    expect(done).not.toContain('Run `pod install`');
    expect(done).toContain('Swift Package Manager');
    await cleanup(fixture);
    vi.clearAllMocks();
    fixture = await makeFixture({
      'package.json': rnPackage({}, '0.83.0'),
      'App.tsx': SAMPLE_APP_TSX,
      'ios/App.xcodeproj/project.pbxproj': '',
    });
    answer({ install: false });
    await runReactNativeRecipe(opts());
    done = clack.note.mock.calls.find((c) => c[1] === 'Done')?.[0] as string;
    expect(done).toContain('Run `pod install`');
  });

  it('without the native edits it leaves the Android and iOS files alone', async () => {
    fixture = await makeFixture(bare());
    const original = await tree(fixture);
    answer({ native: false });
    expect(await runReactNativeRecipe(opts())).toBe('ok');
    const after = await tree(fixture);
    for (const file of Object.keys(original)) {
      if (file.startsWith('android/') || file.startsWith('ios/'))
        expect(after[file], file).toBe(original[file]);
    }
    expect(Object.keys(after).filter((f) => /bugsee|xcode\.env/.test(f))).toEqual([]);
  });
});

void SAMPLE_RN_PACKAGE_JSON;
