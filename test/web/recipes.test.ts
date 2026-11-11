import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WizardOptions } from '../../src/core/context.js';
import type { WizardRunResult } from '../../src/engine/noninteractive.js';
import { type RecipeQuery, resolveRecipe } from '../../src/engine/recipe-store.js';
import { runJavaScriptInstall } from '../../src/web/run.js';
import { runJavaScriptUninstall } from '../../src/web/uninstall.js';
import {
  ENV_FILE,
  SCRIPT_COMMAND,
  SCRIPT_NAME,
  SCRIPT_PATH,
  scriptTemplate,
} from './recipe-cases.js';
import {
  baseOpts,
  captureOutput,
  makeDeps,
  type Sandbox,
  sandbox,
  TOKEN,
  tree,
} from './run-helpers.js';

/**
 * Every bundled recipe, end to end: the REAL detection picks the platform, the REAL recipe store
 * resolves it from the bundled snapshot (the network is unreachable), the real ops run against a
 * temp copy of the fixture with a fake package manager. Install, re-run, uninstall.
 */

/** A fake yarn / pnpm / bun (npm comes from run-helpers): records argv, edits package.json and its lockfile. */
const FAKE_PM = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
// the wizard asks \`pnpm --version\` to decide on approving install scripts: this fake stays silent
if (args.includes('--version')) {
  if (process.env.FAKE_PNPM_VERSION) console.log(process.env.FAKE_PNPM_VERSION);
  process.exit(0);
}
fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify({ pm: name, args, cwd: process.cwd() }) + '\\n');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const field = args.includes('-D') ? 'devDependencies' : 'dependencies';
pkg[field] = pkg[field] || {};
for (const a of args.filter((x) => x !== 'add' && !x.startsWith('-'))) {
  const at = a.lastIndexOf('@');
  pkg[field][at > 0 ? a.slice(0, at) : a] = '0.1.0-beta.9';
}
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\\n');
const lock = { yarn: 'yarn.lock', pnpm: 'pnpm-lock.yaml' }[name];
fs.appendFileSync(lock, '# ' + args.join(' ') + '\\n');
`;

async function withFakePms(sb: Sandbox): Promise<void> {
  for (const pm of ['yarn', 'pnpm']) {
    await writeFile(join(sb.root, 'bin', pm), FAKE_PM);
    await chmod(join(sb.root, 'bin', pm), 0o755);
  }
}

const offline: typeof fetch = async () => {
  throw new TypeError('fetch failed (offline in tests)');
};

/** The real store, against the bundled snapshot, with the network unreachable. */
function realStore(platforms: string[]) {
  return async (q: RecipeQuery) => {
    platforms.push(q.platform);
    return resolveRecipe({ ...q, baseUrl: 'http://127.0.0.1:9/', fetchImpl: offline });
  };
}

interface Case {
  id: string;
  fixture: string;
  pm: string;
  install: string[];
  /** Per step id: first-run outcome, second-run outcome. */
  steps: [string, string, string][];
  /** Files and what they must contain after the first run. */
  contains: [string, string[]][];
  /** The runtime recipe (SDK install + init) that runs first, when the project is a plain runtime. */
  runtime?: Runtime;
  /** The runtime recipe is skipped (a framework, a library): an unfinished `add-sdk-init` step. */
  runtimeSkipped?: boolean;
}

interface Runtime {
  platform: string;
  steps: [string, string, string][];
  install: string[];
  contains: [string, string[]][];
}

const applied = (id: string): [string, string, string] => [id, 'applied', 'skipped'];

/** What the runtime recipes do on a fixture whose entry file is `entry`. */
function runtimeCase(
  kind: 'browser-vite' | 'browser' | 'node',
  pm: string,
  entry: string,
  needles: string[],
): Runtime {
  const envFile = kind === 'browser-vite' ? '.env.local' : '.env';
  const key = kind === 'browser-vite' ? 'VITE_BUGSEE_APP_TOKEN' : 'BUGSEE_APP_TOKEN';
  const withEnv = kind !== 'browser';
  return {
    platform: `javascript-${kind}`,
    install: [pm === 'npm' ? 'install' : 'add', '@bugsee/bugsee@beta'],
    steps: [
      applied('install-package:@bugsee/bugsee'),
      ...(withEnv
        ? [applied(`ensure-gitignore:${envFile}`), applied(`write-env-var:${envFile}:${key}`)]
        : []),
      applied(`add-sdk-init:${kind === 'node' ? 'node' : 'browser'}`),
    ],
    contains: [
      [entry, ['// bugsee-wizard', ...needles]],
      ...(withEnv ? ([[envFile, [`${key}=${TOKEN}`]]] as [string, string[]][]) : []),
    ],
  };
}

const ENV_STEP = `write-env-var:${ENV_FILE}:BUGSEE_APP_TOKEN`;
const GI_STEP = `ensure-gitignore:${ENV_FILE}`;
const TAIL: [string, string, string][] = [
  [GI_STEP, 'applied', 'skipped'],
  [ENV_STEP, 'applied', 'skipped'],
  ['ensure-gitignore:.bugsee/', 'applied', 'skipped'],
];

function pluginCase(
  id: string,
  fixture: string,
  pm: string,
  pkg: string,
  importName: string,
  config: string,
  runtime?: Runtime,
  runtimeSkipped?: boolean,
): Case {
  return {
    id,
    fixture,
    pm,
    ...(runtime ? { runtime } : {}),
    ...(runtimeSkipped ? { runtimeSkipped } : {}),
    install: [pm === 'npm' ? 'install' : 'add', '-D', `${pkg}@beta`],
    steps: [
      [`install-package:${pkg}`, 'applied', 'skipped'],
      // the plugin goes in; the source-map switch is left to the user (a manual hint, every run)
      [`add-bundler-plugin:${id}`, 'manual', 'manual'],
      ...TAIL,
    ],
    contains: [
      [config, [pkg, `${importName}({ appToken: process.env.BUGSEE_APP_TOKEN })`]],
      [ENV_FILE, [`BUGSEE_APP_TOKEN=${TOKEN}`]],
      ['.gitignore', [ENV_FILE, '.bugsee/']],
    ],
  };
}

function cliCase(
  id: string,
  fixture: string,
  pm: string,
  file: string,
  tsc: boolean,
  runtime?: Runtime,
  runtimeSkipped?: boolean,
): Case {
  return {
    id,
    fixture,
    pm,
    ...(runtime ? { runtime } : {}),
    ...(runtimeSkipped ? { runtimeSkipped } : {}),
    install: [pm === 'npm' ? 'install' : 'add', '-D', '@bugsee/cli'],
    steps: [
      ['install-package:@bugsee/cli', 'applied', 'skipped'],
      ...(tsc
        ? ([
            ['set-json-key:tsconfig.json#compilerOptions.sourceMap', 'applied', 'skipped'],
            ['set-json-key:tsconfig.json#compilerOptions.inlineSources', 'applied', 'skipped'],
          ] as [string, string, string][])
        : []),
      [`write-file:${SCRIPT_PATH}`, 'applied', 'skipped'],
      [`add-package-script:${SCRIPT_NAME}`, 'applied', 'skipped'],
      ...TAIL,
    ],
    contains: [
      [file, tsc ? ['inlineSources'] : [SCRIPT_NAME]],
      [SCRIPT_PATH, ['bugsee-cli', 'sourcemaps']],
      [ENV_FILE, [`BUGSEE_APP_TOKEN=${TOKEN}`]],
    ],
  };
}

const CASES: Case[] = [
  pluginCase(
    'vite',
    'vite-react-spa',
    'npm',
    '@bugsee/vite-plugin',
    'bugseeVitePlugin',
    'vite.config.ts',
    runtimeCase('browser-vite', 'npm', 'src/main.tsx', [
      '/// <reference types="vite/client" />',
      'launch(import.meta.env.VITE_BUGSEE_APP_TOKEN);',
    ]),
  ),
  pluginCase(
    'webpack',
    'webpack-app',
    'yarn',
    '@bugsee/webpack-plugin',
    'bugseeWebpackPlugin',
    'webpack.config.js',
    runtimeCase('browser', 'yarn', 'src/index.js', [`launch('${TOKEN}');`]),
  ),
  pluginCase(
    'rollup',
    'rollup-lib',
    'npm',
    '@bugsee/bundler-plugin-core',
    'bugseeRollupPlugin',
    'rollup.config.mjs',
    undefined,
    true,
  ),
  // a framework: no runtime recipe yet, only the build tool's
  cliCase('cli', 'angular-spa', 'npm', 'package.json', false, undefined, true),
  cliCase(
    'tsc',
    'tsc-node',
    'npm',
    'tsconfig.json',
    true,
    runtimeCase('node', 'npm', 'src/index.ts', [
      'if (process.env.BUGSEE_APP_TOKEN) launch(process.env.BUGSEE_APP_TOKEN);',
    ]),
  ),
  cliCase(
    'esbuild',
    'esbuild-node',
    'npm',
    'package.json',
    false,
    runtimeCase('node', 'npm', 'src/index.js', ['launch(process.env.BUGSEE_APP_TOKEN);']),
  ),
  cliCase(
    'rspack',
    'rspack-app',
    'pnpm',
    'package.json',
    false,
    runtimeCase('browser', 'pnpm', 'src/index.js', [`launch('${TOKEN}');`]),
  ),
];

function outcomes(r: WizardRunResult): [string, string][] {
  return r.steps.map((s) => [s.id, s.outcome]);
}

describe.skipIf(process.platform === 'win32')('bundled recipes, end to end', () => {
  let sb: Sandbox | undefined;
  afterEach(async () => {
    await sb?.cleanup();
    sb = undefined;
  });

  describe.each(CASES)('javascript-$id on $fixture', (c) => {
    it('first run applies, second run changes nothing, uninstall restores the tree', async () => {
      sb = await sandbox(c.fixture);
      await withFakePms(sb);
      const original = await tree(sb.project);

      const platforms: string[] = [];
      const deps = () => makeDeps(captureOutput(), { resolveRecipe: realStore(platforms) });

      const first = await runJavaScriptInstall(baseOpts(sb.project), deps());
      const steps: [string, string, string][] = [
        ...(c.runtimeSkipped
          ? ([['add-sdk-init', 'manual', 'manual']] as [string, string, string][])
          : []),
        ...(c.runtime?.steps ?? []),
        ...c.steps,
      ];
      expect(platforms).toEqual([...(c.runtime ? [c.runtime.platform] : []), `javascript-${c.id}`]);
      expect(first.ok).toBe(true);
      expect(outcomes(first)).toEqual(steps.map(([id, o]) => [id, o]));
      expect(first.incomplete).toBe(steps.some(([, o]) => o === 'manual'));
      const calls = (await sb.npmCalls()) as { pm?: string; args: string[] }[];
      expect(calls).toEqual([
        ...(c.runtime ? [expect.objectContaining({ args: c.runtime.install })] : []),
        expect.objectContaining({ args: c.install }),
      ]);
      for (const call of calls) expect(call.pm ?? 'npm').toBe(c.pm);
      for (const [file, needles] of [...(c.runtime?.contains ?? []), ...c.contains]) {
        const text = await readFile(join(sb.project, file), 'utf8');
        for (const n of needles) expect(text).toContain(n);
      }
      const installed = await tree(sb.project);

      const second = await runJavaScriptInstall(baseOpts(sb.project), deps());
      expect(second.ok).toBe(true);
      expect(outcomes(second)).toEqual(steps.map(([id, , o]) => [id, o]));
      expect(await tree(sb.project)).toEqual(installed);
      expect(await sb.npmCalls()).toHaveLength(calls.length);

      const un = await runJavaScriptUninstall(
        baseOpts(sb.project, { yes: true }),
        makeDeps(captureOutput()),
      );
      expect(un.ok).toBe(true);
      expect(un.incomplete).toBe(false);
      expect(await tree(sb.project)).toEqual(original);
    });
  });
});

describe.skipIf(process.platform === 'win32')(
  'pnpm 11 install-script approval, through the run',
  () => {
    let sb: Sandbox | undefined;
    afterEach(async () => {
      delete process.env.FAKE_PNPM_VERSION;
      await sb?.cleanup();
      sb = undefined;
    });
    const interactive = (project: string, over: Partial<WizardOptions> = {}) =>
      baseOpts(project, { yes: false, nonInteractive: false, ...over });

    it('asks the user, edits pnpm-workspace.yaml on yes, and uninstall takes it back out', async () => {
      sb = await sandbox('rspack-app');
      await withFakePms(sb);
      process.env.FAKE_PNPM_VERSION = '11.3.0';
      const original = await tree(sb.project);
      const asked: string[] = [];
      const confirm = vi.fn(async (m: string) => {
        asked.push(m);
        return true;
      });
      const deps = () =>
        makeDeps(captureOutput(), {
          resolveRecipe: realStore([]),
          prompts: { confirm, select: vi.fn() },
        });
      const first = await runJavaScriptInstall(interactive(sb.project), deps());
      expect(first.ok).toBe(true);
      const approval = asked.filter((m) => m.includes('allowBuilds'));
      expect(approval).toHaveLength(1);
      expect(approval[0]).toContain('@bugsee/cli');
      expect(await readFile(join(sb.project, 'pnpm-workspace.yaml'), 'utf8')).toMatch(
        /@bugsee\/cli['"]: true/,
      );
      const second = await runJavaScriptInstall(interactive(sb.project), deps());
      expect(second.ok).toBe(true);
      expect(asked.filter((m) => m.includes('allowBuilds'))).toHaveLength(1); // no second question
      const un = await runJavaScriptUninstall(
        baseOpts(sb.project, { yes: true }),
        makeDeps(captureOutput()),
      );
      expect(un.ok).toBe(true);
      expect(await tree(sb.project)).toEqual(original);
    });

    it('non-interactive without --yes leaves pnpm-workspace.yaml alone', async () => {
      sb = await sandbox('rspack-app');
      await withFakePms(sb);
      process.env.FAKE_PNPM_VERSION = '11.3.0';
      const confirm = vi.fn(async () => true);
      const r = await runJavaScriptInstall(
        baseOpts(sb.project, { yes: false, nonInteractive: true }),
        makeDeps(captureOutput(), {
          resolveRecipe: realStore([]),
          prompts: { confirm, select: vi.fn() },
        }),
      );
      expect(r.ok).toBe(true); // the fake pnpm succeeds: the real one would fail with the hint
      expect(confirm).not.toHaveBeenCalled();
      await expect(readFile(join(sb.project, 'pnpm-workspace.yaml'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  },
);

// referenced by the CLI-route cases
void SCRIPT_COMMAND;
void SCRIPT_NAME;
void SCRIPT_PATH;
void scriptTemplate;
