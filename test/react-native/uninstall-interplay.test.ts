import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The REAL native rollbacks of earlier wizards run here (not mocked): they act on the same files
// as the new Android/iOS steps, so the two sets must leave a user's own content alone.
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

import {
  runReactNativeRecipe,
  runReactNativeRollback,
} from '../../src/recipes/react-native/run.js';
import { cleanup, makeFixture, SAMPLE_APP_TSX } from './helpers.js';
import { BARE_ANDROID_FILES, BARE_IOS_FILES } from './native-fixtures.js';

let fixture: string;
afterEach(async () => {
  vi.clearAllMocks();
  await cleanup(fixture);
});

const opts = () => ({
  cwd: fixture,
  debug: false,
  dryRun: false,
  nonInteractive: false,
  json: false,
  ignoreGitChanges: false,
  yes: false,
});
async function tree(dir: string, rel = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
    const r = join(rel, e.name);
    if (e.isDirectory()) Object.assign(out, await tree(dir, r));
    else out[r] = await readFile(join(dir, r), 'utf8');
  }
  return out;
}
function answerAll(): void {
  clack.select.mockResolvedValue('both');
  clack.text.mockResolvedValue('TOKEN_1');
  clack.confirm.mockImplementation(async ({ message }: { message: string }) =>
    /Add the Bugsee launch|Apply the native edits/.test(message),
  );
}
const project = (extra: Record<string, string> = {}) => ({
  'package.json': JSON.stringify(
    { name: 'app', dependencies: { 'react-native': '0.83.0' } },
    null,
    2,
  ),
  'App.tsx': SAMPLE_APP_TSX,
  ...BARE_ANDROID_FILES,
  ...BARE_IOS_FILES,
  ...extra,
});

describe("uninstall: the new steps and the earlier wizards' rollbacks together", () => {
  it('restores every byte of a project set up by this version', async () => {
    fixture = await makeFixture(project());
    const original = await tree(fixture);
    answerAll();
    expect(await runReactNativeRecipe(opts())).toBe('ok');
    expect(await runReactNativeRollback(opts())).toBe('ok');
    expect(await tree(fixture)).toEqual(original);
  });

  it("keeps the user's own app_token (their own bugsee.properties) through install and uninstall", async () => {
    fixture = await makeFixture(
      project({ 'android/bugsee.properties': 'app_token=USER_OWN_TOKEN\nsomething=else\n' }),
    );
    const original = await tree(fixture);
    answerAll();
    expect(await runReactNativeRecipe(opts())).toBe('ok');
    expect(await runReactNativeRollback(opts())).toBe('ok');
    expect(await tree(fixture)).toEqual(original);
  });

  it("still runs the earlier wizards' native rollbacks on a project they set up (old package present)", async () => {
    fixture = await makeFixture(
      project({
        'package.json': JSON.stringify(
          {
            name: 'app',
            dependencies: { 'react-native': '0.83.0', 'react-native-bugsee': '^4.0.0' },
          },
          null,
          2,
        ),
        'android/bugsee.properties': 'app_token=OLD_WIZARD_TOKEN\nsomething=else\n',
      }),
    );
    expect(await runReactNativeRollback(opts())).toBe('ok');
    const after = await tree(fixture);
    expect(after['android/bugsee.properties']).not.toContain('app_token');
    expect(after['android/bugsee.properties']).toContain('something=else');
    expect(JSON.parse(after['package.json'] ?? '{}').dependencies).not.toHaveProperty(
      'react-native-bugsee',
    );
  });

  it("recognises an earlier wizard's install from its init block in the JS entry too", async () => {
    const legacyInit = `// bugsee:wizard:rn-init:begin\nimport Bugsee from 'react-native-bugsee';\n\nBugsee.initialize();\n// bugsee:wizard:rn-init:end\n`;
    fixture = await makeFixture(
      project({
        'App.tsx': `${legacyInit}${SAMPLE_APP_TSX}`,
        'android/bugsee.properties': 'app_token=OLD_WIZARD_TOKEN\n',
      }),
    );
    expect(await runReactNativeRollback(opts())).toBe('ok');
    const after = await tree(fixture);
    expect(after['App.tsx']).toBe(SAMPLE_APP_TSX);
    expect(after['android/bugsee.properties'] ?? '').not.toContain('app_token');
  });

  it('recognises the old package imported with double quotes, or required, in any entry file', async () => {
    for (const body of [
      `import Bugsee from "react-native-bugsee";\n${SAMPLE_APP_TSX}`,
      `const Bugsee = require('react-native-bugsee');\n${SAMPLE_APP_TSX}`,
    ]) {
      fixture = await makeFixture(
        project({ 'index.js': body, 'android/bugsee.properties': 'app_token=OLD\n' }),
      );
      expect(await runReactNativeRollback(opts())).toBe('ok');
      expect((await tree(fixture))['android/bugsee.properties'] ?? '', body).not.toContain(
        'app_token',
      );
      await cleanup(fixture);
    }
    fixture = await makeFixture(project());
  });

  it("recognises the old native recipes' own markers when the package and the JS block are gone", async () => {
    const oldApp = `${BARE_ANDROID_FILES['android/app/build.gradle']}\n// bugsee:wizard:apply-plugin:begin\napply plugin: 'com.bugsee.android.gradle'\n// bugsee:wizard:apply-plugin:end\n`;
    fixture = await makeFixture(
      project({
        'android/app/build.gradle': oldApp,
        'android/bugsee.properties': 'app_token=OLD\nsomething=else\n',
      }),
    );
    expect(await runReactNativeRollback(opts())).toBe('ok');
    const after = await tree(fixture);
    expect(after['android/app/build.gradle']).not.toContain('bugsee:wizard:apply-plugin');
    expect(after['android/bugsee.properties']).not.toContain('app_token');
  });

  it("this version's own markers (rn-*) are not mistaken for an earlier install", async () => {
    fixture = await makeFixture(project({ 'android/bugsee.properties': 'app_token=USER_OWN\n' }));
    answerAll();
    await runReactNativeRecipe(opts());
    // an older rollback would drop the app_token line of the user; the new one restores it
    expect(await runReactNativeRollback(opts())).toBe('ok');
    expect((await tree(fixture))['android/bugsee.properties']).toBe('app_token=USER_OWN\n');
  });

  it("finds an old install's marker in a large app: resources and assets do not use up the scan", async () => {
    const res: Record<string, string> = {};
    for (let i = 0; i < 900; i++) res[`android/aaa/res/layout/layout_${i}.xml`] = '<LinearLayout/>';
    const oldApp = `${BARE_ANDROID_FILES['android/app/build.gradle']}\n// bugsee:wizard:apply-plugin:begin\napply plugin: 'com.bugsee.android.gradle'\n// bugsee:wizard:apply-plugin:end\n`;
    fixture = await makeFixture(
      project({
        ...res,
        'android/app/build.gradle': oldApp,
        'android/bugsee.properties': 'app_token=OLD\n',
      }),
    );
    expect(await runReactNativeRollback(opts())).toBe('ok');
    expect((await tree(fixture))['android/app/build.gradle']).not.toContain(
      'bugsee:wizard:apply-plugin',
    );
  });

  it('finds the marker when many other native source files come first (files before subdirectories)', async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 700; i++) many[`ios/AAA/Generated/File${i}.h`] = '// generated';
    const oldDelegate =
      '// bugsee:wizard:launch:begin\nBugsee.launch(token: "x")\n// bugsee:wizard:launch:end\n';
    fixture = await makeFixture(project({ ...many, 'ios/AppDelegate.swift': oldDelegate }));
    expect(await runReactNativeRollback(opts())).toBe('ok');
    expect((await tree(fixture))['ios/AppDelegate.swift'] ?? '').not.toContain(
      'bugsee:wizard:launch',
    );
  });
});
