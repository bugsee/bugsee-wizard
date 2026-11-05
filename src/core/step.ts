import type { WizardContext } from './context.js';

export type StepStatus =
  | { readonly kind: 'pending' }
  | { readonly kind: 'satisfied'; readonly note?: string }
  | { readonly kind: 'blocked'; readonly reason: string };

export interface Step<Ctx extends WizardContext = WizardContext> {
  readonly id: string;
  readonly title: string;
  precheck(ctx: Ctx): Promise<StepStatus>;
  // biome-ignore lint/suspicious/noConfusingVoidType: existing steps return nothing; void keeps them assignable.
  apply(ctx: Ctx): Promise<ApplyResult | void>;
  rollback(ctx: Ctx): Promise<void>;
}

/**
 * `planned` = the step would run (or roll back) but `dryRun` skipped it; nothing was changed.
 */
export type StepOutcome =
  | 'applied'
  | 'skipped'
  | 'blocked'
  | 'failed'
  | 'rolled-back'
  | 'manual'
  | 'planned';

/** A code change the wizard could not apply itself; the user must make it. */
export interface ManualSnippet {
  readonly file: string;
  readonly title: string;
  readonly code: string;
}

export interface ApplyResult {
  readonly manual?: ManualSnippet;
  /**
   * With `manual`: the step also changed something before handing the rest to
   * the user, so it stays rollback-covered if a later step fails.
   */
  readonly applied?: boolean;
}

export interface StepResult {
  readonly id: string;
  readonly outcome: StepOutcome;
  readonly note?: string;
  readonly error?: Error;
  readonly snippet?: ManualSnippet;
}

export interface RunStepsResult {
  readonly results: readonly StepResult[];
  readonly failed: boolean;
  /** True when at least one step needs a manual follow-up. */
  readonly incomplete: boolean;
  /** True when undoing an applied step threw: its changes may still be on disk. */
  readonly rollbackFailed?: boolean;
}

export interface RunStepsOptions {
  /** Polled before each step and after the last: true stops the run and rolls back what was applied. */
  readonly interrupted?: () => boolean;
}

export async function runSteps<Ctx extends WizardContext>(
  steps: readonly Step<Ctx>[],
  ctx: Ctx,
  opts: RunStepsOptions = {},
): Promise<RunStepsResult> {
  const results: StepResult[] = [];
  const applied: Step<Ctx>[] = [];
  let incomplete = false;

  const stop = async (): Promise<RunStepsResult> => {
    const rollbackFailed = await rollbackAll(applied, ctx, results);
    return { results, failed: true, incomplete, rollbackFailed };
  };

  for (const step of steps) {
    const status = await step.precheck(ctx);
    if (opts.interrupted?.() === true) return stop();

    if (status.kind === 'satisfied') {
      results.push({
        id: step.id,
        outcome: 'skipped',
        ...(status.note !== undefined ? { note: status.note } : {}),
      });
      ctx.log.info(`${step.title} — already done`);
      continue;
    }

    if (status.kind === 'blocked') {
      results.push({ id: step.id, outcome: 'blocked', note: status.reason });
      ctx.log.error(`${step.title} — blocked: ${status.reason}`);
      return stop();
    }

    try {
      if (ctx.dryRun) {
        ctx.log.step(`${step.title} (dry-run)`);
        results.push({ id: step.id, outcome: 'planned' });
      } else {
        const res = await step.apply(ctx);
        if (res?.manual) {
          incomplete = true;
          if (res.applied === true) applied.push(step);
          results.push({ id: step.id, outcome: 'manual', snippet: res.manual });
          ctx.log.warn(`${step.title} — manual step required`);
        } else {
          applied.push(step);
          results.push({ id: step.id, outcome: 'applied' });
          ctx.log.success(step.title);
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      results.push({ id: step.id, outcome: 'failed', error });
      ctx.log.error(`${step.title} — failed: ${error.message}`);
      return stop();
    }
  }

  if (opts.interrupted?.() === true) return stop();
  return { results, failed: false, incomplete };
}

async function rollbackAll<Ctx extends WizardContext>(
  applied: readonly Step<Ctx>[],
  ctx: Ctx,
  results: StepResult[],
): Promise<boolean> {
  let anyFailed = false;
  for (const step of [...applied].reverse()) {
    try {
      if (!ctx.dryRun) await step.rollback(ctx);
      results.push({ id: step.id, outcome: 'rolled-back' });
      ctx.log.warn(`Rolled back: ${step.title}`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      ctx.log.error(`Failed to roll back ${step.title}: ${error.message}`);
      anyFailed = true;
    }
  }
  return anyFailed;
}

export interface RunRollbackResult {
  readonly results: readonly StepResult[];
  readonly failed: boolean;
}

/**
 * Public entry point for the uninstall flow. Walks `steps` in reverse and
 * calls each `rollback()`. Best-effort — a single step's failure is logged
 * but does not halt the chain (the user is removing things; we want to
 * undo as much as possible). Honours `ctx.dryRun`.
 *
 * Each step's `rollback()` is expected to be a no-op when its target state
 * isn't present, so calling this on a project that was never set up is
 * safe — every step just reports "rolled back" with no file changes.
 */
export async function runRollback<Ctx extends WizardContext>(
  steps: readonly Step<Ctx>[],
  ctx: Ctx,
): Promise<RunRollbackResult> {
  const results: StepResult[] = [];
  let anyFailed = false;
  for (const step of [...steps].reverse()) {
    try {
      if (ctx.dryRun) {
        results.push({ id: step.id, outcome: 'planned' });
        ctx.log.step(`Would roll back: ${step.title} (dry-run)`);
      } else {
        await step.rollback(ctx);
        results.push({ id: step.id, outcome: 'rolled-back' });
        ctx.log.success(`Rolled back: ${step.title}`);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      results.push({ id: step.id, outcome: 'failed', error });
      ctx.log.error(`${step.title} — failed: ${error.message}`);
      anyFailed = true;
    }
  }
  return { results, failed: anyFailed };
}
