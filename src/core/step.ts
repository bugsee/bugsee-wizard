import type { WizardContext } from './context.js';

export type StepStatus =
  | { readonly kind: 'pending' }
  | { readonly kind: 'satisfied'; readonly note?: string }
  | { readonly kind: 'blocked'; readonly reason: string };

export interface Step<Ctx extends WizardContext = WizardContext> {
  readonly id: string;
  readonly title: string;
  precheck(ctx: Ctx): Promise<StepStatus>;
  apply(ctx: Ctx): Promise<void>;
  rollback(ctx: Ctx): Promise<void>;
}

/**
 * `planned` = the step would run (or roll back) but `dryRun` skipped it;
 * nothing was changed.
 */
export type StepOutcome = 'applied' | 'skipped' | 'blocked' | 'failed' | 'rolled-back' | 'planned';

export interface StepResult {
  readonly id: string;
  readonly outcome: StepOutcome;
  readonly note?: string;
  readonly error?: Error;
}

export interface RunStepsResult {
  readonly results: readonly StepResult[];
  readonly failed: boolean;
}

export async function runSteps<Ctx extends WizardContext>(
  steps: readonly Step<Ctx>[],
  ctx: Ctx,
): Promise<RunStepsResult> {
  const results: StepResult[] = [];
  const applied: Step<Ctx>[] = [];

  for (const step of steps) {
    const status = await step.precheck(ctx);

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
      await rollbackAll(applied, ctx, results);
      return { results, failed: true };
    }

    try {
      if (ctx.dryRun) {
        ctx.log.step(`${step.title} (dry-run)`);
        results.push({ id: step.id, outcome: 'planned' });
      } else {
        await step.apply(ctx);
        applied.push(step);
        ctx.log.success(step.title);
        results.push({ id: step.id, outcome: 'applied' });
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      results.push({ id: step.id, outcome: 'failed', error });
      ctx.log.error(`${step.title} — failed: ${error.message}`);
      await rollbackAll(applied, ctx, results);
      return { results, failed: true };
    }
  }

  return { results, failed: false };
}

async function rollbackAll<Ctx extends WizardContext>(
  applied: readonly Step<Ctx>[],
  ctx: Ctx,
  results: StepResult[],
): Promise<void> {
  for (const step of [...applied].reverse()) {
    try {
      if (!ctx.dryRun) await step.rollback(ctx);
      results.push({ id: step.id, outcome: 'rolled-back' });
      ctx.log.warn(`Rolled back: ${step.title}`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      ctx.log.error(`Failed to roll back ${step.title}: ${error.message}`);
    }
  }
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
