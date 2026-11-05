import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
// the wizard probes \`pnpm add --help\` for --allow-build: this fake does not advertise it
if (args.includes('--help')) process.exit(0);
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
}

const ENV_STEP = `write-env-var:${ENV_FILE}:BUGSEE_APP_TOKEN`;
const GI_STEP = `ensure-gitignore:${ENV_FILE}`;
const TAIL: [string, string, string][] = [
  [ENV_STEP, 'applied', 'skipped'],
  [GI_STEP, 'applied', 'skipped'],
  ['ensure-gitignore:.bugsee/', 'applied', 'skipped'],
];

function pluginCase(
  id: string,
  fixture: string,
  pm: string,
  pkg: string,
  importName: string,
  config: string,
): Case {
  return {
    id,
    fixture,
    pm,
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

function cliCase(id: string, fixture: string, pm: string, file: string, tsc: boolean): Case {
  return {
    id,
    fixture,
    pm,
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
  ),
  pluginCase(
    'webpack',
    'webpack-app',
    'yarn',
    '@bugsee/webpack-plugin',
    'bugseeWebpackPlugin',
    'webpack.config.js',
  ),
  pluginCase(
    'rollup',
    'rollup-lib',
    'npm',
    '@bugsee/bundler-plugin-core',
    'bugseeRollupPlugin',
    'rollup.config.mjs',
  ),
  cliCase('cli', 'angular-spa', 'npm', 'package.json', false),
  cliCase('tsc', 'tsc-node', 'npm', 'tsconfig.json', true),
  cliCase('esbuild', 'esbuild-node', 'npm', 'package.json', false),
  cliCase('rspack', 'rspack-app', 'pnpm', 'package.json', false),
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
      expect(platforms).toEqual([`javascript-${c.id}`]);
      expect(first.ok).toBe(true);
      expect(outcomes(first)).toEqual(c.steps.map(([id, o]) => [id, o]));
      expect(first.incomplete).toBe(c.steps.some(([, o]) => o === 'manual'));
      const calls = (await sb.npmCalls()) as { pm?: string; args: string[] }[];
      expect(calls).toEqual([expect.objectContaining({ args: c.install })]);
      expect(calls[0]?.pm ?? 'npm').toBe(c.pm);
      for (const [file, needles] of c.contains) {
        const text = await readFile(join(sb.project, file), 'utf8');
        for (const n of needles) expect(text).toContain(n);
      }
      const installed = await tree(sb.project);

      const second = await runJavaScriptInstall(baseOpts(sb.project), deps());
      expect(second.ok).toBe(true);
      expect(outcomes(second)).toEqual(c.steps.map(([id, , o]) => [id, o]));
      expect(await tree(sb.project)).toEqual(installed);
      expect(await sb.npmCalls()).toHaveLength(1);

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

// referenced by the CLI-route cases
void SCRIPT_COMMAND;
void SCRIPT_NAME;
void SCRIPT_PATH;
void scriptTemplate;
