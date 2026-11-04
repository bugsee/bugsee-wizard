import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import type { WizardOptions } from '../../src/core/context.js';
import type { Logger } from '../../src/core/logger.js';
import type { Output, WizardRunResult } from '../../src/engine/noninteractive.js';
import { parseRecipe, type Recipe } from '../../src/engine/recipe.js';
import type { Deps } from '../../src/web/run.js';

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'js');
export const TOKEN = 'tok_SECRET_9f8e7d';

/** The Vite build-tool recipe a run resolves to (authored here: the snapshot is empty until Task 13). */
export const VITE_RECIPE: Recipe = parseRecipe({
  schema: 1,
  id: 'javascript-vite',
  kind: 'buildtool',
  platform: 'javascript-vite',
  engine: { min: '0.0.0' },
  sdk: { range: '*' },
  detect: [{ dependency: 'vite' }],
  ops: [
    { op: 'install-package', packages: ['@bugsee/vite-plugin'], dev: true, tag: 'beta' },
    {
      op: 'add-bundler-plugin',
      target: 'vite',
      importFrom: '@bugsee/vite-plugin',
      importName: 'bugsee',
      callArgs: '',
    },
    {
      op: 'write-env-var',
      file: '.env.bugsee-build-plugin',
      key: 'BUGSEE_APP_TOKEN',
      from: 'token',
    },
    { op: 'ensure-gitignore', line: '.env.bugsee-build-plugin' },
  ],
});

/**
 * A fake `npm` first on PATH (run for real through runChild, shell false): it records its
 * arguments and adds each named package to package.json the way npm would, plus a lockfile.
 */
const FAKE_NPM = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const field = args.includes('-D') ? 'devDependencies' : 'dependencies';
pkg[field] = pkg[field] || {};
for (const a of args.filter((x) => x !== 'install' && !x.startsWith('-'))) {
  const at = a.lastIndexOf('@');
  pkg[field][at > 0 ? a.slice(0, at) : a] = '0.1.0-beta.9';
}
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\\n');
fs.writeFileSync('package-lock.json', JSON.stringify({ lockfileVersion: 3, n: Object.keys(pkg[field]).length }) + '\\n');
`;

export interface Sandbox {
  root: string;
  project: string;
  npmLog: string;
  npmCalls(): Promise<{ args: string[]; cwd: string }[]>;
  cleanup(): Promise<void>;
}

/** A COPY of a fixture in a temp dir, with the fake npm on PATH. */
export async function sandbox(fixture: string): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), 'bugsee-run-'));
  const project = join(root, 'project');
  await cp(join(FIXTURES, fixture), project, { recursive: true });
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'npm'), FAKE_NPM);
  await chmod(join(bin, 'npm'), 0o755);
  const npmLog = join(root, 'npm.log');
  await writeFile(npmLog, '');
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
  process.env.FAKE_NPM_LOG = npmLog;
  return {
    root,
    project,
    npmLog,
    async npmCalls() {
      const text = await readFile(npmLog, 'utf8');
      return text
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { args: string[]; cwd: string });
    },
    async cleanup() {
      process.env.PATH = savedPath;
      delete process.env.FAKE_NPM_LOG;
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** `git init` + commit everything in `dir` (a real repository, identity set locally). */
export function gitCommitAll(dir: string): void {
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  };
  git('init', '-q');
  git('config', 'user.email', 'wizard-test@example.com');
  git('config', 'user.name', 'Wizard Test');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
}

/** relative path -> sha256 of every file under `dir`. */
export async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else
        out[relative(dir, p)] = createHash('sha256')
          .update(await readFile(p))
          .digest('hex');
    }
  };
  await walk(dir);
  return out;
}

export interface Captured {
  lines: string[];
  results: WizardRunResult[];
  output: Output;
}

export function captureOutput(): Captured {
  const lines: string[] = [];
  const results: WizardRunResult[] = [];
  const push = (m: string): void => {
    lines.push(m);
  };
  const log: Logger = {
    info: push,
    warn: push,
    error: push,
    success: push,
    step: push,
    debug: push,
  };
  return { lines, results, output: { log, result: (r) => results.push(r) } };
}

export function baseOpts(cwd: string, over: Partial<WizardOptions> = {}): WizardOptions {
  return {
    cwd,
    debug: false,
    dryRun: false,
    nonInteractive: true,
    json: false,
    ignoreGitChanges: false,
    yes: false,
    ...over,
  };
}

export function makeDeps(cap: Captured, over: Partial<Deps> = {}): Partial<Deps> {
  return {
    resolveRecipe: vi.fn(async () => ({
      recipe: VITE_RECIPE,
      revision: 'r1',
      source: 'snapshot' as const,
    })),
    resolveSdkVersion: vi.fn(async () => '0.1.0-beta.5'),
    prompts: { confirm: vi.fn(async () => true), select: vi.fn(async () => '') },
    git: vi.fn(async () => ({ repo: true, changed: [] })),
    env: { BUGSEE_APP_TOKEN: TOKEN },
    output: cap.output,
    ...over,
  };
}
