import type { WizardOptions } from '../core/context.js';
import type { Logger } from '../core/logger.js';
import type { ManualSnippet } from '../core/step.js';
import { type EntryFile, findEntry } from '../engine/entry-detect.js';
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
import { memberAccess, sdkInitSnippet } from '../engine/sdk-init-ast.js';
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
import { chooseRuntime, type RuntimeChoice } from './runtime.js';
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
  return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, (c) => {
    const n = c.charCodeAt(0);
    return n > 0xff
      ? `\\u${n.toString(16).padStart(4, '0')}`
      : `\\x${n.toString(16).padStart(2, '0')}`;
  });
}

function inline(s: string): string {
  const cut =
    s.length > PLAN_MAX_INLINE
      ? `${s.slice(0, PLAN_MAX_INLINE)}... (${s.length - PLAN_MAX_INLINE} more characters)`
      : s;
  // a single-line field must not be able to start a plan line of its own
  return visible(cut.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t'));
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
function opDetails(
  op: OpSpec,
  pm: DetectedPackageManager | null,
  entry: EntryFile | undefined,
): string[] {
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
    case 'add-sdk-init': {
      const expr = op.tokenExpr;
      const where =
        entry === undefined
          ? 'no entry file was found: a snippet to paste will be shown instead'
          : `edits ${inline(entry.file)} (found via ${inline(entry.via)})`;
      return [
        `      ${where}`,
        `      adds import { launch } from "${inline(op.importFrom)}" (as bugseeLaunch if \`launch\` is taken) and ${
          expr === undefined
            ? 'launch(your token)'
            : `if (${inline(memberAccess(expr))}) launch(${inline(memberAccess(expr))})`
        }`,
      ];
    }
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

function planText(
  recipe: Recipe,
  pm: DetectedPackageManager | null,
  entry: EntryFile | undefined,
  setUp: ReadonlyMap<OpSpec, string>,
): string {
  return [
    'Planned changes:',
    ...recipe.ops.flatMap((op) => [
      `  - ${opToStep(op).title}`,
      ...(setUp.has(op)
        ? [`      already set up: nothing to change (${inline(setUp.get(op) ?? '')})`]
        : opDetails(op, pm, entry)),
    ]),
  ].join('\n');
}

/** The adapter package(s) and guide of the frameworks, whose init is not automated yet. */
const FRAMEWORK_GUIDE: Record<string, { name: string; slug: string; packages: string[] }> = {
  nextjs: { name: 'Next.js', slug: 'nextjs', packages: ['@bugsee/nextjs'] },
  nuxt: { name: 'Nuxt', slug: 'nuxt', packages: ['@bugsee/nuxt'] },
  sveltekit: { name: 'SvelteKit', slug: 'sveltekit', packages: ['@bugsee/sveltekit'] },
  astro: { name: 'Astro', slug: 'astro', packages: ['@bugsee/astro'] },
  remix: { name: 'Remix / React Router', slug: 'remix', packages: ['@bugsee/remix'] },
  angular: { name: 'Angular', slug: 'angular', packages: ['@bugsee/bugsee', '@bugsee/angular'] },
  electron: { name: 'Electron', slug: 'electron', packages: ['@bugsee/electron'] },
};

function installCommand(pm: DetectedPackageManager | null, ...pkgs: string[]): string {
  return `${pm?.name ?? 'npm'} ${(pm?.installArgs(pkgs, false) ?? ['install', ...pkgs]).join(' ')}`;
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

  const resolve = async (platform: string): Promise<ResolvedRecipe | WizardRunResult> => {
    try {
      const found = await deps.resolveRecipe({ platform, sdkVersion, engine: WIZARD_VERSION });
      if (found.warning !== undefined) log.warn(found.warning);
      return found;
    } catch (err) {
      if (!(err instanceof RecipeStoreError)) throw err;
      log.error(err.message);
      return failed('recipe-unavailable', err.message);
    }
  };

  // The runtime recipe (SDK install + init) comes first, the build-tool recipe (source maps) after it.
  const choice: RuntimeChoice = await chooseRuntime(det, opts, deps.prompts);
  let runtimeRecipe: ResolvedRecipe | undefined;
  if ('skip' in choice) {
    log.info(`Skipping SDK install and init: ${choice.skip}`);
  } else {
    if (choice.note !== undefined) log.info(choice.note);
    const found = await resolve(choice.platform);
    if ('ok' in found) return found;
    runtimeRecipe = found;
  }
  const buildTool = await resolve(`javascript-${det.buildTool ?? 'cli'}`);
  if ('ok' in buildTool) return buildTool;

  const parts = [runtimeRecipe, buildTool].flatMap((r) => (r === undefined ? [] : [r]));
  const recipe: Recipe = {
    ...buildTool.recipe,
    ops: [...parts.flatMap((r) => r.recipe.ops), IGNORE_MANIFEST_DIR],
  };
  const recorder = createManifestRecorder(
    packageDir,
    {
      wizard: WIZARD_VERSION,
      recipes: parts.map((r) => ({ id: r.recipe.id, revision: r.revision })),
    },
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
  const entry =
    runtimeRecipe !== undefined && !('skip' in choice)
      ? await findEntry(packageDir, choice.runtime)
      : undefined;
  // an init that is already done (a re-run) must not be promised as an edit in the plan
  const setUp = new Map<OpSpec, string>();
  for (const op of recipe.ops) {
    if (op.op !== 'add-sdk-init') continue;
    // the plan is advice: a check that cannot run just leaves the plan as it was
    const status = await opToStep(op)
      .precheck(ctx)
      .catch(() => undefined);
    if (status?.kind === 'satisfied') setUp.set(op, status.note ?? 'Bugsee is already set up');
  }
  log.info(planText(recipe, packageManager, entry, setUp));
  for (const r of parts) if (r.recipe.notes !== undefined) log.info(`Notes:\n${r.recipe.notes}`);
  if (!opts.nonInteractive && !opts.yes && !opts.dryRun) {
    if (!(await deps.prompts.confirm('Apply these changes?'))) throw new CancelledError();
  }

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
  // every step rolled back: the manifest must not list changes that are gone. When a rollback
  // failed, edits are still on disk, so the manifest and its backups are the only way back.
  if (run.failed && !opts.dryRun && run.rollbackFailed !== true) await recorder.discard();
  if (run.rollbackFailed === true) {
    log.error(
      'Some changes could not be rolled back. The wizard manifest was kept: run `bugsee-wizard uninstall` to revert them.',
    );
  }
  for (const w of quarantineWarnings) log.warn(w);

  // a skipped runtime is an unfinished step (exit 3 non-interactively), unless the user chose it
  const skipped = 'skip' in choice && choice.silent !== true ? choice.skip : undefined;
  const snippet = (cjs: boolean): string =>
    sdkInitSnippet(
      { importFrom: '@bugsee/bugsee', token: '', fileName: 'main.ts', runtime: 'node' },
      cjs,
    );
  const adapter = det.framework === undefined ? undefined : FRAMEWORK_GUIDE[det.framework];
  const skipCode = (): string =>
    adapter !== undefined
      ? [
          `// Not applied: ${skipped}`,
          `// First install the SDK: ${installCommand(packageManager, ...adapter.packages.map((p) => `${p}@beta`))}`,
          `// Then follow the setup guide for ${adapter.name}: https://docs.bugsee.com/${adapter.slug}`,
        ].join('\n')
      : [
          `// Not applied: ${skipped}`,
          `// First install the SDK: ${installCommand(packageManager, '@bugsee/bugsee@beta')}`,
          '',
          '// ES modules:',
          snippet(false),
          '',
          '// CommonJS:',
          snippet(true),
        ].join('\n');
  const skipSnippet: ManualSnippet[] =
    skipped === undefined
      ? []
      : [{ file: 'your entry file', title: 'Initialise Bugsee in your app', code: skipCode() }];
  // a failed run rolled everything back (unless a rollback itself failed): its snippets describe changes
  // that are gone, and printing them would send the user to finish work that was undone
  const snippets =
    run.failed && run.rollbackFailed !== true
      ? []
      : [
          ...skipSnippet,
          ...run.results.flatMap((r) => (r.snippet === undefined ? [] : [r.snippet])),
        ];
  for (const s of snippets) log.warn(snippetText(s));

  const result: WizardRunResult = {
    ok: !run.failed,
    incomplete: run.incomplete || skipped !== undefined,
    steps: [
      ...(skipped === undefined ? [] : [{ id: 'add-sdk-init', outcome: 'manual' as const }]),
      ...run.results.map((r) => ({ id: r.id, outcome: r.outcome })),
    ],
    ...(snippets.length > 0
      ? { snippets: snippets.map((s) => ({ file: s.file, title: s.title, code: s.code })) }
      : {}),
    ...(run.failed
      ? caught !== undefined
        ? {
            error: caught === 'SIGINT' ? 'interrupted' : 'terminated',
            message: run.rollbackFailed
              ? 'Interrupted; some changes could not be rolled back. Run `bugsee-wizard uninstall` to revert them.'
              : 'Interrupted; the changes made so far were rolled back.',
          }
        : {
            error: 'step-failed',
            message: run.rollbackFailed
              ? 'A step failed and some changes could not be rolled back. Run `bugsee-wizard uninstall` to revert them.'
              : 'A step failed; the changes made so far were rolled back.',
          }
      : {}),
  };
  if (opts.dryRun) log.info('Dry run: nothing was written.');
  else if (!run.failed) outro(log, packageManager, run.incomplete || skipped !== undefined);
  return result;
}
