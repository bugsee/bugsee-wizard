import { basename, dirname, join } from 'node:path';
import type { ApplyResult, ManualSnippet, Step } from '../../core/step.js';
import { hasBugseeMarker } from '../config-ast.js';
import { type EntryFile, findEntry, hasViteClientTypes } from '../entry-detect.js';
import { editTextFile } from '../fs-edit.js';
import { findExistingIntegration } from '../integration-scan.js';
import { readPackageJson } from '../package-json.js';
import type { OpSpec, RecipeContext } from '../recipe.js';
import {
  addSdkInit,
  hasSdkIntegration,
  loadsEnvFile,
  type SdkInitSpec,
  sdkInitSnippet,
} from '../sdk-init-ast.js';
import { manifestPath, readBytes, resolveInside, restoreBytes } from './shared.js';

type Spec = Extract<OpSpec, { op: 'add-sdk-init' }>;

/** The manifest marker of this op's edit (distinct from the bundler plugin's, so uninstall can tell them apart). */
const MANIFEST_MARKER = 'bugsee-wizard:sdk-init';
/** Shown (and recorded) when no entry file could be found: the user knows which file it is. */
const NO_ENTRY = 'your entry file';

async function packageType(dir: string): Promise<string | undefined> {
  try {
    const type = (await readPackageJson(join(dir, 'package.json'))).data.type;
    return typeof type === 'string' ? type : undefined;
  } catch {
    return undefined;
  }
}

/** A script that loads an env file for the process: `--env-file`, dotenv's CLI or `-r dotenv/config`. */
const SCRIPT_LOADS_ENV_RE = /--env-file(?:-if-exists)?\b|\bdotenvx?\b/;
/** The scripts that start the app (a loader in `test` or `lint` does not load anything for `npm start`). */
const START_SCRIPT_RE = /^(?:start|dev|serve)(?::.*)?$/;
/** Files where a platform sets the app's environment. */
const PLATFORM_FILES = [
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
  'Procfile',
  'ecosystem.config.js',
  'ecosystem.config.cjs',
  'ecosystem.config.mjs',
  'fly.toml',
  'render.yaml',
  'app.yaml',
];
const PROVIDES_RE = /BUGSEE_APP_TOKEN|\benv_file\b|--env-file\b/;

async function packageData(dir: string): Promise<Record<string, unknown>> {
  try {
    return (await readPackageJson(join(dir, 'package.json'))).data;
  } catch {
    return {};
  }
}

/**
 * Whether the script that starts the app loads an env file. `npm start` is the start script when
 * there is one (a loader in `dev` does not cover production); otherwise dev/serve/`start:*` count.
 */
async function scriptsLoadEnv(pkg: Record<string, unknown>): Promise<boolean> {
  const scripts = pkg.scripts;
  if (typeof scripts !== 'object' || scripts === null) return false;
  const entries = Object.entries(scripts).filter(([name]) => START_SCRIPT_RE.test(name));
  const used = 'start' in scripts ? entries.filter(([name]) => name === 'start') : entries;
  return used.some(([, c]) => typeof c === 'string' && SCRIPT_LOADS_ENV_RE.test(c));
}

const RESOLVE_SUFFIXES = [
  '',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
  '.jsx',
  '/index.js',
  '/index.ts',
];

/** Whether a module the entry imports (one level, relative paths only) loads an env file. */
async function importedModuleLoadsEnv(entryPath: string, src: string): Promise<boolean> {
  const specs = [
    ...src.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g),
  ]
    .map((m) => m[1] as string)
    .slice(0, 20);
  for (const spec of specs) {
    // TypeScript ESM writes `./env.js` for `env.ts`
    const swapped = spec.replace(/\.([cm]?)js$/, '.$1ts');
    for (const suffix of [...RESOLVE_SUFFIXES, ...(swapped === spec ? [] : ['<ts>'])]) {
      const file = join(dirname(entryPath), suffix === '<ts>' ? swapped : spec + suffix);
      const text = await readBytes(file).then(
        (b) => b?.toString('utf8') ?? null,
        () => null,
      );
      if (text !== null) {
        if (loadsEnvFile(text)) return true;
        break;
      }
    }
  }
  return false;
}

async function platformProvidesEnv(dir: string): Promise<boolean> {
  for (const f of PLATFORM_FILES) {
    const text = await readBytes(join(dir, f)).then(
      (b) => b?.toString('utf8') ?? '',
      () => '',
    );
    if (PROVIDES_RE.test(text)) return true;
  }
  return false;
}

/**
 * Plain Node does not read `.env`: with a token that comes from `process.env` and nothing that loads
 * the file (a start script flag, dotenv in the entry or a module it imports, @nestjs/config, a platform
 * file that sets the variable, or `--env-provided`), the SDK would silently never start.
 */
async function envLoaderMissing(
  spec: Spec,
  ctx: RecipeContext,
  src: string,
  entryPath: string,
): Promise<boolean> {
  if (spec.runtime !== 'node' || spec.tokenExpr?.startsWith('process.env.') !== true) return false;
  if (ctx.envProvided === true || loadsEnvFile(src)) return false;
  const pkg = await packageData(ctx.packageDir);
  const deps = {
    ...(pkg.dependencies as object | undefined),
    ...(pkg.devDependencies as object | undefined),
  };
  return !(
    (await scriptsLoadEnv(pkg)) ||
    '@nestjs/config' in deps ||
    (await importedModuleLoadsEnv(entryPath, src)) ||
    (await platformProvidesEnv(ctx.packageDir))
  );
}

/**
 * Add the SDK import and `launch(...)` to the project's entry file (found by static analysis). The
 * token is never in a title, log line or snippet; with a `tokenExpr` it is not in the code either.
 * An entry that cannot be understood stays untouched and becomes a manual snippet: never a false success.
 */
export function addSdkInitStep(spec: Spec): Step<RecipeContext> {
  let before: Buffer | undefined;
  let editedPath: string | undefined;

  const locate = async (
    ctx: RecipeContext,
  ): Promise<{ entry: EntryFile; path: string } | undefined> => {
    const entry = await findEntry(ctx.packageDir, spec.runtime);
    if (!entry) return undefined;
    return { entry, path: await resolveInside(ctx.packageDir, entry.file) };
  };
  const initSpec = async (ctx: RecipeContext, entry: EntryFile): Promise<SdkInitSpec> => {
    const type = await packageType(ctx.packageDir);
    return {
      importFrom: spec.importFrom,
      token: ctx.token,
      fileName: basename(entry.file),
      runtime: spec.runtime,
      viteClientTypes: await hasViteClientTypes(ctx.packageDir),
      ...(spec.tokenExpr !== undefined ? { tokenExpr: spec.tokenExpr } : {}),
      ...(type !== undefined ? { packageType: type } : {}),
    };
  };

  /** What a snippet is written for when there is no entry file to look at. */
  const probeSpec = (): SdkInitSpec => ({
    importFrom: spec.importFrom,
    token: '',
    fileName: spec.runtime === 'browser' ? 'main.ts' : 'index.ts',
    runtime: spec.runtime,
    ...(spec.tokenExpr !== undefined ? { tokenExpr: spec.tokenExpr } : {}),
  });

  /** One decision path for the real run and the dry run: `write` false changes nothing and records nothing. */
  const perform = async (ctx: RecipeContext, write: boolean): Promise<ApplyResult | undefined> => {
    const record = (entry: Parameters<RecipeContext['manifest']['record']>[0]): void => {
      if (write) ctx.manifest.record(entry);
    };
    const found = await locate(ctx);
    const manual = (file: string, code: string): { manual: ManualSnippet } => {
      record({ file, action: 'manual' });
      const name = file === NO_ENTRY ? NO_ENTRY : basename(file);
      return { manual: { file, title: `Initialise Bugsee in ${name}`, code } };
    };
    const loaderSnippet = async (entry: string): Promise<{ manual: ManualSnippet }> => {
      record({ file: 'package.json', action: 'manual' });
      // a TypeScript entry is not what node runs: name the built file, or say to add the flag
      const main = (await packageData(ctx.packageDir)).main;
      const runnable = /\.[cm]?tsx?$/.test(entry)
        ? typeof main === 'string' && !/\.[cm]?tsx?$/.test(main)
          ? main
          : '<your start command>'
        : entry;
      return {
        manual: {
          file: 'package.json',
          title: 'Give Node the Bugsee token',
          code: [
            '// Node does not read .env by itself. Bugsee will not start until the token is provided to the process.',
            '// Start the app with the env file:',
            runnable.startsWith('<')
              ? `node --env-file=.env ${runnable}   // i.e. add --env-file=.env to the node command you start the app with`
              : `node --env-file=.env ${runnable}`,
            '// or set BUGSEE_APP_TOKEN in the environment (CI, containers, production), or pass --env-provided to the wizard.',
          ].join('\n'),
        },
      };
    };
    // the wizard's own earlier init: nothing to edit, only the token may still be missing
    if (found) {
      const present = (await readBytes(found.path))?.toString('utf8') ?? '';
      if (hasBugseeMarker(present)) {
        return (await envLoaderMissing(spec, ctx, present, found.path))
          ? loaderSnippet(found.entry.file)
          : undefined;
      }
    }
    const existing = await findExistingIntegration(ctx.packageDir, spec.importFrom);
    if (existing !== undefined && existing !== 'unknown') return undefined;
    if (existing === 'unknown') {
      const note =
        '// The project has too many source files to check whether Bugsee is already set up, so nothing was changed.\n// If it is not, add:\n';
      return manual(NO_ENTRY, `${note}${sdkInitSnippet(probeSpec(), false)}`);
    }
    if (!found) {
      const probe = probeSpec();
      // the module system of an entry nobody found is unknown: a server shows both forms
      const esm = sdkInitSnippet(probe, false);
      return manual(
        NO_ENTRY,
        spec.runtime === 'browser'
          ? esm
          : `// ES modules:\n${esm}\n\n// CommonJS:\n${sdkInitSnippet(probe, true)}`,
      );
    }
    const file = manifestPath(ctx, found.path);
    const sdk = await initSpec(ctx, found.entry);
    // the edit is generated from the text this write replaces (read once, inside the write), so a
    // change made by someone else in between is never overwritten with output made from older text
    let snippet: string | undefined;
    let read = '';
    const transform = (current: string): string => {
      read = current;
      const res = addSdkInit(current, sdk);
      if ('manual' in res) {
        snippet = res.manual;
        return current;
      }
      return res.code;
    };
    // a dry run decides exactly like a real run, on the same text, but writes nothing
    const edit = write
      ? await editTextFile(found.path, transform, { validate: (out) => hasBugseeMarker(out) })
      : await (async () => {
          const before = (await readBytes(found.path))?.toString('utf8') ?? '';
          const after = transform(before);
          return { changed: after !== before, before, after };
        })();
    if (snippet !== undefined) return manual(file, snippet);
    if (edit.changed && write) {
      before = Buffer.from(read, 'utf8');
      editedPath = found.path;
      record({
        file,
        action: 'edited',
        before: edit.before,
        after: edit.after,
        marker: MANIFEST_MARKER,
      });
    }
    if (
      hasBugseeMarker(edit.after) &&
      (await envLoaderMissing(spec, ctx, edit.after, found.path))
    ) {
      // the entry edit made in this run stays covered by rollback
      return {
        ...(await loaderSnippet(found.entry.file)),
        ...(edit.changed ? { applied: true } : {}),
      };
    }
    return undefined;
  };

  return {
    id: `add-sdk-init:${spec.runtime}`,
    title: `Initialise the Bugsee SDK in the ${spec.runtime} entry file`,
    async precheck(ctx) {
      if (spec.tokenExpr === undefined && ctx.token === '') {
        return { kind: 'blocked', reason: 'No Bugsee token is available' };
      }
      let found: Awaited<ReturnType<typeof locate>>;
      try {
        found = await locate(ctx);
      } catch (err) {
        return { kind: 'blocked', reason: (err as Error).message };
      }
      const src = found ? ((await readBytes(found.path))?.toString('utf8') ?? '') : '';
      if (hasBugseeMarker(src)) {
        // the wizard's own init: done, unless nothing gives Node the token
        return (await envLoaderMissing(spec, ctx, src, found?.path ?? ''))
          ? { kind: 'pending' }
          : { kind: 'satisfied' };
      }
      const existing = await findExistingIntegration(ctx.packageDir, spec.importFrom);
      // too big to scan: pending, and apply turns it into a snippet (never "not integrated")
      if (existing !== undefined && existing !== 'unknown') {
        return { kind: 'satisfied', note: `Bugsee is already set up (${existing.where})` };
      }
      if (!found) return { kind: 'pending' }; // apply hands back a manual snippet
      return hasSdkIntegration(src) ? { kind: 'satisfied' } : { kind: 'pending' };
    },
    async apply(ctx) {
      return perform(ctx, true);
    },
    async preview(ctx) {
      return perform(ctx, false);
    },
    async rollback() {
      if (before === undefined || editedPath === undefined) return;
      await restoreBytes(editedPath, before);
    },
  };
}
