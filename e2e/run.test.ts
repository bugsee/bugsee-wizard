// End-to-end: the built wizard (dist/cli.js) against real projects — the bugsee-javascript samples
// at a pinned ref, sanitized by e2e/fixtures.mjs, and the synthetic tsc/esbuild/rspack/rollup
// projects under e2e/fixtures/ — with a real package manager (pnpm), the real
// npm registry (@bugsee/* at the `beta` dist-tag), the project's real build and the real
// bugsee-cli. Nothing reaches Bugsee: every upload goes to a local mock collector through
// BUGSEE_ENDPOINT, which both the bundler plugins and bugsee-cli honour.
//
// Run with `npm run test:e2e` (builds first). Not part of `npm test`.
//   BUGSEE_E2E_FIXTURES  comma-separated subset (default: all fixtures and the `unapproved-*` ones)
//   BUGSEE_CLI_BIN       the bugsee-cli used for the dry-run discovery checks (default: `npx
//                        --yes -p @bugsee/cli bugsee-cli`)
//   BUGSEE_JS_REPO, BUGSEE_JS_REF, BUGSEE_SDK_VERSION, BUGSEE_E2E_WORKDIR: see fixtures.mjs

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseJsonc } from 'jsonc-parser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { opToStep } from '../src/engine/ops/index.js';
import type { Recipe } from '../src/engine/recipe.js';
import { defaultWorkDir, FIXTURES, prepareFixture } from './fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const TOKEN = 'TESTTOKEN123';
/**
 * pnpm 11 projects that have not approved the Bugsee install scripts, per route. The plugin
 * recipes install a package whose DEPENDENCY (@bugsee/bugsee-cli) has the script; the CLI route
 * installs @bugsee/cli itself.
 */
const UNAPPROVED_CASES: Record<
  string,
  { base: string; installId: string; approved: string[]; transitiveCli: boolean }
> = {
  'unapproved-builds': {
    base: 'node-service',
    installId: 'install-package:@bugsee/cli',
    approved: ['@bugsee/cli'],
    transitiveCli: false,
  },
  'unapproved-plugin': {
    base: 'react-spa',
    installId: 'install-package:@bugsee/vite-plugin',
    approved: ['@bugsee/vite-plugin', '@bugsee/bugsee-cli'],
    transitiveCli: true,
  },
};
const UNAPPROVED_NAMES = Object.keys(UNAPPROVED_CASES);

/**
 * Steps the wizard cannot finish on a fixture and hands back as a snippet (outcome `manual`).
 * Every sample bundler config is a function, which the wizard never edits; node-service has no
 * `build` script to chain the upload into.
 */
const MANUAL: Record<string, string[]> = {
  'react-spa': ['add-bundler-plugin:vite'],
  'webpack-sourcemaps': ['add-bundler-plugin:webpack'],
  'vue-spa': ['add-bundler-plugin:vite'],
  'svelte-spa': ['add-bundler-plugin:vite'],
  'angular-spa': [],
  'node-service': ['add-package-script:bugsee:sourcemaps'],
  'vite-object-config': [],
  'webpack-object-config': [],
  'tsc-build': [],
  'esbuild-build': [],
  'rspack-build': [],
  'rollup-build': [],
};

const selected = (
  process.env.BUGSEE_E2E_FIXTURES ?? [...Object.keys(FIXTURES), ...UNAPPROVED_NAMES].join(',')
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
for (const name of selected) {
  if (!(name in FIXTURES) && !UNAPPROVED_NAMES.includes(name))
    throw new Error(`unknown e2e fixture ${name}`);
}

// ---------------------------------------------------------------- helpers

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Async (the mock collector lives in this process and must keep answering while children run). */
function exec(
  cmd: string,
  args: readonly string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      cwd: opts.cwd,
      env: { ...childEnv(), ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 10 * 60_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** The parent's env minus anything that would steer the wizard or the uploads from outside. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NO_COLOR: '1',
    NG_CLI_ANALYTICS: 'false',
    // pnpm 11 holds back (and, when verifying a lockfile, rejects) versions published < 1 day ago;
    // the suite installs the live `beta` tag, which is often that new
    pnpm_config_minimum_release_age: '0',
  };
  for (const k of Object.keys(env)) {
    if (k.startsWith('BUGSEE_WIZARD_') || k === 'BUGSEE_APP_TOKEN' || k === 'BUGSEE_ENDPOINT') {
      delete env[k];
    }
  }
  return env;
}

const show = (r: Ran): string => `exit ${r.code}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`;

function wizard(dir: string, args: readonly string[]): Promise<Ran> {
  return exec(process.execPath, [CLI, ...args], { cwd: dir });
}

async function git(dir: string, args: readonly string[]): Promise<string> {
  const r = await exec('git', args, { cwd: dir });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}\n${show(r)}`);
  return r.stdout;
}

/** Everything that can tell two states of the fixture apart, outside node_modules and build output. */
async function treeState(dir: string): Promise<string> {
  const status = await git(dir, ['status', '--porcelain=v1', '-uall']);
  const diff = await git(dir, ['diff', 'HEAD']);
  const extra = ['.env.bugsee-build-plugin', '.bugsee/wizard-manifest.json'];
  const untracked = (await git(dir, ['ls-files', '--others', '--exclude-standard']))
    .split('\n')
    .filter(Boolean);
  const backups = existsSync(path.join(dir, '.bugsee/backup'))
    ? readdirSync(path.join(dir, '.bugsee/backup')).map((f) => `.bugsee/backup/${f}`)
    : [];
  const hashes = [...new Set([...untracked, ...extra, ...backups])].sort().map((f) => {
    const p = path.join(dir, f);
    return `${f} ${existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : '-'}`;
  });
  return [status, diff, ...hashes].join('\n');
}

function readRecipe(id: string): Recipe {
  return JSON.parse(readFileSync(path.join(ROOT, 'snapshot', id, 'r1.json'), 'utf8')) as Recipe;
}

function parseResult(r: Ran): {
  ok: boolean;
  incomplete: boolean;
  steps: { id: string; outcome: string }[];
  snippets?: { file: string; title: string; code: string }[];
} {
  const lines = r.stdout.trim().split('\n');
  expect(lines, `stdout must be exactly one JSON document\n${show(r)}`).toHaveLength(1);
  return JSON.parse(lines[0] as string);
}

/** Source maps bugsee-cli would pick up (it skips stylesheet and type-declaration maps). */
function jsMaps(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d)) {
      const p = path.join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith('.map') && !/\.(css|d\.[cm]?ts)\.map$/.test(e)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

type JsonKeyOp = Extract<Recipe['ops'][number], { op: 'set-json-key' }>;

/** The value at `op.path` in the (JSONC) file `op.file` of `dir`; undefined when absent. */
function jsonKey(dir: string, op: JsonKeyOp): unknown {
  let v: unknown = parseJsonc(readFileSync(path.join(dir, op.file), 'utf8'));
  for (const k of op.path) {
    v = typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[k] : undefined;
  }
  return v;
}

const showKey = (op: JsonKeyOp): string => `${op.file} ${op.path.join('.')}`;

function bugseeCli(): { cmd: string; pre: string[] } {
  const bin = process.env.BUGSEE_CLI_BIN;
  if (bin) return { cmd: bin, pre: [] };
  return { cmd: 'npx', pre: ['--yes', '-p', '@bugsee/cli', 'bugsee-cli'] };
}

// ---------------------------------------------------------------- mock collector

/** The legacy two-stage symbol protocol bugsee-cli speaks (src/upload/presigned.rs). */
interface Collector {
  url: string;
  requests: { method: string; path: string }[];
  reset(): void;
  close(): Promise<void>;
}

async function startCollector(): Promise<Collector> {
  const requests: { method: string; path: string }[] = [];
  let n = 0;
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const url = req.url ?? '';
      requests.push({ method: req.method ?? '', path: url });
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      if (req.method === 'POST' && /^\/apps\/[^/]+\/symbols$/.test(url)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 0, endpoint: `${base}/put/${++n}` }));
        return;
      }
      if (req.method === 'PUT' && url.startsWith('/put/')) {
        res.writeHead(200);
        res.end();
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { type: 'NotFound', message: url, code: 404 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    reset: () => {
      requests.length = 0;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

// ---------------------------------------------------------------- suite

let collector: Collector;
beforeAll(async () => {
  if (!existsSync(CLI)) throw new Error(`${CLI} is missing: run \`npm run build\` first`);
  collector = await startCollector();
});
afterAll(async () => {
  await collector?.close();
});

const workDir = defaultWorkDir();

function fresh(name: string): string {
  const dir = path.join(workDir, name);
  rmSync(dir, { recursive: true, force: true });
  return dir;
}

for (const name of selected.filter((n) => n in FIXTURES)) {
  const fixture = FIXTURES[name] as (typeof FIXTURES)[string];
  const recipe = readRecipe(fixture.recipe);
  const manual = MANUAL[name];
  if (!manual) throw new Error(`MANUAL has no entry for fixture ${name}`);
  const pluginManual = manual.some((id) => id.startsWith('add-bundler-plugin:'));
  const jsonKeyOps = recipe.ops.filter((op): op is JsonKeyOp => op.op === 'set-json-key');
  // the recipe sets tsc's inlineSources: every map the build writes must carry the sources
  const inlineSources = jsonKeyOps.some(
    (op) => op.path.join('.') === 'compilerOptions.inlineSources' && op.value === true,
  );
  const expectedIds = [
    ...recipe.ops.map((op) => opToStep(op).id),
    opToStep({ op: 'ensure-gitignore', line: '.bugsee/' }).id,
  ];

  describe(name, () => {
    let dir: string;
    let installed: string;
    /** Source maps the wizard-wired build uploaded to the mock collector. */
    let uploaded = 0;
    /** The fixture's own values at the keys the recipe sets (uninstall must bring them back). */
    const originalKeys = new Map<JsonKeyOp, unknown>();

    beforeAll(() => {
      dir = prepareFixture(name, fresh(name), { log: (m) => console.error(`[${name}] ${m}`) });
      for (const op of jsonKeyOps) originalKeys.set(op, jsonKey(dir, op));
    });

    it('install: applies the recipe, writes the manifest, never prints the token', async () => {
      const r = await wizard(dir, [
        '--non-interactive',
        '--json',
        '--token',
        TOKEN,
        '--ignore-git-changes',
      ]);
      expect(r.stdout + r.stderr).not.toContain(TOKEN);
      expect(r.code, show(r)).toBe(manual.length > 0 ? 3 : 0);
      const res = parseResult(r);
      expect(res.ok, show(r)).toBe(true);
      expect(res.incomplete).toBe(manual.length > 0);
      expect(res.steps.map((s) => s.id)).toEqual(expectedIds);
      for (const s of res.steps) {
        expect(`${s.id}: ${s.outcome}`).toBe(
          `${s.id}: ${manual.includes(s.id) ? 'manual' : 'applied'}`,
        );
      }
      expect((res.snippets ?? []).length).toBe(manual.length);

      // the files the wizard changed are exactly the ones its manifest lists
      const manifest = JSON.parse(
        readFileSync(path.join(dir, '.bugsee/wizard-manifest.json'), 'utf8'),
      );
      expect(manifest.recipes).toEqual([{ id: fixture.recipe, revision: 'r1' }]);
      const entries = manifest.entries as { file: string; action: string }[];
      // a plugin left to the user is recorded as `manual` (uninstall reminds them of it)
      expect(entries.filter((e) => e.action === 'manual').length).toBe(pluginManual ? 1 : 0);
      const recorded = entries.filter((e) => e.action !== 'manual').map((e) => e.file);
      const changed = [
        ...(await git(dir, ['diff', '--name-only', 'HEAD'])).split('\n'),
        ...(await git(dir, ['ls-files', '--others', '--exclude-standard'])).split('\n'),
      ].filter(Boolean);
      // git does not list ignored files: the env file (ignored by the run itself) and, in
      // angular-spa, the lockfile the sample git-ignores
      const ignored = (
        await exec('git', ['check-ignore', '--no-index', ...recorded], { cwd: dir })
      ).stdout
        .split('\n')
        .filter(Boolean);
      expect(ignored).toContain('.env.bugsee-build-plugin');
      expect([...changed].sort()).toEqual(recorded.filter((f) => !ignored.includes(f)).sort());
      for (const f of recorded) expect(existsSync(path.join(dir, f)), f).toBe(true);

      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const install = recipe.ops.find((op) => op.op === 'install-package');
      for (const p of install && 'packages' in install ? install.packages : []) {
        expect(pkg.devDependencies?.[p], `${p} in devDependencies`).toBeTypeOf('string');
      }
      // tsc recipes: the source-map options landed (with values the fixture did not have)
      for (const op of jsonKeyOps) {
        expect(jsonKey(dir, op), showKey(op)).toEqual(op.value);
        expect(originalKeys.get(op), `${showKey(op)} before the wizard`).not.toEqual(op.value);
      }
      expect(readFileSync(path.join(dir, '.env.bugsee-build-plugin'), 'utf8')).toContain(
        `BUGSEE_APP_TOKEN=${TOKEN}`,
      );
      await git(dir, ['check-ignore', '-q', '.env.bugsee-build-plugin']);
      await git(dir, ['check-ignore', '-q', '.bugsee/wizard-manifest.json']);
      installed = await treeState(dir);
    });

    it('build: the real build succeeds and uploads exactly when the wizard wired it up', async () => {
      collector.reset();
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg.scripts?.build === undefined) {
        // node-service runs its TypeScript directly (node type stripping): there is no build, so the
        // generated script has nothing to upload; it warns and skips (it is meant to run inside a
        // build, which it must not fail for a default directory that was never built)
        expect(fixture.outDir).toBeNull();
        const r = await exec(process.execPath, ['scripts/bugsee-sourcemaps.mjs'], {
          cwd: dir,
          env: { BUGSEE_ENDPOINT: collector.url },
        });
        expect(r.code, show(r)).toBe(0);
        expect(r.stderr).toContain('output directory "dist" not found. Skipping');
        expect(collector.requests).toEqual([]);
        return;
      }
      const env: NodeJS.ProcessEnv = {
        BUGSEE_ENDPOINT: collector.url,
        BUGSEE_REGISTER_BUILD: 'false',
        // the plugins read the token from the environment only (JS issue #182); the CLI-route
        // script reads .env.bugsee-build-plugin itself, so it gets no token from here
        ...(fixture.route === 'plugin' ? { BUGSEE_APP_TOKEN: TOKEN } : {}),
      };
      const r = await exec('pnpm', ['run', 'build'], { cwd: dir, env });
      expect(r.code, show(r)).toBe(0);
      const posts = collector.requests.filter((q) => q.method === 'POST');
      const puts = collector.requests.filter((q) => q.method === 'PUT');
      if (pluginManual) {
        expect(collector.requests, 'nothing uploads while the plugin is not in the config').toEqual(
          [],
        );
        return;
      }
      expect(posts.length, show(r)).toBeGreaterThan(0);
      for (const q of posts) expect(q.path).toBe(`/apps/${TOKEN}/symbols`);
      expect(puts.length).toBe(posts.length);
      uploaded = posts.length;
      expect(collector.requests.filter((q) => q.method !== 'POST' && q.method !== 'PUT')).toEqual(
        [],
      );
    });

    it.runIf(fixture.outDir !== null)(
      'bugsee-cli discovers the built source maps (inject and upload, dry run)',
      async () => {
        const out = path.join(dir, fixture.outDir as string);
        if (fixture.route === 'plugin' && !pluginManual) {
          // the plugin deletes the maps once uploaded: build again with no token, which turns the
          // plugin off (nothing must upload), and check bugsee-cli finds exactly what it uploaded
          collector.reset();
          const r = await exec('pnpm', ['run', 'build'], {
            cwd: dir,
            env: { BUGSEE_ENDPOINT: collector.url, BUGSEE_REGISTER_BUILD: 'false' },
          });
          expect(r.code, show(r)).toBe(0);
          expect(collector.requests).toEqual([]);
        }
        const maps = jsMaps(out);
        expect(maps.length, `source maps in ${out}`).toBeGreaterThan(0);
        if (inlineSources) {
          for (const m of maps) {
            const { sources, sourcesContent } = JSON.parse(readFileSync(m, 'utf8'));
            expect(sourcesContent?.length, `${m}: inlineSources`).toBe(sources.length);
            for (const c of sourcesContent) expect(c, m).toBeTypeOf('string');
          }
        }
        // what the wired-up build uploaded is what bugsee-cli discovers
        if (!pluginManual) expect(uploaded).toBe(maps.length);
        // CLI route: the generated script ran inside the build, so the output is injected already
        const injected = fixture.route === 'cli';
        const { cmd, pre } = bugseeCli();
        const inject = await exec(cmd, [...pre, 'sourcemaps', 'inject', out, '--dry-run'], {
          cwd: dir,
        });
        expect(inject.code, show(inject)).toBe(0);
        const log = inject.stdout + inject.stderr;
        const summary = /js_injected=(\d+) js_already_injected=(\d+)/.exec(log);
        expect(summary, show(inject)).not.toBeNull();
        const [, fresh, already] = summary as RegExpExecArray;
        expect(Number(injected ? already : fresh), show(inject)).toBeGreaterThanOrEqual(
          maps.length,
        );
        if (injected) expect(Number(fresh), show(inject)).toBe(0);

        const upload = await exec(
          cmd,
          [
            ...pre,
            'debug-files',
            'upload',
            out,
            '--type',
            'sourcemaps',
            '--dry-run',
            '--version',
            '0',
            '--build',
            '0',
          ],
          { cwd: dir, env: { BUGSEE_APP_TOKEN: TOKEN } },
        );
        expect(upload.code, show(upload)).toBe(0);
        const processed = (upload.stdout + upload.stderr).match(/processing source map/g) ?? [];
        expect(processed.length, show(upload)).toBe(maps.length);
      },
    );

    it('a second run changes nothing (and its own earlier changes do not block it)', async () => {
      // no --ignore-git-changes: the tree is dirty with the wizard's own changes only
      const r = await wizard(dir, ['--non-interactive', '--json', '--token', TOKEN]);
      const res = parseResult(r);
      expect(res.ok, show(r)).toBe(true);
      for (const s of res.steps) {
        expect(`${s.id}: ${s.outcome}`).toBe(
          `${s.id}: ${manual.includes(s.id) ? 'manual' : 'skipped'}`,
        );
      }
      expect(r.code).toBe(manual.length > 0 ? 3 : 0);
      expect(await treeState(dir)).toBe(installed);
    });

    it('uninstall restores the original tree', async () => {
      const r = await wizard(dir, ['uninstall', '--non-interactive', '--json', '--yes']);
      const res = parseResult(r);
      expect(res.ok, show(r)).toBe(true);
      // a plugin the user may have added by hand from the snippet is left for them (exit 3)
      expect(r.code, show(r)).toBe(pluginManual ? 3 : 0);
      expect(res.steps.filter((s) => s.outcome === 'manual').length).toBe(pluginManual ? 1 : 0);
      for (const s of res.steps) expect(s.outcome).not.toBe('skipped');
      expect(await git(dir, ['status', '--porcelain=v1', '-uall'])).toBe('');
      expect(await git(dir, ['diff', 'HEAD'])).toBe('');
      // git does not show ignored files (and honours a global excludes file): check them directly
      for (const f of ['.env.bugsee-build-plugin', '.bugsee', 'scripts/bugsee-sourcemaps.mjs']) {
        expect(existsSync(path.join(dir, f)), `${f} left behind`).toBe(false);
      }
      // the tsconfig keys are back to the fixture's own (absent) values, not merely git-clean
      for (const op of jsonKeyOps) {
        expect(jsonKey(dir, op), showKey(op)).toEqual(originalKeys.get(op));
      }
    });
  });
}

// pnpm 11 fails an install whose scripts are unapproved; pnpm 10 only warns, so there the pair
// below would not exercise the wizard's approval
const pnpmMajor = Number(
  spawnSync('pnpm', ['--version'], { encoding: 'utf8' }).stdout.split('.')[0],
);

for (const name of selected.filter((n) => UNAPPROVED_NAMES.includes(n))) {
  if (!(pnpmMajor >= 11)) {
    // a skipped job would look green while testing nothing
    throw new Error(`the ${name} fixture needs pnpm >= 11 (found ${pnpmMajor})`);
  }
}

for (const name of selected.filter((n) => UNAPPROVED_NAMES.includes(n))) {
  const c = UNAPPROVED_CASES[name] as (typeof UNAPPROVED_CASES)[string];
  describe(name, () => {
    let dir: string;
    beforeAll(() => {
      dir = prepareFixture(c.base, fresh(name), { approveBuilds: false });
    });

    // pnpm 11 fails `pnpm add` with ERR_PNPM_IGNORED_BUILDS for any dependency whose install script
    // is not approved; @bugsee/cli (and the plugins' @bugsee/bugsee-cli) have one. Editing the
    // project's pnpm settings needs consent: without --yes (and non-interactively there is nobody to
    // ask) the wizard leaves pnpm-workspace.yaml alone, the install fails with a hint, and the tree
    // is exactly as it was. With --yes it approves exactly the @bugsee packages whose install scripts the install needs (merging with any
    // approvals already there: the esbuild-build fixture covers that), and uninstall takes the
    // approval out again.
    it('without --yes: fails with the hint and leaves the tree exactly as it was', async () => {
      const r = await wizard(dir, ['--non-interactive', '--json', '--token', TOKEN]);
      const res = parseResult(r);
      expect(res.ok, show(r)).toBe(false);
      expect(res.steps).toEqual([{ id: c.installId, outcome: 'failed' }]);
      expect(r.stderr + r.stdout).toContain('approve-builds');
      expect(r.stderr + r.stdout).toContain('--yes');
      expect(await git(dir, ['status', '--porcelain=v1', '-uall'])).toBe('');
    });

    it('with --yes: installs on a pnpm project that has not approved the Bugsee install scripts', async () => {
      const wsFile = path.join(dir, 'pnpm-workspace.yaml');
      const keysOf = (text: string) =>
        [...text.matchAll(/^ {2}['"]?([^'":\s]+)['"]?:\s*true/gm)].map((m) => m[1] as string);
      // the sample's own approvals (esbuild, ...) are the project's and stay as they are
      const own = existsSync(wsFile) ? keysOf(readFileSync(wsFile, 'utf8')) : [];
      const r = await wizard(dir, ['--non-interactive', '--yes', '--json', '--token', TOKEN]);
      expect(parseResult(r).ok, show(r)).toBe(true);
      const yaml = readFileSync(wsFile, 'utf8');
      for (const pkg of c.approved) {
        expect(yaml).toMatch(new RegExp(`['"]?${pkg.replace('/', '\\/')}['"]?:\\s*true`));
      }
      // nothing outside the @bugsee scope is ever approved
      for (const key of keysOf(yaml).filter((k) => !own.includes(k))) {
        expect(key, yaml).toMatch(/^@bugsee\//);
      }
      // the install script really ran: the CLI binary resolves. @bugsee/bugsee-cli is only a
      // dependency of the plugin there, so its bin is not linked at the root: run it from the store
      let cmd = ['npx', '--no-install', 'bugsee-cli', '--version'];
      if (c.transitiveCli) {
        const store = path.join(dir, 'node_modules', '.pnpm');
        const pkg = readdirSync(store).find((d) => d.startsWith('@bugsee+bugsee-cli@'));
        expect(pkg, 'bugsee-cli in the pnpm store').toBeDefined();
        cmd = [
          process.execPath,
          path.join(store, pkg as string, 'node_modules/@bugsee/bugsee-cli/run-bugsee-cli.js'),
          '--version',
        ];
      }
      const cli = spawnSync(cmd[0] as string, cmd.slice(1), { cwd: dir, encoding: 'utf8' });
      expect(cli.status, cli.stderr).toBe(0);
    });

    it('uninstall removes the approval it added', async () => {
      const r = await wizard(dir, ['uninstall', '--non-interactive', '--json', '--yes']);
      expect(parseResult(r).ok, show(r)).toBe(true);
      expect(await git(dir, ['status', '--porcelain=v1', '-uall'])).toBe('');
    });
  });
}
