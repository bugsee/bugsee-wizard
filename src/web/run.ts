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
import { runScriptCommand } from '../engine/ops/add-package-script.js';
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
  /** Where interrupt signals are caught for the length of a run (the process, outside tests). */
  signals: SignalHost;
}

export type InterruptSignal = 'SIGINT' | 'SIGTERM';
export interface SignalHost {
  on(signal: InterruptSignal, handler: () => void): void;
  off(signal: InterruptSignal, handler: () => void): void;
  exit(code: number): void;
}
const SIGNAL_CODE: Record<InterruptSignal, number> = { SIGINT: 130, SIGTERM: 143 };
const processSignals: SignalHost = {
  on: (sig, h) => void process.on(sig, h),
  off: (sig, h) => void process.off(sig, h),
  exit: (code) => process.exit(code),
};

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
    signals: processSignals,
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

const PLAN_MAX_INLINE = 2000;
const PLAN_PREVIEW_LINES = 8;
const PLAN_PREVIEW_WIDTH = 120;

/** Control characters (ANSI escapes included) shown as visible `\xNN`, so a recipe cannot repaint the plan. */
function visible(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
  return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (c) => {
    return `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`;
  });
}

function inline(s: string): string {
  const cut =
    s.length > PLAN_MAX_INLINE
      ? `${s.slice(0, PLAN_MAX_INLINE)}... (${s.length - PLAN_MAX_INLINE} more characters)`
      : s;
  return visible(cut);
}

function preview(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const shown = lines.slice(0, PLAN_PREVIEW_LINES).map((l) => {
    const v = visible(l);
    return v.length > PLAN_PREVIEW_WIDTH ? `${v.slice(0, PLAN_PREVIEW_WIDTH)}...` : v;
  });
  const rest = lines.length - shown.length;
  return [
    ...shown.map((l) => `      | ${l}`),
    ...(rest > 0 ? [`      | ... (${rest} more lines)`] : []),
  ];
}

/** What a step will actually write or run: the recipe's free-text fields, shown rather than hidden behind a title. */
function opDetails(op: OpSpec, pm: DetectedPackageManager | null): string[] {
  switch (op.op) {
    case 'install-package': {
      const pkgs = op.packages.map((p) => (op.tag ? `${p}@${op.tag}` : p));
      const cmd =
        pm === null
          ? `npm install ${op.dev ? '-D ' : ''}${pkgs.join(' ')}`
          : `${pm.name} ${pm.installArgs(pkgs, op.dev === true).join(' ')}`;
      return [`      runs: ${inline(cmd)}`];
    }
    case 'add-package-script':
      return [
        `      script "${inline(op.name)}": ${inline(op.command)}`,
        ...(op.chainInto === undefined
          ? []
          : [
              `      appended to the "${inline(op.chainInto)}" script: ... && ${inline(runScriptCommand(pm, op.name))}`,
            ]),
      ];
    case 'write-file':
      return [
        `      writes ${inline(op.path)} (${Buffer.byteLength(op.template, 'utf8')} bytes):`,
        ...preview(op.template),
      ];
    case 'add-bundler-plugin':
      return [
        `      adds ${inline(`${op.importName}(${op.callArgs})`)} to the ${op.target} plugins, imported from "${inline(op.importFrom)}"`,
      ];
    case 'set-json-key':
      return [
        `      sets ${inline(op.path.join('.'))} in ${inline(op.file)} to ${inline(JSON.stringify(op.value))}`,
      ];
    case 'ensure-gitignore':
      return [`      adds the line ${inline(op.line)} to .gitignore if missing`];
    case 'write-env-var':
      return [`      sets ${inline(op.key)} in ${inline(op.file)} from your token`];
    default:
      return [];
  }
}

function planText(recipe: Recipe, pm: DetectedPackageManager | null): string {
  return [
    'Planned changes:',
    ...recipe.ops.flatMap((op) => [`  - ${opToStep(op).title}`, ...opDetails(op, pm)]),
  ].join('\n');
}

function snippetText(s: ManualSnippet): string {
  return `${s.title} (${s.file}):\n${s.code}`;
}

function outro(log: Logger, pm: DetectedPackageManager | null, incomplete: boolean): void {
  const run = `${pm?.name ?? 'npm'} run build`;
  if (incomplete) {
    log.info(
      'Not finished: complete the manual step shown above, then build in production mode to check that source maps upload.',
    );
    return;
  }
  log.info(
    [
      `To verify: build in production mode (for example \`${run}\`).`,
      'With BUGSEE_APP_TOKEN set, the build uploads your source maps (the output shows the Bugsee upload); without it the upload is skipped.',
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
  log.info(planText(recipe, packageManager));
  if (recipe.notes !== undefined) log.info(`Notes:\n${recipe.notes}`);
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
    confirm: (m) => deps.prompts.confirm(m),
  };
  const abort = new AbortController();
  let caught: InterruptSignal | undefined;
  const quarantineWarnings: string[] = [];
  const flush = async (): Promise<void> => {
    const { quarantined } = await recorder.flush();
    if (quarantined !== undefined) {
      quarantineWarnings.push(
        `The previous wizard manifest could not be read; it was moved to ${quarantined} and a new one was written.`,
      );
    }
  };
  const handlers = (['SIGINT', 'SIGTERM'] as const).map((sig) => {
    const handler = (): void => {
      if (caught !== undefined) {
        // second signal: stop now. Every applied step is already in the manifest (flushed per step).
        deps.signals.exit(SIGNAL_CODE[sig]);
        return;
      }
      caught = sig;
      log.warn(
        'Interrupted: finishing the current step, then rolling back what was applied (press again to quit now; run `uninstall` afterwards if anything is left).',
      );
      abort.abort();
    };
    deps.signals.on(sig, handler);
    return [sig, handler] as const;
  });
  let run: Awaited<ReturnType<typeof executeRecipe>>;
  try {
    run = await executeRecipe(recipe, ctx, { onStepApplied: flush, signal: abort.signal });
  } finally {
    for (const [sig, handler] of handlers) deps.signals.off(sig, handler);
  }
  // the steps were rolled back: the manifest must not list changes that are gone
  if (run.failed && !opts.dryRun) await recorder.discard();
  for (const w of quarantineWarnings) log.warn(w);

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
      ? caught !== undefined
        ? {
            error: caught === 'SIGINT' ? 'interrupted' : 'terminated',
            message: 'Interrupted; the changes made so far were rolled back.',
          }
        : {
            error: 'step-failed',
            message: 'A step failed; the changes made so far were rolled back.',
          }
      : {}),
  };
  if (opts.dryRun) log.info('Dry run: nothing was written.');
  else if (!run.failed) outro(log, packageManager, run.incomplete);
  return result;
}
