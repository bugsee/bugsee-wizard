import type { WizardOptions } from '../core/context.js';
import type { Logger } from '../core/logger.js';
import type { ManualSnippet } from '../core/step.js';
import { executeRecipe } from '../engine/execute.js';
import { createManifestRecorder, rollbackFromManifest } from '../engine/manifest.js';
import {
  CancelledError,
  createOutput,
  type Output,
  type WizardRunResult,
} from '../engine/noninteractive.js';
import { opToStep } from '../engine/ops/index.js';
import { type DetectedPackageManager, detectPackageManager } from '../engine/package-manager.js';
import type { OpSpec, Recipe, RecipeContext } from '../engine/recipe.js';
import {
  type RecipeQuery,
  RecipeStoreError,
  type ResolvedRecipe,
  resolveRecipe,
} from '../engine/recipe-store.js';
import { WIZARD_VERSION } from '../engine/telemetry.js';
import { selectTokenSource } from '../engine/token.js';
import { detectJavaScript, type JsDetection } from './detect.js';
import { choosePackage } from './package-choice.js';
import {
  checkGit,
  describeGitState,
  type GitState,
  probeGit,
  withoutWizardChanges,
} from './preconditions.js';
import { clackPrompts, type Prompts } from './prompts.js';
import { resolveSdkVersion, type SdkVersionQuery } from './sdk-version.js';
import { checkSupported, SDK_TAG } from './versions.js';

/** Every outside effect of a run, injectable for tests. */
export interface Deps {
  detect(cwd: string): Promise<JsDetection | null>;
  resolveRecipe(q: RecipeQuery): Promise<ResolvedRecipe>;
  resolveSdkVersion(q: SdkVersionQuery): Promise<string>;
  selectTokenSource: typeof selectTokenSource;
  detectPackageManager(dir: string): Promise<DetectedPackageManager | null>;
  prompts: Prompts;
  git(dir: string): Promise<GitState>;
  rollback: typeof rollbackFromManifest;
  env: NodeJS.ProcessEnv;
  output: Output;
}

export function defaultDeps(opts: WizardOptions, over: Partial<Deps> = {}): Deps {
  return {
    detect: (cwd) => detectJavaScript(cwd),
    resolveRecipe,
    resolveSdkVersion,
    selectTokenSource,
    detectPackageManager,
    prompts: clackPrompts,
    git: (dir) => probeGit(dir),
    rollback: rollbackFromManifest,
    env: process.env,
    output: createOutput({ json: opts.json, debug: opts.debug }),
    ...over,
  };
}

/**
 * The manifest lives in `.bugsee/`, which must be git-ignored. The wizard does that through an
 * ordinary recorded step (not the recorder's own side effect) so uninstall reverts it with the rest.
 */
const IGNORE_MANIFEST_DIR: OpSpec = { op: 'ensure-gitignore', line: '.bugsee/' };

/** Stands in for the token in a dry run without one. Never written or printed (nothing is, in a dry run). */
const DRY_RUN_TOKEN = 'dry-run-token';

/**
 * The git precondition. `--ignore-git-changes` skips the probe entirely; a dry run only notes the
 * state; otherwise the wizard's own earlier changes are excused and checkGit decides.
 */
async function gitPrecondition(
  opts: WizardOptions,
  deps: Deps,
  packageDir: string,
): Promise<WizardRunResult | undefined> {
  const log = deps.output.log;
  if (opts.ignoreGitChanges) {
    log.warn('Skipping the git check (--ignore-git-changes).');
    return undefined;
  }
  const state = await withoutWizardChanges(await deps.git(packageDir), packageDir);
  if (opts.dryRun) {
    const note = describeGitState(state);
    if (note !== undefined) log.info(`${note}\n(dry run: not a reason to stop)`);
    return undefined;
  }
  const git = await checkGit(state, opts, { confirm: (m) => deps.prompts.confirm(m), log });
  if (git.ok) return undefined;
  log.error(git.message);
  return failed(git.error, git.message);
}

export const failed = (error: string, message: string): WizardRunResult => ({
  ok: false,
  incomplete: false,
  steps: [],
  error,
  message,
});

/** Detection plus the package choice: the directory a JavaScript run works in. */
export async function locatePackage(
  opts: WizardOptions,
  deps: Deps,
): Promise<{ det: JsDetection } | { result: WizardRunResult }> {
  const log = deps.output.log;
  const first = await deps.detect(opts.cwd);
  if (first === null) {
    return { result: failed('no-project', `No JavaScript project found in ${opts.cwd}.`) };
  }
  const choice = await choosePackage(first, opts, deps.prompts);
  if (!choice.ok) return { result: failed('package-not-found', choice.message) };
  const det = choice.dir === first.packageDir ? first : await deps.detect(choice.dir);
  if (det === null || det.needsPackageChoice) {
    return { result: failed('no-project', `No JavaScript project found in ${choice.dir}.`) };
  }
  if (det.startedIn !== undefined) log.info(`Using the project at ${det.packageDir}.`);
  return { det };
}

function planText(recipe: Recipe): string {
  return ['Planned changes:', ...recipe.ops.map((op) => `  - ${opToStep(op).title}`)].join('\n');
}

function snippetText(s: ManualSnippet): string {
  return `${s.title} (${s.file}):\n${s.code}`;
}

function outro(log: Logger, pm: DetectedPackageManager | null): void {
  const run = `${pm?.name ?? 'npm'} run build`;
  log.info(
    [
      `To verify: build in production mode (for example \`${run}\`).`,
      'The build output should show the Bugsee CLI uploading your source maps.',
    ].join('\n'),
  );
}

export async function runJavaScriptInstall(
  opts: WizardOptions,
  overrides: Partial<Deps> = {},
): Promise<WizardRunResult> {
  const deps = defaultDeps(opts, overrides);
  const log = deps.output.log;

  const located = await locatePackage(opts, deps);
  if ('result' in located) {
    log.error(located.result.message ?? '');
    return located.result;
  }
  const { det } = located;
  const packageDir = det.packageDir;
  for (const w of checkSupported(det).warnings) log.warn(w);

  const blocked = await gitPrecondition(opts, deps, packageDir);
  if (blocked !== undefined) return blocked;

  const tokenSource = deps.selectTokenSource({
    ...(opts.token === undefined ? {} : { flag: opts.token }),
    env: deps.env,
    nonInteractive: opts.nonInteractive,
  });
  // a dry run writes nothing, so it never asks for a token: the placeholder only feeds the plan
  const token =
    opts.dryRun && tokenSource.kind === 'paste' ? DRY_RUN_TOKEN : await tokenSource.get();

  const packageManager = await deps.detectPackageManager(packageDir);
  const sdkVersion = await deps.resolveSdkVersion({
    tag: SDK_TAG,
    log,
    ...(opts.sdkVersion === undefined ? {} : { override: opts.sdkVersion }),
  });
  log.debug(`Resolving recipes for SDK ${sdkVersion}.`);

  let resolved: ResolvedRecipe;
  try {
    resolved = await deps.resolveRecipe({
      platform: `javascript-${det.buildTool ?? 'cli'}`,
      sdkVersion,
      engine: WIZARD_VERSION,
    });
  } catch (err) {
    if (!(err instanceof RecipeStoreError)) throw err;
    log.error(err.message);
    return failed('recipe-unavailable', err.message);
  }
  if (resolved.warning !== undefined) log.warn(resolved.warning);

  const recipe: Recipe = { ...resolved.recipe, ops: [...resolved.recipe.ops, IGNORE_MANIFEST_DIR] };
  log.info(planText(recipe));
  if (!opts.nonInteractive && !opts.yes && !opts.dryRun) {
    if (!(await deps.prompts.confirm('Apply these changes?'))) throw new CancelledError();
  }

  const recorder = createManifestRecorder(
    packageDir,
    { wizard: WIZARD_VERSION, recipes: [{ id: recipe.id, revision: resolved.revision }] },
    { cwd: packageDir, ignoreInGit: false },
  );
  const ctx: RecipeContext = {
    ...opts,
    cwd: packageDir,
    kind: 'javascript',
    tokens: {},
    log,
    packageDir,
    packageManager,
    token,
    manifest: recorder,
  };
  const run = await executeRecipe(recipe, ctx);

  if (!run.failed && !opts.dryRun) {
    const { quarantined } = await recorder.flush();
    if (quarantined !== undefined) {
      log.warn(
        `The previous wizard manifest could not be read; it was moved to ${quarantined} and a new one was written.`,
      );
    }
  }

  const snippets = run.results.flatMap((r) => (r.snippet === undefined ? [] : [r.snippet]));
  for (const s of snippets) log.warn(snippetText(s));

  const result: WizardRunResult = {
    ok: !run.failed,
    incomplete: run.incomplete,
    steps: run.results.map((r) => ({ id: r.id, outcome: r.outcome })),
    ...(snippets.length > 0
      ? { snippets: snippets.map((s) => ({ file: s.file, title: s.title, code: s.code })) }
      : {}),
    ...(run.failed
      ? {
          error: 'step-failed',
          message: 'A step failed; the changes made so far were rolled back.',
        }
      : {}),
  };
  if (opts.dryRun) log.info('Dry run: nothing was written.');
  else if (!run.failed) outro(log, packageManager);
  return result;
}
