/** Outcome of an install recipe. `cancelled` = the user backed out (not an error). */
export type RecipeResult = 'ok' | 'cancelled' | 'failed';

/**
 * Outcome of an uninstall recipe. `not-found` = no project of that kind at
 * the target directory, so no rollback was attempted.
 */
export type RollbackResult = 'ok' | 'failed' | 'not-found';
