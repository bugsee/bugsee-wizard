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
});
