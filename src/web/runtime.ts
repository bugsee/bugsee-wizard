import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WizardOptions } from '../core/context.js';
import { findConfigFile } from '../engine/config-ast.js';
import { scriptFiles, scriptsRunAFile } from '../engine/entry-detect.js';
import { readPackageJson } from '../engine/package-json.js';
import type { SdkRuntime } from '../engine/sdk-init-ast.js';
import { type JsDetection, SERVER_DEPS } from './detect.js';
import type { Prompts } from './prompts.js';

/** The runtime recipe a run applies, or why none is. */
export type RuntimeChoice =
  | { runtime: SdkRuntime; platform: string; note?: string }
  /** `silent`: the user asked for it (`--runtime none`), so it is not an unfinished step. */
  | { skip: string; silent?: true };

const SUPPORTED: readonly SdkRuntime[] = ['browser', 'node', 'bun'];
const LABEL: Record<SdkRuntime, string> = {
  browser: 'browser (a web page)',
  node: 'Node.js',
  bun: 'Bun',
};

async function choose(runtime: SdkRuntime, det: JsDetection): Promise<RuntimeChoice> {
  if (runtime !== 'browser' || det.buildTool !== 'vite') {
    return { runtime, platform: `javascript-${runtime}` };
  }
  // Vite reads VITE_-prefixed variables from .env files, so its browser recipe keeps the token out of
  // the code: unless the config moves or renames that lookup, where the variable would be undefined
  const changed = await viteEnvChanged(det.packageDir);
  return changed === undefined
    ? { runtime, platform: 'javascript-browser-vite' }
    : {
        runtime,
        platform: 'javascript-browser',
        note: `the Vite config sets ${changed}, so import.meta.env.VITE_BUGSEE_APP_TOKEN may not be read from .env.local: the token is written into the init call instead`,
      };
}

/** Every string in a package.json `exports` value (it nests conditions and sub-paths). */
function exportPaths(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value !== 'object' || value === null) return [];
  return Object.values(value).flatMap(exportPaths);
}

/** `./dist/index.js` and `src/index.ts` are the same module: compare without the build directory and extension. */
const moduleKey = (p: string): string =>
  p
    .replace(/^\.\//, '')
    .replace(/^(?:dist|build|out|lib)\//, 'src/')
    .replace(/\.[cm]?[jt]sx?$/, '');

/**
 * A package that looks published for others to import, and nothing that runs it. Importing a library
 * must not start Bugsee in every app that uses it.
 *
 * Something runs it when it has a `start`/`serve` script or a `bin`; or, if it is not a published
 * package, a runner on a file in `dev` (`nodemon index.js`) or a server framework dependency (the
 * `npm init -y` + express shape). A published package (not `private`, with `exports`/`files`/
 * `publishConfig`; `types` alone is not publishing) is a library whatever its `dev` script or dependencies say, unless that dev script
 * runs a file that is not the package's own entry (a playground, an example server).
 */
async function looksLikeLibrary(dir: string, bun: boolean): Promise<boolean> {
  let pkg: Record<string, unknown>;
  try {
    pkg = (await readPackageJson(join(dir, 'package.json'))).data;
  } catch {
    return false;
  }
  const scripts = (
    typeof pkg.scripts === 'object' && pkg.scripts !== null ? pkg.scripts : {}
  ) as Record<string, unknown>;
  const deps =
    typeof pkg.dependencies === 'object' && pkg.dependencies !== null ? pkg.dependencies : {};
  const published =
    pkg.private !== true && ['exports', 'files', 'publishConfig'].some((k) => pkg[k] !== undefined);
  const entries = new Set(
    [pkg.main, pkg.module, ...exportPaths(pkg.exports)]
      .filter((v): v is string => typeof v === 'string')
      .map(moduleKey),
  );
  const devElsewhere = scriptFiles(scripts).some((f) => !entries.has(moduleKey(f)));
  const runs =
    ['start', 'serve'].some((n) => n in scripts) ||
    pkg.bin !== undefined ||
    (published ? devElsewhere : scriptsRunAFile(scripts) || SERVER_DEPS.some((d) => d in deps));
  // `bun init` names the app's own entry in `module`: not library evidence on Bun
  const keys = ['main', 'exports', ...(bun ? [] : ['module'])];
  // peer dependencies are library evidence only for a package that can be published; on Bun a lone
  // `typescript` peer is what `bun init` writes into every project, so it says nothing there
  const peers =
    pkg.private !== true &&
    typeof pkg.peerDependencies === 'object' &&
    pkg.peerDependencies !== null
      ? Object.keys(pkg.peerDependencies).filter((p) => !(bun && p === 'typescript'))
      : [];
  return (keys.some((k) => pkg[k] !== undefined) || peers.length > 0) && !runs;
}

/** Vite only reads `VITE_*` variables from the package root's .env files: these settings break that. */
async function viteEnvChanged(dir: string): Promise<string | undefined> {
  const file = await findConfigFile(dir, 'vite.config');
  if (file === undefined) return undefined;
  const text = await readFile(file, 'utf8').catch(() => '');
  return /\b(?:envDir|envPrefix)\b|\broot\s*:/.exec(text)?.[0].replace(/\s*:$/, '');
}

/**
 * Which plain runtime to install and initialise the SDK for. Frameworks and the runtimes without a
 * recipe yet are skipped (the build-tool recipe still runs). A project that is both a web page and a
 * server is a question for the user: a non-interactive run skips rather than guess.
 */
export async function chooseRuntime(
  det: JsDetection,
  opts: WizardOptions,
  prompts: Prompts,
): Promise<RuntimeChoice> {
  if (opts.runtime === 'none') {
    return { skip: 'not initialising the SDK in code (--runtime none).', silent: true };
  }
  if (det.framework !== undefined) {
    return {
      skip: `${det.framework} projects: installing and initialising the SDK for a framework is not automated yet.`,
    };
  }
  // an explicit choice beats every guess below (unknown runtime, ambiguity, library)
  if (opts.runtime !== undefined) return choose(opts.runtime, det);
  if (det.runtimeUnknown === true) {
    const reason =
      'nothing in this project says where it runs (no page, server library or entry script was found), so the wizard will not guess: pass --runtime browser, node or bun.';
    if (opts.nonInteractive) return { skip: reason };
    const answer = await prompts.select(
      'Nothing says where this project runs. Which runtime is it?',
      [
        ...SUPPORTED.map((r) => ({ value: r, label: LABEL[r] })),
        { value: 'skip', label: 'Not now: show me what to add' },
      ],
    );
    const picked = SUPPORTED.find((r) => r === answer);
    return picked === undefined ? { skip: reason } : choose(picked, det);
  }
  const found = SUPPORTED.filter((r) => det.runtimes.includes(r));
  // a front end built with bun as its package manager reports bun too, but runs in the browser
  const candidates =
    found.includes('browser') && !found.includes('node') ? ['browser' as const] : found;
  const [first, ...rest] = candidates;
  if (first === undefined) {
    return {
      skip: `the ${det.runtimes.join(', ')} runtime is not automated yet (only browser, Node.js and Bun are).`,
    };
  }
  const server = !candidates.includes('browser');
  if (server && (await looksLikeLibrary(det.packageDir, candidates.includes('bun')))) {
    return {
      skip: 'this package looks like a library (an entry point and nothing that starts it): initialising Bugsee there would run it inside every app that imports the library. Add the SDK to your application, or pass --runtime if this is an app.',
    };
  }
  if (rest.length === 0) return choose(first, det);
  // a server on Bun reports node as well: bun is the more specific answer
  if (server && candidates.includes('bun')) return choose('bun', det);
  const names = candidates.map((r) => LABEL[r]).join(' and ');
  if (opts.nonInteractive) {
    return {
      skip: `this project runs in both ${names}; pass --runtime to choose, or run the wizard interactively.`,
    };
  }
  const answer = await prompts.select(
    'This project runs in several runtimes. Which one should the SDK be set up for?',
    candidates.map((r) => ({ value: r, label: LABEL[r] })),
  );
  return choose(candidates.find((r) => r === answer) ?? first, det);
}
