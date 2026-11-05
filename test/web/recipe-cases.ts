import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type OpSpec, parseRecipe, type Recipe } from '../../src/engine/recipe.js';
import { defaultSnapshotDir } from '../../src/engine/recipe-store.js';

/** The bundled snapshot's recipes, and exactly what each one must contain. */

export const SDK_RANGE = '>=0.1.0-beta.5';
export const SDK_VERSION = '0.1.0-beta.5';
export const ENV_FILE = '.env.bugsee-build-plugin';
export const SCRIPT_PATH = 'scripts/bugsee-sourcemaps.mjs';
export const SCRIPT_NAME = 'bugsee:sourcemaps';
export const SCRIPT_COMMAND = 'node scripts/bugsee-sourcemaps.mjs';

const TOKEN_OPS: OpSpec[] = [
  // the ignore rule first: nothing may leave the token file un-ignored, even if interrupted
  { op: 'ensure-gitignore', line: ENV_FILE },
  { op: 'write-env-var', file: ENV_FILE, key: 'BUGSEE_APP_TOKEN', from: 'token' },
];

function pluginOps(
  target: 'vite' | 'webpack' | 'rollup',
  pkg: string,
  importName: string,
): OpSpec[] {
  return [
    // the plugins' @bugsee/bugsee-cli dependency has the install script pnpm 11 wants decided
    {
      op: 'install-package',
      packages: [pkg],
      buildScripts: ['@bugsee/bugsee-cli'],
      dev: true,
      tag: 'beta',
    },
    {
      op: 'add-bundler-plugin',
      target,
      importFrom: pkg,
      importName,
      callArgs: '{ appToken: process.env.BUGSEE_APP_TOKEN }',
      ensureSourcemap: true,
    },
    ...TOKEN_OPS,
  ];
}

/** Ops of the CLI route; `template` is checked separately (it is the generated upload script). */
export function cliOps(extra: OpSpec[] = []): OpSpec[] {
  return [
    // @bugsee/cli has no `beta` dist-tag (only `latest`): installing @beta would fail
    { op: 'install-package', packages: ['@bugsee/cli'], dev: true },
    ...extra,
    { op: 'write-file', path: SCRIPT_PATH, template: expectTemplate },
    { op: 'add-package-script', name: SCRIPT_NAME, command: SCRIPT_COMMAND, chainInto: 'build' },
    ...TOKEN_OPS,
  ];
}

/** Placeholder replaced by the real template text when comparing (see snapshot.test.ts). */
export const expectTemplate = '<<template>>';

export const PLUGIN_IDS = ['vite', 'webpack', 'rollup'] as const;
export const CLI_IDS = ['tsc', 'esbuild', 'rspack', 'cli'] as const;
export const ALL_IDS = [...PLUGIN_IDS, ...CLI_IDS] as const;
export type RecipeKey = (typeof ALL_IDS)[number];

export const EXPECTED_OPS: Record<RecipeKey, OpSpec[]> = {
  vite: pluginOps('vite', '@bugsee/vite-plugin', 'bugseeVitePlugin'),
  webpack: pluginOps('webpack', '@bugsee/webpack-plugin', 'bugseeWebpackPlugin'),
  rollup: pluginOps('rollup', '@bugsee/bundler-plugin-core', 'bugseeRollupPlugin'),
  tsc: cliOps([
    {
      op: 'set-json-key',
      file: 'tsconfig.json',
      path: ['compilerOptions', 'sourceMap'],
      value: true,
    },
    {
      op: 'set-json-key',
      file: 'tsconfig.json',
      path: ['compilerOptions', 'inlineSources'],
      value: true,
    },
  ]),
  esbuild: cliOps(),
  rspack: cliOps(),
  cli: cliOps(),
};

/** Detection rules: what makes a project this recipe's. */
export const EXPECTED_DETECT: Record<RecipeKey, unknown[]> = {
  vite: [{ dependency: 'vite' }, { file: 'vite.config.ts' }],
  webpack: [{ dependency: 'webpack' }],
  rollup: [{ dependency: 'rollup' }],
  tsc: [{ dependency: 'typescript' }, { file: 'tsconfig.json' }],
  esbuild: [{ dependency: 'esbuild' }],
  rspack: [{ dependency: '@rspack/core' }],
  cli: [],
};

/** What every recipe's notes must mention. */
export const EXPECTED_NOTES: Record<RecipeKey, RegExp[]> = {
  vite: [/#182/, /BUGSEE_APP_TOKEN/],
  webpack: [/#182/, /BUGSEE_APP_TOKEN/],
  rollup: [/#182/, /BUGSEE_APP_TOKEN/],
  tsc: [/bugsee-cli/, /outDir|output directory/i],
  esbuild: [/#184/, /bugsee-cli/],
  rspack: [/#184/, /bugsee-cli/],
  cli: [/bugsee-cli/],
};

export const SNAPSHOT = defaultSnapshotDir();
export interface Index {
  schema: number;
  platform: string;
  entries: {
    range: string;
    revision: string;
    url: string;
    sha256: string;
    engineMin: string;
  }[];
}

export const readIndex = async (platform: string): Promise<Index> =>
  JSON.parse(await readFile(join(SNAPSHOT, platform, 'index.json'), 'utf8')) as Index;

export const readRecipeFile = async (
  platform: string,
): Promise<{ bytes: Buffer; recipe: Recipe }> => {
  const index = await readIndex(platform);
  const bytes = await readFile(join(SNAPSHOT, platform, index.entries[0]?.url ?? ''));
  return { bytes, recipe: parseRecipe(JSON.parse(bytes.toString('utf8'))) };
};

/** The upload script carried by a CLI-route recipe (the write-file template). */
export async function scriptTemplate(platform: string): Promise<string> {
  const { recipe } = await readRecipeFile(platform);
  const op = recipe.ops.find((o) => o.op === 'write-file');
  if (op?.op !== 'write-file') throw new Error(`${platform} has no write-file op`);
  return op.template;
}
