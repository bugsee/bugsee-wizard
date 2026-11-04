import { type RunStepsResult, runSteps } from '../core/step.js';
import { opToStep } from './ops/index.js';
import type { Recipe, RecipeContext } from './recipe.js';

/** Build one step per recipe op and run them through the shared step runner. */
export function executeRecipe(recipe: Recipe, ctx: RecipeContext): Promise<RunStepsResult> {
  return runSteps(recipe.ops.map(opToStep), ctx);
}
