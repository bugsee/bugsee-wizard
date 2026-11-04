import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A clack prompt or intro/outro in --json / --non-interactive mode is a bug: those throw.
const clack = vi.hoisted(() => {
  const boom = (name: string) => () => {
    throw new Error(`clack.${name} called in non-interactive mode`);
  };
  return {
    intro: vi.fn(boom('intro')),
    outro: vi.fn(boom('outro')),
    cancel: vi.fn(boom('cancel')),
    note: vi.fn(boom('note')),
    confirm: vi.fn(boom('confirm')),
    select: vi.fn(boom('select')),
    password: vi.fn(boom('password')),
    isCancel: () => false,
    // logging (not prompting) through clack is allowed with --non-interactive alone
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
      step: vi.fn(),
      message: vi.fn(),
    },
  };
});
vi.mock('@clack/prompts', () => clack);

const git = vi.hoisted(() => ({ state: { repo: true, changed: [] as string[] } }));
const env = vi.hoisted(() => ({ value: {} as NodeJS.ProcessEnv }));

// The real JavaScript flow, with the network and git replaced; output comes from the command.
vi.mock('../../src/web/run.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/web/run.js')>();
  const { VITE_RECIPE } = await import('../web/run-helpers.js');
  return {
    ...actual,
    runJavaScriptInstall: (
      opts: Parameters<typeof actual.runJavaScriptInstall>[0],
      over: Parameters<typeof actual.runJavaScriptInstall>[1] = {},
    ) =>
      actual.runJavaScriptInstall(opts, {
        resolveRecipe: async () => ({ recipe: VITE_RECIPE, revision: 'r1', source: 'snapshot' }),
        resolveSdkVersion: async () => '0.1.0-beta.5',
        git: async () => git.state,
        env: env.value,
        ...over,
      }),
  };
});

import { runInstall } from '../../src/commands/install.js';
import { MissingInputError } from '../../src/engine/noninteractive.js';
import { baseOpts, type Sandbox, sandbox, TOKEN } from '../web/run-helpers.js';

let sb: Sandbox;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  git.state = { repo: true, changed: [] };
  env.value = { BUGSEE_APP_TOKEN: TOKEN };
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
    stdout.push(String(c));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((c) => {
    stderr.push(String(c));
    return true;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await sb?.cleanup();
});

/** stdout must be exactly one JSON document. */
const onlyJson = (): Record<string, unknown> => {
  for (const f of Object.values(clack.log)) expect(f).not.toHaveBeenCalled();
  const text = stdout.join('');
  expect(text.trim().split('\n')).toHaveLength(1);
  return JSON.parse(text) as Record<string, unknown>;
};

describe.skipIf(process.platform === 'win32')('runInstall --json', () => {
  it('success: one JSON object on stdout, exit 0, logs on stderr only', async () => {
    sb = await sandbox('vite-react-spa');
    await runInstall(baseOpts(sb.project, { json: true, nonInteractive: false }));
    const r = onlyJson();
    expect(r).toMatchObject({ ok: true, incomplete: false });
    expect(process.exitCode).toBe(0);
    expect(stderr.join('')).toContain('Install @bugsee/vite-plugin@beta');
    expect([...stdout, ...stderr].join('')).not.toContain(TOKEN);
  });

  it('--json --debug: the package manager output is forwarded to stderr, stdout stays one JSON', async () => {
    sb = await sandbox('vite-react-spa');
    await runInstall(baseOpts(sb.project, { json: true, debug: true }));
    expect(onlyJson()).toMatchObject({ ok: true });
    expect(stderr.join('')).toContain('added 1 package');
  });

  it('incomplete: exit 3 with the snippet in the JSON', async () => {
    sb = await sandbox('vite-react-spa');
    await writeFile(
      join(sb.project, 'vite.config.ts'),
      "import { defineConfig } from 'vite';\nimport base from './base';\nexport default defineConfig(base);\n",
    );
    // --json alone implies non-interactive, including exit code 3
    await runInstall(baseOpts(sb.project, { json: true, nonInteractive: false }));
    const r = onlyJson();
    expect(r).toMatchObject({ ok: true, incomplete: true });
    expect(r.snippets).toHaveLength(1);
    expect(process.exitCode).toBe(3);
  });

  it('failure: exit 1 with an error code', async () => {
    sb = await sandbox('vite-react-spa');
    git.state = { repo: true, changed: ['a.ts'] };
    await runInstall(baseOpts(sb.project, { json: true }));
    expect(onlyJson()).toMatchObject({ ok: false, error: 'dirty-git-tree' });
    expect(process.exitCode).toBe(1);
  });

  it('missing input propagates as MissingInputError (the CLI turns it into exit 2)', async () => {
    sb = await sandbox('vite-react-spa');
    env.value = {};
    await expect(runInstall(baseOpts(sb.project, { json: true }))).rejects.toEqual(
      new MissingInputError('token'),
    );
    expect(stdout.join('')).toBe('');
  });

  it('a native project is not supported non-interactively: exit 1, field names the kind', async () => {
    sb = await sandbox('react-native-app');
    await runInstall(baseOpts(sb.project, { nonInteractive: true, json: true }));
    expect(onlyJson()).toMatchObject({
      ok: false,
      error: 'unsupported-non-interactive',
      field: 'react-native',
    });
    expect(process.exitCode).toBe(1);
  });

  it('no detected project kind is MissingInputError(kind)', async () => {
    sb = await sandbox('non-js');
    await expect(runInstall(baseOpts(sb.project, { json: true }))).rejects.toEqual(
      new MissingInputError('kind'),
    );
  });

  it('--non-interactive without --json prints no JSON but sets the exit code', async () => {
    sb = await sandbox('vite-react-spa');
    git.state = { repo: false, changed: [] };
    await runInstall(baseOpts(sb.project, { nonInteractive: true, json: false }));
    expect(process.exitCode).toBe(1);
    expect(stdout.join('')).not.toContain('{"ok"');
  });
});
