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
  target: 'vite' | 'webpack' | 'rollup' | 'rspack' | 'esbuild',
  pkg: string,
  importName: string,
  ensureSourcemap = true,
): OpSpec[] {
  return [
    // the plugins' CLI dependency has the install script pnpm 11 wants decided: @bugsee/cli from 0.1.0-beta.7,
    // @bugsee/bugsee-cli before it (the recipe range covers both)
    {
      op: 'install-package',
      packages: [pkg],
      buildScripts: ['@bugsee/cli', '@bugsee/bugsee-cli'],
      dev: true,
      tag: 'beta',
    },
    {
      op: 'add-bundler-plugin',
      target,
      importFrom: pkg,
      importName,
      callArgs: '{ appToken: process.env.BUGSEE_APP_TOKEN }',
      ...(ensureSourcemap ? { ensureSourcemap: true } : {}),
    },
    ...TOKEN_OPS,
  ];
}

/** Ops of the CLI route; `template` is checked separately (it is the generated upload script). */
export function cliOps(extra: OpSpec[] = [], command = SCRIPT_COMMAND): OpSpec[] {
  return [
    // @bugsee/cli has no `beta` dist-tag (only `latest`): installing @beta would fail
    { op: 'install-package', packages: ['@bugsee/cli'], dev: true },
    ...extra,
    { op: 'write-file', path: SCRIPT_PATH, template: expectTemplate },
    { op: 'add-package-script', name: SCRIPT_NAME, command, chainInto: 'build' },
    ...TOKEN_OPS,
  ];
}

/** Placeholder replaced by the real template text when comparing (see snapshot.test.ts). */
export const expectTemplate = '<<template>>';

export const PLUGIN_IDS = ['vite', 'webpack', 'rollup', 'esbuild', 'rspack'] as const;
export const CLI_IDS = ['tsc', 'cli', 'nextjs'] as const;
/** Frameworks whose Vite config lives in the framework config: the plugin is installed, the wiring is a snippet. */
export const SNIPPET_IDS = ['nuxt', 'astro'] as const;
export const ALL_IDS = [...PLUGIN_IDS, ...CLI_IDS, ...SNIPPET_IDS] as const;
export type RecipeKey = (typeof ALL_IDS)[number];

const NUXT_CONFIGS = ['ts', 'js', 'mjs', 'mts', 'cjs', 'cts'].map((e) => `nuxt.config.${e}`);
const ASTRO_CONFIGS = ['mjs', 'ts', 'js', 'mts', 'cjs', 'cts'].map((e) => `astro.config.${e}`);

export const EXPECTED_OPS: Record<RecipeKey, OpSpec[]> = {
  vite: pluginOps('vite', '@bugsee/vite-plugin', 'bugseeVitePlugin'),
  webpack: pluginOps('webpack', '@bugsee/webpack-plugin', 'bugseeWebpackPlugin'),
  rollup: pluginOps('rollup', '@bugsee/bundler-plugin-core', 'bugseeRollupPlugin'),
  // the plugin sets esbuild's `sourcemap` itself, so there is no source-map hint to ensure
  esbuild: pluginOps('esbuild', '@bugsee/bundler-plugin-core', 'bugseeEsbuildPlugin', false),
  // Rspack writes no maps in production by default (devtool: false): the hint matters
  rspack: pluginOps('rspack', '@bugsee/bundler-plugin-core', 'bugseeRspackPlugin'),
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
  cli: cliOps(),
  // Next.js writes .next whatever bundles it (Turbopack by default in 16, webpack with --webpack)
  nextjs: cliOps([], 'node scripts/bugsee-sourcemaps.mjs .next'),
  nuxt: [
    {
      op: 'install-package',
      packages: ['@bugsee/vite-plugin'],
      buildScripts: ['@bugsee/cli', '@bugsee/bugsee-cli'],
      dev: true,
      tag: 'beta',
    },
    ...TOKEN_OPS,
    {
      op: 'show-snippet',
      file: 'nuxt.config.ts',
      title: 'Upload source maps from the Nuxt build (nuxt.config.ts)',
      code: [
        "import { bugseeVitePlugin } from '@bugsee/vite-plugin'; // bugsee-wizard",
        '',
        'export default defineNuxtConfig({',
        '  // ...your existing options',
        '  sourcemap: { client: true },',
        '  vite: {',
        '    plugins: [bugseeVitePlugin({ appToken: process.env.BUGSEE_APP_TOKEN })],',
        '  },',
        '});',
      ].join('\n'),
      doneWhen: { files: NUXT_CONFIGS, contains: '@bugsee/vite-plugin' },
    },
  ],
  astro: [
    {
      op: 'install-package',
      packages: ['@bugsee/vite-plugin'],
      buildScripts: ['@bugsee/cli', '@bugsee/bugsee-cli'],
      dev: true,
      tag: 'beta',
    },
    ...TOKEN_OPS,
    {
      op: 'show-snippet',
      file: 'astro.config.mjs',
      title: 'Upload source maps from the Astro build (astro.config.mjs)',
      code: [
        "import { bugseeVitePlugin } from '@bugsee/vite-plugin'; // bugsee-wizard",
        '',
        'export default defineConfig({',
        '  // ...your existing options',
        '  vite: {',
        '    build: { sourcemap: true },',
        '    plugins: [bugseeVitePlugin({ appToken: process.env.BUGSEE_APP_TOKEN })],',
        '  },',
        '});',
      ].join('\n'),
      doneWhen: { files: ASTRO_CONFIGS, contains: '@bugsee/vite-plugin' },
    },
  ],
};

/**
 * Recipes that kept an older revision for SDKs the newer one cannot serve: the esbuild and Rspack
 * plugins only upload from 0.1.0-beta.7 (issue #196), so r1 stays the CLI route for beta.5 and beta.6.
 */
export const OLD_RANGE = '>=0.1.0-beta.5 <0.1.0-beta.7';
export const NEW_RANGE = '>=0.1.0-beta.7';
export const TWO_REVISIONS = ['esbuild', 'rspack'] as const satisfies readonly RecipeKey[];
export const isTwoRevisions = (id: RecipeKey): boolean =>
  (TWO_REVISIONS as readonly string[]).includes(id);
export const CURRENT_REVISION = (id: RecipeKey): string => (isTwoRevisions(id) ? 'r2' : 'r1');
export const CURRENT_RANGE = (id: RecipeKey): string =>
  isTwoRevisions(id) ? NEW_RANGE : SDK_RANGE;
export const R1_OPS: Record<(typeof TWO_REVISIONS)[number], OpSpec[]> = {
  esbuild: cliOps(),
  rspack: cliOps(),
};
export const R1_NOTES: Record<(typeof TWO_REVISIONS)[number], RegExp[]> = {
  esbuild: [/#184/, /bugsee-cli/, /0\.1\.0-beta\.7/],
  rspack: [/#184/, /bugsee-cli/, /0\.1\.0-beta\.7/],
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
  nextjs: [{ dependency: 'next' }],
  nuxt: [{ dependency: 'nuxt' }],
  astro: [{ dependency: 'astro' }],
};

const PLUGIN_NOTES = [
  /\.env\.bugsee-build-plugin/,
  /0\.1\.0-beta\.7/,
  /BUGSEE_APP_TOKEN/,
  /allowBuilds/,
  // the plugin deletes the maps it uploaded, and does nothing without a token
  /deleteMaps: false/,
  /does nothing without an app token/,
  /Subresource Integrity/,
  // the guard only sees hashes pinned in emitted HTML: the note must not promise more
  /in its emitted HTML/,
  /not detected/,
];
const CLI_NOTES = [/bugsee-cli/, /does not delete the \.map files/];

/** What every recipe's notes must mention. */
export const EXPECTED_NOTES: Record<RecipeKey, RegExp[]> = {
  vite: PLUGIN_NOTES,
  webpack: PLUGIN_NOTES,
  rollup: PLUGIN_NOTES,
  esbuild: [
    ...PLUGIN_NOTES,
    /bugseeEsbuildPlugin/,
    /@bugsee\/bundler-plugin-core/,
    /no config file/,
    /build\(\) or context\(\)/,
    // what the plugin does not cover
    /tsup is NOT covered/,
    /Angular/,
    /Bun's bundler/,
    /tsc/,
  ],
  rspack: [
    ...PLUGIN_NOTES,
    /bugseeRspackPlugin/,
    /@bugsee\/bundler-plugin-core/,
    /devtool: 'source-map'/,
    /devtool: false/,
  ],
  tsc: [...CLI_NOTES, /outDir|output directory/i],
  cli: [...CLI_NOTES, /tsup/, /sourcemap: true/, /--sourcemap=external/],
  nextjs: [
    /bugsee-cli/,
    /Turbopack/,
    /--webpack/,
    /productionBrowserSourceMaps: true/,
    /\.next/,
    /distDir/,
    /Bugsee Next\.js config wrapper/,
    /\.next\/static/,
  ],
  nuxt: [...PLUGIN_NOTES, /nuxt\.config/, /vite\.plugins/, /\.output\/server/, /Nitro/],
  astro: [...PLUGIN_NOTES, /astro\.config/, /vite\.build\.sourcemap/, /does not load \.env/],
};

/** Every build-tool recipe ends the run with how to confirm symbolication (the SDK has no doctor command to point at). */
export const EXPECTED_VERIFY: RegExp[] = [
  /production build/,
  /not the dev server/,
  /test error/,
  /Bugsee dashboard/,
  /original files, functions and lines/,
];

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

/** The newest revision of a platform (or the named one): its bytes and the parsed recipe. */
export const readRecipeFile = async (
  platform: string,
  revision?: string,
): Promise<{ bytes: Buffer; recipe: Recipe }> => {
  const index = await readIndex(platform);
  const entry =
    revision === undefined
      ? [...index.entries].sort(
          (a, b) => Number(b.revision.slice(1)) - Number(a.revision.slice(1)),
        )[0]
      : index.entries.find((e) => e.revision === revision);
  const bytes = await readFile(join(SNAPSHOT, platform, entry?.url ?? ''));
  return { bytes, recipe: parseRecipe(JSON.parse(bytes.toString('utf8'))) };
};

/** The upload script carried by a CLI-route recipe (the write-file template). */
export async function scriptTemplate(platform: string, revision?: string): Promise<string> {
  const { recipe } = await readRecipeFile(platform, revision);
  const op = recipe.ops.find((o) => o.op === 'write-file');
  if (op?.op !== 'write-file') throw new Error(`${platform} has no write-file op`);
  return op.template;
}

/** Runtime recipes: install the SDK package and initialise it in the entry file. */
export const RUNTIME_IDS = ['browser-vite', 'browser', 'node', 'bun'] as const;
export type RuntimeKey = (typeof RUNTIME_IDS)[number];

const runtimeEnvOps = (file: string, key: string): OpSpec[] => [
  { op: 'ensure-gitignore', line: file },
  { op: 'write-env-var', file, key, from: 'token' },
];

export const EXPECTED_RUNTIME_OPS: Record<RuntimeKey, OpSpec[]> = {
  'browser-vite': [
    { op: 'install-package', packages: ['@bugsee/bugsee'], tag: 'beta', installScripts: false },
    ...runtimeEnvOps('.env.local', 'VITE_BUGSEE_APP_TOKEN'),
    {
      op: 'add-sdk-init',
      runtime: 'browser',
      importFrom: '@bugsee/bugsee',
      tokenExpr: 'import.meta.env.VITE_BUGSEE_APP_TOKEN',
    },
  ],
  browser: [
    { op: 'install-package', packages: ['@bugsee/bugsee'], tag: 'beta', installScripts: false },
    { op: 'add-sdk-init', runtime: 'browser', importFrom: '@bugsee/bugsee' },
  ],
  node: [
    { op: 'install-package', packages: ['@bugsee/bugsee'], tag: 'beta', installScripts: false },
    ...runtimeEnvOps('.env', 'BUGSEE_APP_TOKEN'),
    {
      op: 'add-sdk-init',
      runtime: 'node',
      importFrom: '@bugsee/bugsee',
      tokenExpr: 'process.env.BUGSEE_APP_TOKEN',
    },
  ],
  bun: [
    { op: 'install-package', packages: ['@bugsee/bun'], tag: 'beta', installScripts: false },
    ...runtimeEnvOps('.env', 'BUGSEE_APP_TOKEN'),
    {
      op: 'add-sdk-init',
      runtime: 'bun',
      importFrom: '@bugsee/bun',
      tokenExpr: 'process.env.BUGSEE_APP_TOKEN',
    },
  ],
};

export const EXPECTED_RUNTIME_NOTES: Record<RuntimeKey, RegExp[]> = {
  'browser-vite': [/VITE_BUGSEE_APP_TOKEN/, /CI/],
  browser: [/entry file/, /not a secret/],
  node: [/--env-file/, /BUGSEE_APP_TOKEN/],
  bun: [/loads it|loads from \.env|automatically/, /@bugsee\/bun/],
};

/** Framework recipes: the adapter package is installed, its wiring is handed back as snippets. */
export const FRAMEWORK_IDS = ['nuxt', 'sveltekit', 'astro', 'remix'] as const;
export type FrameworkKey = (typeof FRAMEWORK_IDS)[number];

const adapter = (pkg: string): OpSpec => ({
  op: 'install-package',
  packages: [pkg],
  tag: 'beta',
  installScripts: false,
});
const CFG_EXTS = ['ts', 'js', 'mjs', 'mts', 'cjs', 'cts'];
const ENTRY_EXTS = ['tsx', 'jsx', 'ts', 'js'];
const files = (base: string, exts: string[]): string[] => exts.map((e) => `${base}.${e}`);

/** The wiring each SDK package documents (packages/<name>/README.md in bugsee-javascript). */
export const EXPECTED_FRAMEWORK_OPS: Record<FrameworkKey, OpSpec[]> = {
  nuxt: [
    adapter('@bugsee/nuxt'),
    ...runtimeEnvOps('.env', 'BUGSEE_APP_TOKEN'),
    {
      op: 'show-snippet',
      file: 'nuxt.config.ts',
      title: 'Register the Bugsee module (nuxt.config.ts)',
      code: [
        'export default defineNuxtConfig({',
        "  modules: ['@bugsee/nuxt'],",
        '  bugsee: {',
        '    appToken: process.env.BUGSEE_APP_TOKEN,',
        '  },',
        '});',
      ].join('\n'),
      doneWhen: { files: files('nuxt.config', CFG_EXTS), contains: '@bugsee/nuxt' },
    },
  ],
  astro: [
    adapter('@bugsee/astro'),
    {
      op: 'show-snippet',
      file: 'astro.config.mjs',
      title: 'Add the Bugsee integration (astro.config.mjs)',
      code: [
        "import { bugsee } from '@bugsee/astro'; // bugsee-wizard",
        '',
        'export default defineConfig({',
        "  integrations: [bugsee({ appToken: process.env.BUGSEE_APP_TOKEN, runtime: 'node' })],",
        '});',
      ].join('\n'),
      doneWhen: { files: files('astro.config', CFG_EXTS), contains: '@bugsee/astro' },
    },
  ],
  sveltekit: [
    adapter('@bugsee/sveltekit'),
    ...runtimeEnvOps('.env', 'PUBLIC_BUGSEE_TOKEN'),
    {
      op: 'show-snippet',
      file: 'src/hooks.server.ts',
      title: 'Wire the Bugsee server hooks (src/hooks.server.ts)',
      code: [
        "import { sequence } from '@sveltejs/kit/hooks';",
        "import { registerServer } from '@bugsee/sveltekit/server';",
        "import { handle as bugseeHandle, handleErrorWithBugsee } from '@bugsee/sveltekit';",
        '',
        'registerServer(process.env.BUGSEE_APP_TOKEN!);',
        '',
        'export const handle = sequence(bugseeHandle);',
        'export const handleError = handleErrorWithBugsee();',
      ].join('\n'),
      doneWhen: {
        files: ['src/hooks.server.ts', 'src/hooks.server.js'],
        contains: '@bugsee/sveltekit',
      },
    },
    {
      op: 'show-snippet',
      file: 'src/hooks.client.ts',
      title: 'Wire the Bugsee client hooks (src/hooks.client.ts)',
      code: [
        "import { PUBLIC_BUGSEE_TOKEN } from '$env/static/public';",
        "import { registerClient, handleErrorWithBugsee } from '@bugsee/sveltekit/client';",
        '',
        'registerClient(PUBLIC_BUGSEE_TOKEN);',
        '',
        'export const handleError = handleErrorWithBugsee();',
      ].join('\n'),
      doneWhen: {
        files: ['src/hooks.client.ts', 'src/hooks.client.js'],
        contains: '@bugsee/sveltekit',
      },
    },
  ],
  remix: [
    adapter('@bugsee/remix'),
    ...runtimeEnvOps('.env.local', 'VITE_BUGSEE_TOKEN'),
    {
      op: 'show-snippet',
      file: 'app/entry.server.tsx',
      title: 'Wire the Bugsee server entry (app/entry.server.tsx)',
      code: [
        "import { registerServer } from '@bugsee/remix/server';",
        '',
        'registerServer(process.env.BUGSEE_APP_TOKEN!);',
        '',
        "export { handleError } from '@bugsee/remix';",
      ].join('\n'),
      // the call, not the import: an import alone leaves the server unregistered
      doneWhen: { files: files('app/entry.server', ENTRY_EXTS), contains: 'registerServer(' },
    },
    {
      op: 'show-snippet',
      file: 'app/entry.client.tsx',
      title: 'Wire the Bugsee client entry (app/entry.client.tsx)',
      code: [
        "import { registerClient, bugseeOnError } from '@bugsee/remix/client';",
        '',
        'registerClient(import.meta.env.VITE_BUGSEE_TOKEN);',
        '',
        '// React Router framework mode: pass the handler to the router:',
        'hydrateRoot(document, <HydratedRouter onError={bugseeOnError} />);',
        '',
        '// Remix v2: keep your <RemixBrowser /> hydration as it is, and report from your root',
        '// ErrorBoundary (app/root.tsx) instead:',
        "// import { captureRemixErrorBoundaryError } from '@bugsee/remix/client';",
        '// export function ErrorBoundary() {',
        '//   const error = useRouteError();',
        '//   captureRemixErrorBoundaryError(error);',
        '//   return <YourErrorPage />;',
        '// }',
      ].join('\n'),
      doneWhen: { files: files('app/entry.client', ENTRY_EXTS), contains: 'registerClient(' },
    },
  ],
};

export const EXPECTED_FRAMEWORK_DETECT: Record<FrameworkKey, unknown[]> = {
  nuxt: [{ dependency: 'nuxt' }],
  astro: [{ dependency: 'astro' }],
  sveltekit: [{ dependency: '@sveltejs/kit' }],
  remix: [{ dependency: 'react-router' }],
};

export const EXPECTED_FRAMEWORK_NOTES: Record<FrameworkKey, RegExp[]> = {
  nuxt: [/@bugsee\/nuxt/, /BUGSEE_APP_TOKEN/, /\.env/, /not a secret/, /instead of editing/],
  astro: [/@bugsee\/astro/, /does not load \.env/, /runtime: 'edge'/, /not a secret/],
  sveltekit: [
    /@bugsee\/sveltekit/,
    /PUBLIC_BUGSEE_TOKEN/,
    /does not copy \.env into process\.env/,
    /registerServerEdge/,
    /not a secret/,
  ],
  remix: [
    /@bugsee\/remix/,
    /VITE_BUGSEE_TOKEN/,
    /react-router reveal/,
    /remix reveal/,
    /captureRemixErrorBoundaryError/,
    /not a secret/,
  ],
};
