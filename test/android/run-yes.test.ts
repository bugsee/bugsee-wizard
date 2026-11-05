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

const found = vi.hoisted(() => ({ paths: undefined as unknown }));
vi.mock('../../src/recipes/android/paths.js', () => ({
  discoverAndroidPaths: async () => found.paths,
}));

import { runAndroidRecipe } from '../../src/recipes/android/run.js';
import { cleanup, makeAndroidContext, makeFixture } from './helpers.js';

const MULTI_PROCESS_MANIFEST = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application android:process=":remote"><activity android:name=".Main"/></application>
</manifest>
`;

let dir: string;
const input = (over: Record<string, unknown> = {}) => ({
  cwd: dir,
  debug: false,
  dryRun: true,
  nonInteractive: false,
  json: false,
  ignoreGitChanges: false,
  yes: false,
  token: 'TOK',
  ...over,
});
const infos = () => clack.log.info.mock.calls.map((c) => String(c[0]));

beforeEach(async () => {
  vi.clearAllMocks();
  dir = await makeFixture({ 'app/src/main/AndroidManifest.xml': MULTI_PROCESS_MANIFEST });
  found.paths = makeAndroidContext({ cwd: dir, dsl: 'kotlin', dryRun: true }).androidPaths;
});
afterEach(() => cleanup(dir));

describe('runAndroidRecipe --yes', () => {
  it('takes every prompt default without asking: automatic init, no NDK/feedback/size analysis, the <provider> override', async () => {
    await runAndroidRecipe(input({ yes: true }));
    expect(clack.select).not.toHaveBeenCalled();
    expect(clack.confirm).not.toHaveBeenCalled();
    expect(clack.text).not.toHaveBeenCalled(); // the token came with the input
    const chosen = infos().filter((m) => m.includes('(--yes)'));
    expect(chosen).toEqual([
      expect.stringContaining('How should Bugsee initialize? Automatic'),
      expect.stringMatching(/NDK\) crash reporting\? No/),
      expect.stringMatching(/feedback module\? No/),
      expect.stringMatching(/size analysis\? No/),
      expect.stringContaining('How would you like to handle this? Add the <provider> override'),
    ]);
  });

  it('without --yes every one of those is still a question', async () => {
    clack.select.mockResolvedValueOnce('automatic').mockResolvedValueOnce('auto');
    clack.confirm.mockResolvedValue(false);
    await runAndroidRecipe(input());
    expect(clack.select).toHaveBeenCalledTimes(2);
    expect(clack.confirm).toHaveBeenCalledTimes(3);
    expect(infos().some((m) => m.includes('(--yes)'))).toBe(false);
  });
});
