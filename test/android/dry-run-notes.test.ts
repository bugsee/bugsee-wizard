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

// these tests are about the final notes, not the file edits (the steps have their own tests)
vi.mock('../../src/core/step.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/step.js')>()),
  runSteps: async () => ({ failed: false, results: [] }),
}));

import { runAndroidRecipe } from '../../src/recipes/android/run.js';
import { cleanup, makeAndroidContext, makeFixture } from './helpers.js';

let dir: string;
const input = (over: Record<string, unknown> = {}) => ({
  cwd: dir,
  debug: false,
  dryRun: false,
  nonInteractive: false,
  json: false,
  ignoreGitChanges: false,
  yes: false,
  token: 'TOK',
  options: { initMode: 'automatic', ndk: false, feedback: false, sizeAnalysis: false } as const,
  ...over,
});

beforeEach(async () => {
  vi.clearAllMocks();
  dir = await makeFixture({
    'app/src/main/AndroidManifest.xml': '<manifest><application/></manifest>',
  });
  found.paths = makeAndroidContext({ cwd: dir, dsl: 'kotlin', dryRun: true }).androidPaths;
});
afterEach(() => cleanup(dir));

describe('runAndroidRecipe --dry-run', () => {
  it('prints no "Done" / "Next steps" note: nothing was written, so there is nothing to sync', async () => {
    expect(await runAndroidRecipe(input({ dryRun: true }))).toBe('ok');
    const titles = clack.note.mock.calls.map((c) => c[1]);
    expect(titles).not.toContain('Done');
    expect(titles).not.toContain('Next steps');
  });
});
