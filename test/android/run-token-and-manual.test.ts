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

const ran = vi.hoisted(() => ({ steps: [] as { id: string }[], tokens: undefined as unknown }));
vi.mock('../../src/core/step.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/step.js')>()),
  runSteps: async (steps: { id: string }[], ctx: { tokens: unknown }) => {
    ran.steps = steps;
    ran.tokens = ctx.tokens;
    return { failed: false, results: [] };
  },
}));

import { validateAppToken } from '../../src/core/token.js';
import { runAndroidRecipe } from '../../src/recipes/android/run.js';
import { cleanup, makeAndroidContext, makeFixture } from './helpers.js';

let dir: string;
const MULTI =
  '<manifest><application android:process=":main"><service android:process=":svc"/></application></manifest>';
const input = (
  over: Record<string, unknown> = {},
  initMode: 'automatic' | 'manual' = 'automatic',
) => ({
  cwd: dir,
  debug: false,
  dryRun: false,
  nonInteractive: false,
  json: false,
  ignoreGitChanges: false,
  yes: false,
  token: 'TOK',
  options: { initMode, ndk: false, feedback: false, sizeAnalysis: false },
  ...over,
});

beforeEach(async () => {
  vi.clearAllMocks();
  ran.steps = [];
  ran.tokens = undefined;
  dir = await makeFixture({ 'app/src/main/AndroidManifest.xml': MULTI });
  found.paths = makeAndroidContext({ cwd: dir, dsl: 'kotlin' }).androidPaths;
});
afterEach(() => cleanup(dir));

describe('validateAppToken', () => {
  it.each(['', '   ', undefined])('rejects empty %j', (v) => {
    expect(validateAppToken(v)).toBe('Token is required');
  });
  it.each(['"abc"', "'abc'", 'a b', 'abc;rm', 'a\nb'])('rejects %j', (v) => {
    expect(validateAppToken(v)).toMatch(/alphanumeric/);
  });
  it.each(['abc-DEF_1.2', '  abc123  '])('accepts %j', (v) => {
    expect(validateAppToken(v)).toBeUndefined();
  });
});

describe('android recipe token validation', () => {
  it('fails early on a bad input.token without running steps', async () => {
    expect(await runAndroidRecipe(input({ token: '"abc"' }))).toBe('failed');
    expect(clack.log.error).toHaveBeenCalledWith(
      expect.stringContaining('Invalid Bugsee app token'),
    );
    expect(ran.steps).toEqual([]);
  });

  it('wires the prompt validator to the shared check and trims the answer', async () => {
    clack.text.mockResolvedValueOnce('  good-token  ');
    clack.select.mockResolvedValue('snippet');
    expect(await runAndroidRecipe(input({ token: undefined }))).toBe('ok');
    const validate = clack.text.mock.calls[0]?.[0].validate;
    expect(validate('"x"')).toMatch(/alphanumeric/);
    expect(validate('')).toBe('Token is required');
    expect(ran.tokens).toEqual({ android: 'good-token' });
  });
});

describe('multi-process handling by init mode', () => {
  it('automatic: asks the picker and notes component processes', async () => {
    clack.select.mockResolvedValue('auto');
    await runAndroidRecipe(input());
    expect(clack.select).toHaveBeenCalledTimes(1);
    expect(ran.steps.map((s) => s.id)).toContain('android.inject-provider-override');
    expect(clack.note.mock.calls.filter((c) => c[1] === 'Multi-process detected')).toHaveLength(2);
  });

  it('manual: no picker, no provider override step, no auto-init noise, launch-gating note stays', async () => {
    await runAndroidRecipe(input({}, 'manual'));
    expect(clack.select).not.toHaveBeenCalled();
    expect(ran.steps.map((s) => s.id)).not.toContain('android.inject-provider-override');
    expect(clack.note.mock.calls.some((c) => c[1] === 'Multi-process detected')).toBe(false);
    const next = clack.note.mock.calls.find((c) => c[1] === 'Next steps');
    expect(next?.[0]).toContain('gate Bugsee.launch on the process name');
  });
});
