import { readFile } from 'node:fs/promises';
import type { ApplyResult, Step } from '../../core/step.js';
import type { OpSpec, RecipeContext } from '../recipe.js';
import { resolveInside } from './shared.js';

type Spec = Extract<OpSpec, { op: 'show-snippet' }>;

/**
 * Guidance only: the wizard never edits the file (a framework's config or entry points are the
 * user's), it hands the snippet back as a manual step. Nothing is written, so there is nothing to
 * roll back. `doneWhen` lets a re-run notice that the user already pasted it.
 */
export function showSnippetStep(spec: Spec): Step<RecipeContext> {
  const manual = (): ApplyResult => ({
    manual: { file: spec.file, title: spec.title, code: spec.code },
  });
  return {
    // the file alone is not unique: one config can get a snippet from the SDK recipe and another from the build recipe
    id: `show-snippet:${spec.file}:${spec.title}`,
    title: spec.title,
    async precheck(ctx) {
      for (const rel of spec.doneWhen?.files ?? []) {
        try {
          const text = await readFile(await resolveInside(ctx.packageDir, rel), 'utf8');
          if (text.includes(spec.doneWhen?.contains ?? '')) return { kind: 'satisfied' };
        } catch {
          // missing, unreadable or outside the project: not evidence that it was done
        }
      }
      return { kind: 'pending' };
    },
    async apply(ctx) {
      // uninstall removes the adapter package: say what the user's paste needs removed first
      ctx.manifest.record({
        file: spec.file,
        action: 'manual',
        note: `if you pasted the Bugsee wiring (${spec.title}) here, remove it: it needs the package that is being uninstalled`,
      });
      return manual();
    },
    async preview() {
      return manual();
    },
    async rollback() {},
  };
}
