import { access } from 'node:fs/promises';
import path from 'node:path';

import { findConfigFile } from '../engine/config-ast.js';
import { readPackageJson } from '../engine/package-json.js';
import { detectPackageManager, type PackageManagerName } from '../engine/package-manager.js';
import { findWorkspace, resolveDependencyVersion } from '../engine/workspace.js';

export interface JsDetection {
  packageDir: string;
  packageManager: PackageManagerName | null;
  runtimes: string[];
  framework?: string;
  buildTool?: string;
  typescript: boolean;
  versions: Record<string, string>;
  workspace?: { root: string; packages: { dir: string; name: string }[] };
  needsPackageChoice: boolean;
}

export interface JsEvidence {
  /** Path relative to the detected directory. */
  path: string;
  note?: string;
}

/**
 * Static analysis only: package.json is parsed as JSON and every other file is merely
 * checked for existence. No user file is ever executed or imported.
 */

const RUNTIME_ORDER = [
  'browser',
  'node',
  'bun',
  'deno',
  'electron',
  'webworker',
  'serviceworker',
  'edge',
] as const;

const FRAMEWORKS: ReadonlyArray<{ framework: string; match: (dep: string) => boolean }> = [
  { framework: 'nextjs', match: (d) => d === 'next' },
  { framework: 'nuxt', match: (d) => d === 'nuxt' },
  { framework: 'sveltekit', match: (d) => d === '@sveltejs/kit' },
  { framework: 'astro', match: (d) => d === 'astro' },
  { framework: 'remix', match: (d) => d.startsWith('@remix-run/') || d === 'react-router' },
  { framework: 'angular', match: (d) => d === '@angular/core' },
  { framework: 'electron', match: (d) => d === 'electron' },
];

/** Frameworks whose build tool the framework itself fixes (an extra `vite` dep, e.g. for vitest, never overrides it). */
const FRAMEWORK_TOOL: Record<string, string> = {
  nextjs: 'webpack',
  nuxt: 'vite',
  sveltekit: 'vite',
  astro: 'vite',
  remix: 'vite',
  angular: 'cli',
};

const MULTI_RUNTIME_FRAMEWORKS = new Set(['nextjs', 'nuxt', 'sveltekit', 'astro', 'remix']);

/** Bundlers in precedence order: dependency name and config-file base. */
const BUNDLERS: ReadonlyArray<{ tool: string; dep: string; config: string }> = [
  { tool: 'vite', dep: 'vite', config: 'vite.config' },
  { tool: 'rspack', dep: '@rspack/core', config: 'rspack.config' },
  { tool: 'webpack', dep: 'webpack', config: 'webpack.config' },
  { tool: 'rollup', dep: 'rollup', config: 'rollup.config' },
  { tool: 'esbuild', dep: 'esbuild', config: 'esbuild.config' },
];

const UI_DEPS = ['react', 'react-dom', 'vue', 'svelte', 'solid-js', 'preact', '@angular/core'];
const SERVER_DEPS = [
  'express',
  'fastify',
  'koa',
  'hono',
  '@nestjs/core',
  '@hapi/hapi',
  'hapi',
  'elysia',
];
const EDGE_DEPS = ['@cloudflare/workers-types', '@vercel/edge', 'wrangler'];
const BUN_DEPS = ['@types/bun'];
const EDGE_CONFIGS = ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc'];
const BUN_FILES = ['bun.lock', 'bun.lockb', 'bunfig.toml'];
const DENO_FILES = ['deno.json', 'deno.jsonc', 'deno.lock'];
const LOCKFILES = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'deno.lock',
];
const FRAMEWORK_CONFIGS = [
  'next.config',
  'nuxt.config',
  'svelte.config',
  'astro.config',
  'remix.config',
  'react-router.config',
];

/** Packages that identify the project; their resolved versions are reported. */
const IDENTIFYING = new Set<string>([
  ...UI_DEPS,
  ...SERVER_DEPS,
  ...EDGE_DEPS,
  ...BUN_DEPS,
  ...BUNDLERS.map((b) => b.dep),
  'next',
  'nuxt',
  '@sveltejs/kit',
  'astro',
  'react-router',
  'electron',
  'typescript',
  'vitest',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function firstExisting(dir: string, names: readonly string[]): Promise<string | undefined> {
  for (const n of names) if (await exists(path.join(dir, n))) return n;
  return undefined;
}

async function readManifest(dir: string): Promise<Record<string, unknown> | null> {
  try {
    return (await readPackageJson(path.join(dir, 'package.json'))).data;
  } catch {
    return null;
  }
}

function depNames(pkg: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  for (const field of ['dependencies', 'devDependencies']) {
    const section = pkg[field];
    if (isRecord(section)) for (const k of Object.keys(section)) out.add(k);
  }
  return out;
}

function isAppLike(deps: Set<string>): boolean {
  for (const d of deps) {
    if (IDENTIFYING.has(d) && d !== 'typescript' && d !== 'vitest') return true;
    if (FRAMEWORKS.some((f) => f.match(d))) return true;
  }
  return false;
}

function engineVersion(pkg: Record<string, unknown>, runtime: string): string | undefined {
  const engines = pkg.engines;
  const v = isRecord(engines) ? engines[runtime] : undefined;
  return typeof v === 'string' ? v : undefined;
}

export async function inspectJavaScript(
  cwd: string,
): Promise<{ detection: JsDetection; evidence: JsEvidence[] } | null> {
  const pkg = await readManifest(cwd);
  if (!pkg) return null;
  const deps = depNames(pkg);
  // A React Native project is owned by the React Native recipe.
  if (deps.has('react-native')) return null;

  const evidence: JsEvidence[] = [{ path: 'package.json' }];
  const found = await findWorkspace(cwd);
  const isRoot = found?.root === cwd;
  const listed = found?.packages.some((p) => p.dir === cwd) === true;
  const workspace = found && (isRoot || listed) ? found : undefined;
  const pm = await detectPackageManager(cwd);
  const lockfile = await firstExisting(cwd, LOCKFILES);
  if (lockfile) evidence.push({ path: lockfile, note: 'lockfile' });

  const hasTsconfig = await exists(path.join(cwd, 'tsconfig.json'));
  const typescript = deps.has('typescript') || hasTsconfig;
  if (hasTsconfig) evidence.push({ path: 'tsconfig.json' });

  if (isRoot && workspace && workspace.packages.length > 0 && !isAppLike(deps)) {
    evidence.push({
      path: 'package.json',
      note: `workspace root with ${workspace.packages.length} packages`,
    });
    return {
      detection: {
        packageDir: cwd,
        packageManager: pm?.name ?? null,
        runtimes: ['node'],
        typescript,
        versions: {},
        workspace,
        needsPackageChoice: true,
      },
      evidence,
    };
  }

  const framework = FRAMEWORKS.find((f) => [...deps].some(f.match))?.framework;

  const bundlerConfigs = new Map<string, string>();
  for (const b of BUNDLERS) {
    const file = await findConfigFile(cwd, b.config);
    if (file) bundlerConfigs.set(b.tool, path.basename(file));
  }
  const bundler = BUNDLERS.find((b) => deps.has(b.dep) || bundlerConfigs.has(b.tool))?.tool;
  let buildTool: string;
  if (framework && FRAMEWORK_TOOL[framework]) buildTool = FRAMEWORK_TOOL[framework] as string;
  else if (bundler) buildTool = bundler;
  else if (typescript && hasTsconfig) buildTool = 'tsc';
  else buildTool = 'cli';

  for (const base of FRAMEWORK_CONFIGS) {
    const file = await findConfigFile(cwd, base);
    if (file) evidence.push({ path: path.basename(file), note: 'framework config' });
  }
  if (framework === 'angular' && (await exists(path.join(cwd, 'angular.json')))) {
    evidence.push({ path: 'angular.json', note: 'framework config' });
  }
  const toolConfig = bundlerConfigs.get(buildTool);
  if (toolConfig && !evidence.some((e) => e.path === toolConfig)) {
    evidence.push({ path: toolConfig, note: 'build tool config' });
  }

  // Runtimes.
  const runtimes = new Set<string>();
  const hasHtml =
    (await exists(path.join(cwd, 'index.html'))) ||
    (await exists(path.join(cwd, 'src', 'index.html')));
  const hasUi = UI_DEPS.some((d) => deps.has(d));
  const browser = hasUi || (bundler !== undefined && hasHtml);
  const edgeFile = await firstExisting(cwd, EDGE_CONFIGS);
  const edge = edgeFile !== undefined || EDGE_DEPS.some((d) => deps.has(d));
  const bunFile = await firstExisting(cwd, BUN_FILES);
  const bun = bunFile !== undefined || BUN_DEPS.some((d) => deps.has(d)) || pm?.name === 'bun';
  const denoFile = await firstExisting(cwd, DENO_FILES);
  const deno = denoFile !== undefined;
  if (hasHtml && bundler) evidence.push({ path: 'index.html', note: 'browser entry' });
  if (edgeFile) evidence.push({ path: edgeFile, note: 'edge runtime' });
  if (bunFile) evidence.push({ path: bunFile, note: 'bun' });
  if (denoFile) evidence.push({ path: denoFile, note: 'deno' });

  if (deps.has('electron')) {
    runtimes.add('electron');
  } else {
    if (framework && MULTI_RUNTIME_FRAMEWORKS.has(framework)) {
      runtimes.add('browser');
      runtimes.add('node');
    }
    if (browser) runtimes.add('browser');
    const serverSignal =
      pkg.bin !== undefined ||
      // Server libraries (hono, ...) also run on the edge: with an edge signal they say nothing about node.
      (!edge && SERVER_DEPS.some((d) => deps.has(d))) ||
      // engines.node / "type" only tell us it runs on node when no UI library or edge target claims the project.
      (!browser && !edge && (engineVersion(pkg, 'node') !== undefined || pkg.type !== undefined));
    if (serverSignal) runtimes.add('node');
    if (bun) runtimes.add('bun');
    if (deno) runtimes.add('deno');
    if (edge) runtimes.add('edge');
    // Bun and Deno projects run server-side JS, which also covers node-style code.
    if ((bun || deno) && !browser && !edge) runtimes.add('node');
    if (runtimes.size === 0) runtimes.add('node');
  }

  const versions: Record<string, string> = {};
  const wanted = [...deps].filter((d) => IDENTIFYING.has(d) || FRAMEWORKS.some((f) => f.match(d)));
  for (const d of wanted) {
    const v = await resolveDependencyVersion(cwd, d);
    if (v !== undefined) versions[d] = v;
  }
  for (const rt of ['node', 'bun', 'deno']) {
    const v = engineVersion(pkg, rt);
    if (v !== undefined) versions[rt] = v;
  }

  const detection: JsDetection = {
    packageDir: cwd,
    packageManager: pm?.name ?? null,
    runtimes: RUNTIME_ORDER.filter((r) => runtimes.has(r)),
    typescript,
    versions,
    needsPackageChoice: false,
  };
  if (framework) detection.framework = framework;
  detection.buildTool = buildTool;
  if (workspace) detection.workspace = workspace;
  return { detection, evidence };
}

export async function detectJavaScript(cwd: string): Promise<JsDetection | null> {
  return (await inspectJavaScript(cwd))?.detection ?? null;
}
