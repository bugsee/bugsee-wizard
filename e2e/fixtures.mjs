// Real-project fixtures for the end-to-end suite (e2e/run.test.ts).
//
// The fixtures are the sample apps of bugsee/bugsee-javascript at a PINNED ref. They are taken with
// `git archive`, so only tracked files are copied (no node_modules, dist, .env, build counters).
// The samples are written to test the SDK from a local pre-publish registry and several of them
// already carry Bugsee build tooling, so each copy is sanitized into "a project that uses the
// Bugsee SDK from npm but has no Bugsee source-map tooling yet" — the state the wizard starts from:
//
//   all samples   every `file:../../.local-registry/*.tgz` @bugsee dependency is either removed
//                 (build tooling: vite-plugin, webpack-plugin, bundler-plugin-core, cli) or pinned
//                 to the public npm version of the `beta` dist-tag (runtime SDK packages);
//                 pnpm-workspace.yaml loses its local-registry `overrides`, the
//                 `minimumReleaseAgeExclude` entries for the unpublished 0.0.0 @bugsee packages and
//                 any `allowBuilds` entry for a Bugsee package (react-spa and webpack-sourcemaps
//                 pre-approve `@bugsee/bugsee-cli`, the bundler plugins' CLI dependency).
//   react-spa     vite.config.ts: the `bugseeVitePlugin` import and its plugins[] entry are removed.
//   webpack-...   webpack.config.js: the `bugseeWebpackPlugin` import and its plugins[] entry are
//                 removed (the variables that only fed it stay; they are harmless).
//   angular-spa   src/app/bugsee.ts: one `as never` cast — a sample type bug that fails `ng build`
//                 against the published SDK (see SOURCE_EDITS); unrelated to Bugsee build tooling.
//   vue-spa, svelte-spa, node-service: package.json and pnpm-workspace.yaml only.
//
// Two VARIANTS are not samples as such: `vite-object-config` (react-spa) and
// `webpack-object-config` (webpack-sourcemaps) replace the bundler config with the plain object
// form a project generator writes. Every sample config is a function (`defineConfig(({ mode }) =>
// ...)`, `export default (env, argv) => ...`), which the wizard deliberately leaves to the user
// (outcome `manual`), so without the variants the automatic plugin wiring and its build-time upload
// would never run end to end.
//
// SYNTHETIC fixtures (`synthetic: true`) are not samples at all: no sample uses tsc, esbuild, rspack
// or rollup as its build, so each of those recipes gets a minimal project committed under
// e2e/fixtures/<name>/ (package.json with real dependencies, source, config, .gitignore). They are
// pnpm projects like the samples, so one install path and the same install-script approvals serve
// every fixture. Their @bugsee/* dependencies are written as `beta` and pinned to the exact version
// like the samples' (no lockfile is committed: it would pin a stale SDK).
//   tsc-build      `tsc -p tsconfig.json` into lib/ (an outDir other than dist), no source-map
//                  options: the recipe sets sourceMap/inlineSources itself
//   esbuild-build  the esbuild CLI, --sourcemap, --outdir=dist
//   rspack-build   @rspack/cli + @rspack/core, devtool 'source-map', output.path dist
//   rollup-build   an object-form rollup.config.mjs with output.sourcemap, so the wizard wires
//                  bugseeRollupPlugin itself (plugin route, upload at build time)
//
// pnpm >= 10 refuses to run dependency install scripts that are not approved, and pnpm 11 FAILS the
// install (ERR_PNPM_IGNORED_BUILDS). Both Bugsee CLI packages have one (the binary download).
// Unless `{ approveBuilds: false }` is passed, the fixture approves them in pnpm-workspace.yaml up
// front, as a developer who answered `pnpm approve-builds` would have; see run.test.ts for the
// unapproved case.
//
// Then `pnpm install` (so a lockfile exists: the wizard needs one to pick the package manager) and
// `git init` + one commit, so `git status`/`git diff` measure exactly what the wizard changes.
//
// Environment:
//   BUGSEE_JS_REPO      a local bugsee-javascript checkout to archive from (must contain the ref);
//                       without it the pinned ref is fetched from GitHub into a cache directory
//   BUGSEE_JS_REF       override the pinned ref
//   BUGSEE_SDK_VERSION  the @bugsee/* version to pin (default: the npm `beta` dist-tag)
//
// CLI: `node e2e/fixtures.mjs <name> <dest>` prepares one fixture (handy when debugging by hand).

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

/** bugsee/bugsee-javascript `chore(release): 0.1.0-beta.5 (#180)`. */
export const PINNED_REF = '5037d0f8b743200194f809cb22862ca8ae3fac4e';
const REPO_URL = 'https://github.com/bugsee/bugsee-javascript.git';

/** Build tooling the wizard is expected to add; it must not be in the fixture beforehand. */
const TOOLING = new Set([
  '@bugsee/vite-plugin',
  '@bugsee/webpack-plugin',
  '@bugsee/bundler-plugin-core',
  '@bugsee/cli',
]);

/**
 * What the e2e suite expects of each fixture.
 *   recipe  the recipe the wizard must pick (its id)
 *   runtime the runtime recipe (SDK install + init) it must pick before it; null: none (a framework)
 *   route   'plugin': the bundler plugin uploads at build time; 'cli': the generated script does
 *   outDir  the build output holding the source maps (null: the project has no build)
 *   synthetic  the fixture is e2e/fixtures/<name>/, not a sample
 */
export const FIXTURES = {
  'react-spa': {
    runtime: 'javascript-browser-vite',
    recipe: 'javascript-vite',
    route: 'plugin',
    outDir: 'dist',
  },
  'webpack-sourcemaps': {
    runtime: 'javascript-browser',
    recipe: 'javascript-webpack',
    route: 'plugin',
    outDir: 'dist',
  },
  'vue-spa': {
    runtime: 'javascript-browser-vite',
    recipe: 'javascript-vite',
    route: 'plugin',
    outDir: 'dist',
  },
  'svelte-spa': {
    runtime: 'javascript-browser-vite',
    recipe: 'javascript-vite',
    route: 'plugin',
    outDir: 'dist',
  },
  'angular-spa': { runtime: null, recipe: 'javascript-cli', route: 'cli', outDir: 'dist' },
  'node-service': {
    runtime: 'javascript-node',
    recipe: 'javascript-tsc',
    route: 'cli',
    outDir: null,
  },
  'vite-object-config': {
    base: 'react-spa',
    runtime: 'javascript-browser-vite',
    recipe: 'javascript-vite',
    route: 'plugin',
    outDir: 'dist',
  },
  'webpack-object-config': {
    base: 'webpack-sourcemaps',
    runtime: 'javascript-browser',
    recipe: 'javascript-webpack',
    route: 'plugin',
    outDir: 'dist',
  },
  // fresh projects with no Bugsee in them: the runtime recipe really inserts the SDK and init
  'vite-fresh': {
    synthetic: true,
    runtime: 'javascript-browser-vite',
    recipe: 'javascript-vite',
    route: 'plugin',
    outDir: 'dist',
  },
  'node-fresh': {
    synthetic: true,
    runtime: 'javascript-node',
    recipe: 'javascript-tsc',
    route: 'cli',
    outDir: 'lib',
  },
  'tsc-build': {
    synthetic: true,
    runtime: 'javascript-node',
    recipe: 'javascript-tsc',
    route: 'cli',
    outDir: 'lib',
  },
  'esbuild-build': {
    synthetic: true,
    runtime: 'javascript-browser',
    recipe: 'javascript-esbuild',
    route: 'cli',
    outDir: 'dist',
  },
  'rspack-build': {
    synthetic: true,
    runtime: 'javascript-browser',
    recipe: 'javascript-rspack',
    route: 'cli',
    outDir: 'dist',
  },
  'rollup-build': {
    synthetic: true,
    runtime: 'javascript-browser',
    recipe: 'javascript-rollup',
    route: 'plugin',
    outDir: 'dist',
  },
};

/** The Bugsee packages with an install script (both download the bugsee-cli binary). */
export const BUGSEE_BUILD_SCRIPT_PACKAGES = ['@bugsee/cli', '@bugsee/bugsee-cli'];

/** Whole files a variant replaces (after the sample's own sanitizing). */
const VARIANT_FILES = {
  'vite-object-config': {
    'vite.config.ts': [
      "import react from '@vitejs/plugin-react';",
      "import { defineConfig } from 'vite';",
      '',
      '// e2e variant of the react-spa sample: the object-form config `npm create vite` generates.',
      'export default defineConfig({',
      "  plugins: [react({ babel: { plugins: ['@bugsee/babel-plugin-component-annotate'] } })],",
      '  build: {',
      '    sourcemap: true,',
      '  },',
      '});',
      '',
    ].join('\n'),
  },
  'webpack-object-config': {
    'webpack.config.js': [
      "import path from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
      "import HtmlWebpackPlugin from 'html-webpack-plugin';",
      "import MiniCssExtractPlugin from 'mini-css-extract-plugin';",
      '',
      'const __dirname = path.dirname(fileURLToPath(import.meta.url));',
      '',
      '// e2e variant of the webpack-sourcemaps sample: a plain object config.',
      'export default {',
      "  mode: 'production',",
      "  entry: './src/main.ts',",
      "  devtool: 'hidden-source-map',",
      '  output: {',
      "    path: path.join(__dirname, 'dist'),",
      "    filename: 'assets/[name].[contenthash:8].js',",
      '    clean: true,',
      '  },',
      '  module: {',
      '    rules: [',
      '      {',
      '        test: /\\.tsx?$/,',
      "        use: { loader: 'ts-loader', options: { transpileOnly: true } },",
      '        exclude: /node_modules/,',
      '      },',
      "      { test: /\\.css$/, use: [MiniCssExtractPlugin.loader, 'css-loader'] },",
      '    ],',
      '  },',
      "  resolve: { extensions: ['.ts', '.js'] },",
      '  plugins: [',
      "    new HtmlWebpackPlugin({ template: './src/index.html' }),",
      "    new MiniCssExtractPlugin({ filename: 'assets/[name].[contenthash:8].css' }),",
      '  ],',
      "  stats: 'errors-warnings',",
      '};',
      '',
    ].join('\n'),
  },
};

/**
 * Exact source edits per sample: each pattern must match exactly once, or preparation fails.
 * `remove` deletes the match; `replace` is `[pattern, replacement]`.
 */
const SOURCE_EDITS = {
  'react-spa': [
    {
      file: 'vite.config.ts',
      remove: [
        /^import \{ bugseeVitePlugin \} from '@bugsee\/vite-plugin';\n/m,
        /^ {6}\/\/ @bugsee\/vite-plugin under test:[^\n]*\n(?: {6}\/\/[^\n]*\n)*^ {6}bugseeVitePlugin\(\{\n[\s\S]*?^ {6}\}\),\n/m,
      ],
    },
  ],
  'webpack-sourcemaps': [
    {
      file: 'webpack.config.js',
      remove: [
        /^import \{ bugseeWebpackPlugin \} from '@bugsee\/webpack-plugin';\n/m,
        /^ {6}\/\/ \(a\) @bugsee\/webpack-plugin under test[^\n]*\n(?: {6}\/\/[^\n]*\n)*^ {6}bugseeWebpackPlugin\(\{\n[\s\S]*?^ {6}\}\),\n/m,
      ],
    },
  ],
  // SAMPLE BUG at the pinned ref, not a wizard concern: the sample's own HttpTransport type predates
  // the SDK's `BundleBody` request body, so `ng build` fails against the published 0.1.0-beta.5 with
  // TS2322 at src/app/bugsee.ts:89. The cast keeps the sample building; the transport is unchanged.
  'angular-spa': [
    {
      file: 'src/app/bugsee.ts',
      replace: [
        [
          /^ {2}transport: createTeeTransport\(\),$/m,
          '  transport: createTeeTransport() as never,',
        ],
      ],
    },
  ],
};

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));

function cacheDir() {
  return path.join(E2E_DIR, '.cache');
}

/** Copy synthetic fixture `name` (never anything a local run of it may have left there). */
function copySynthetic(name, dest) {
  const src = path.join(E2E_DIR, 'fixtures', name);
  if (!existsSync(path.join(src, 'package.json'))) throw new Error(`${src} has no package.json`);
  const skip = new Set(['node_modules', 'dist', 'lib', 'pnpm-lock.yaml']);
  cpSync(src, dest, {
    recursive: true,
    filter: (p) => !skip.has(path.relative(src, p).split(path.sep)[0]),
  });
}

/** A git repository that has `ref`: BUGSEE_JS_REPO, or a cached shallow fetch of the pinned ref. */
export function samplesRepo(ref = process.env.BUGSEE_JS_REF ?? PINNED_REF) {
  const local = process.env.BUGSEE_JS_REPO;
  if (local) {
    run('git', ['-C', local, 'cat-file', '-e', `${ref}^{commit}`]);
    return { repo: local, ref };
  }
  const repo = path.join(cacheDir(), 'bugsee-javascript');
  const has = () => {
    try {
      run('git', ['-C', repo, 'cat-file', '-e', `${ref}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  };
  if (!has()) {
    mkdirSync(repo, { recursive: true });
    if (!existsSync(path.join(repo, '.git'))) run('git', ['init', '-q', repo]);
    run('git', ['-C', repo, 'fetch', '-q', '--depth', '1', REPO_URL, ref]);
  }
  return { repo, ref };
}

let sdkVersionCache;
/** The exact @bugsee/* version to pin: BUGSEE_SDK_VERSION or the npm `beta` dist-tag. */
export function sdkVersion() {
  if (process.env.BUGSEE_SDK_VERSION) return process.env.BUGSEE_SDK_VERSION;
  sdkVersionCache ??= run('npm', ['view', '@bugsee/bugsee@beta', 'version']).trim();
  return sdkVersionCache;
}

function sanitizePackageJson(file, version) {
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (!name.startsWith('@bugsee/')) continue;
      if (TOOLING.has(name)) delete deps[name];
      // `beta`: a synthetic fixture's SDK dependency
      else if (String(spec).includes('local-registry') || spec === 'beta') deps[name] = version;
    }
  }
  const text = JSON.stringify(pkg, null, 2);
  if (text.includes('local-registry')) throw new Error(`${file} still references local-registry`);
  writeFileSync(file, `${text}\n`);
}

function sanitizeWorkspaceYaml(file, approveBuilds) {
  const doc = parseDocument(existsSync(file) ? readFileSync(file, 'utf8') : '');
  const overrides = doc.get('overrides');
  if (overrides?.items) {
    overrides.items = overrides.items.filter(
      (p) => !String(p.value?.value ?? p.value).includes('local-registry'),
    );
    if (overrides.items.length === 0) doc.delete('overrides');
  } else if (doc.has('overrides')) {
    doc.delete('overrides');
  }
  const exclude = doc.get('minimumReleaseAgeExclude');
  if (exclude?.items) {
    exclude.items = exclude.items.filter((i) => !String(i.value ?? i).startsWith('@bugsee/'));
    if (exclude.items.length === 0) doc.delete('minimumReleaseAgeExclude');
  }
  const builds = doc.get('allowBuilds');
  if (builds?.items) {
    builds.items = builds.items.filter(
      (p) => !String(p.key?.value ?? p.key).startsWith('@bugsee/'),
    );
    if (builds.items.length === 0) doc.delete('allowBuilds');
  }
  if (approveBuilds) {
    for (const name of BUGSEE_BUILD_SCRIPT_PACKAGES) doc.setIn(['allowBuilds', name], true);
  }
  // an emptied document would print as a flow map (`{}`) that pnpm then extends in flow style
  if (!doc.contents || doc.contents.items?.length === 0) {
    rmSync(file, { force: true });
    return;
  }
  const text = doc.toString();
  if (text.includes('local-registry')) throw new Error(`${file} still references local-registry`);
  writeFileSync(file, text);
}

function applySourceEdits(dir, name) {
  for (const edit of SOURCE_EDITS[name] ?? []) {
    const file = path.join(dir, edit.file);
    let text = readFileSync(file, 'utf8');
    const edits = [...(edit.remove ?? []).map((re) => [re, '']), ...(edit.replace ?? [])];
    for (const [re, by] of edits) {
      const all = text.match(new RegExp(re.source, `${re.flags}g`)) ?? [];
      if (all.length !== 1) {
        throw new Error(`${name}/${edit.file}: expected one match of ${re}, found ${all.length}`);
      }
      text = text.replace(re, by);
    }
    // code only: the samples' comments still mention the plugins by name
    if (/from '@bugsee\/(?:vite|webpack)-plugin'|bugsee(?:Vite|Webpack)Plugin\(/.test(text)) {
      throw new Error(`${name}/${edit.file} still references the Bugsee plugin`);
    }
    writeFileSync(file, text);
  }
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'e2e',
  GIT_AUTHOR_EMAIL: 'e2e@example.invalid',
  GIT_COMMITTER_NAME: 'e2e',
  GIT_COMMITTER_EMAIL: 'e2e@example.invalid',
};

/**
 * Prepare fixture `name` in `dest` (created; must not exist or be empty). Returns its directory.
 * Network: `pnpm install` from the public registry.
 */
export function prepareFixture(name, dest, { log = () => {}, approveBuilds = true } = {}) {
  const fixture = FIXTURES[name];
  if (!fixture) throw new Error(`unknown fixture ${name}`);
  const sample = fixture.base ?? name;
  mkdirSync(dest, { recursive: true });
  let origin;
  if (fixture.synthetic) {
    log(`copying e2e/fixtures/${name}`);
    copySynthetic(name, dest);
    origin = `e2e/fixtures/${name}`;
  } else {
    const { repo, ref } = samplesRepo();
    const prefix = `samples/${sample}/`;
    log(`archiving ${prefix} at ${ref.slice(0, 10)}`);
    const tar = execFileSync('git', ['-C', repo, 'archive', '--format=tar', ref, prefix], {
      maxBuffer: 256 * 1024 * 1024,
    });
    execFileSync('tar', ['-x', '-C', dest, '--strip-components=2'], { input: tar });
    origin = `${sample} @ ${ref}`;
  }

  const version = sdkVersion();
  sanitizePackageJson(path.join(dest, 'package.json'), version);
  sanitizeWorkspaceYaml(path.join(dest, 'pnpm-workspace.yaml'), approveBuilds);
  applySourceEdits(dest, sample);
  for (const [file, text] of Object.entries(VARIANT_FILES[name] ?? {})) {
    writeFileSync(path.join(dest, file), text);
  }

  log(`pnpm install (@bugsee/* ${version})`);
  // minimumReleaseAge=0: pnpm 11 holds back versions published < 1 day ago, and the exact pin to the
  // live `beta` tag would otherwise be unsatisfiable for a day after every release
  run('pnpm', ['install', '--no-frozen-lockfile'], {
    cwd: dest,
    env: { ...process.env, pnpm_config_minimum_release_age: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });

  const env = { ...process.env, ...GIT_ENV };
  run('git', ['init', '-q', '-b', 'main'], { cwd: dest, env });
  run('git', ['add', '-A'], { cwd: dest, env });
  run('git', ['commit', '-q', '--no-gpg-sign', '-m', `fixture ${name} (${origin})`], {
    cwd: dest,
    env,
  });
  return dest;
}

export function defaultWorkDir() {
  return process.env.BUGSEE_E2E_WORKDIR ?? path.join(tmpdir(), 'bugsee-wizard-e2e');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const approveBuilds = !args.includes('--no-approve-builds');
  const [name, dest] = args.filter((a) => !a.startsWith('--'));
  if (!name || !dest) {
    console.error('usage: node e2e/fixtures.mjs <fixture> <dest> [--no-approve-builds]');
    process.exit(2);
  }
  prepareFixture(name, path.resolve(dest), { log: (m) => console.error(m), approveBuilds });
  console.error(`prepared ${name} in ${path.resolve(dest)}`);
}
