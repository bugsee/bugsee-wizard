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
vi.mock('../../src/recipes/ios/paths.js', () => ({
  discoverIosPaths: async () => found.paths,
}));

// these tests are about the final notes, not the file edits (the steps have their own tests)
vi.mock('../../src/core/step.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/step.js')>()),
  runSteps: async () => ({ failed: false, results: [] }),
}));

import { runIosRecipe } from '../../src/recipes/ios/run.js';
import { cleanup, makeFixture, makeIosContext } from './helpers.js';

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
  options: {
    distribution: 'spm',
    sizeAnalysis: false,
    sizeAnalysisAllConfigurations: false,
    autoInjectAppDelegate: false,
    runPodInstall: false,
  } as const,
  ...over,
});

beforeEach(async () => {
  vi.clearAllMocks();
  dir = await makeFixture({ placeholder: '' });
  const ctx = makeIosContext({ cwd: dir, schemeName: 'App', podfilePath: null, dryRun: true });
  found.paths = { ...ctx.iosPaths, availableSchemes: [ctx.iosPaths.scheme], appDelegate: null };
});
afterEach(() => cleanup(dir));

describe('runIosRecipe --dry-run', () => {
  it('prints no "Next steps" note: nothing was written', async () => {
    expect(await runIosRecipe(input({ dryRun: true }))).toBe('ok');
    expect(clack.note.mock.calls.map((c) => c[1])).not.toContain('Next steps');
  });
});
