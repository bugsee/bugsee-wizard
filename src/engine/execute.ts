import type { Step } from '../core/step.js';
import { type RunStepsResult, runSteps } from '../core/step.js';
import { opToStep } from './ops/index.js';
import type { Recipe, RecipeContext } from './recipe.js';

/** The run was interrupted (Ctrl-C / SIGTERM): the steps applied so far are rolled back. */
export class InterruptedError extends Error {
  constructor() {
    super('interrupted');
    this.name = 'InterruptedError';
  }
}

export interface ExecuteOptions {
  /**
   * Called after each step that applied (never in a dry run), before the next step starts. Persist the
   * manifest here so it is always a prefix of what was done. If it throws, that step is rolled back
   * and the run fails like any failing step.
   */
  onStepApplied?: (step: Step<RecipeContext>) => Promise<void>;
  /** Checked before each step applies; once aborted the run stops and rolls back what was applied. */
  signal?: AbortSignal;
}

function guarded(step: Step<RecipeContext>, opts: ExecuteOptions): Step<RecipeContext> {
  return {
    ...step,
    async apply(ctx) {
      if (opts.signal?.aborted) throw new InterruptedError();
      const res = await step.apply(ctx);
      if (opts.onStepApplied !== undefined) {
        try {
          await opts.onStepApplied(step);
        } catch (err) {
          // the step wrote files the manifest does not know about: undo it, it is not in `applied` yet
          await step.rollback(ctx).catch(() => undefined);
          const why = err instanceof Error ? err.message : String(err);
          throw new Error(`Could not record the change in the wizard manifest: ${why}`);
        }
      }
      return res;
    },
  };
}

/** Build one step per recipe op and run them through the shared step runner. */
export function executeRecipe(
  recipe: Recipe,
  ctx: RecipeContext,
  opts: ExecuteOptions = {},
): Promise<RunStepsResult> {
  return runSteps(
    recipe.ops.map((op) => guarded(opToStep(op), opts)),
    ctx,
  );
}
