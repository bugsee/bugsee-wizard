import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Step } from '../../core/step.js';
import { ensureGitignoreLine } from '../gitignore.js';
import type { OpSpec, RecipeContext } from '../recipe.js';
import { manifestPath, readBytes, restoreBytes, text } from './shared.js';

type Spec = Extract<OpSpec, { op: 'ensure-gitignore' }>;

export function ensureGitignoreStep(spec: Spec): Step<RecipeContext> {
  let before: Buffer | null | undefined;
  const target = (ctx: RecipeContext): string => join(ctx.packageDir, '.gitignore');
  return {
    id: `ensure-gitignore:${spec.line}`,
    title: `Git-ignore ${spec.line}`,
    async precheck(ctx) {
      const current = await readBytes(target(ctx));
      if (current === null) return { kind: 'pending' };
      // Ask the (glob-aware) helper on a scratch copy so the real file is never touched.
      const scratch = await mkdtemp(join(tmpdir(), 'bugsee-gi-'));
      try {
        await writeFile(join(scratch, '.gitignore'), current);
        const outcome = await ensureGitignoreLine(scratch, spec.line);
        return outcome === 'present' ? { kind: 'satisfied' } : { kind: 'pending' };
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
    async apply(ctx) {
      const path = target(ctx);
      before = await readBytes(path);
      const outcome = await ensureGitignoreLine(ctx.packageDir, spec.line);
      if (outcome === 'present') return;
      ctx.manifest.record({
        file: manifestPath(ctx, path),
        action: outcome === 'created' ? 'created' : 'edited',
        ...(before !== null ? { before: text(before) as string } : {}),
        after: await readFile(path, 'utf8'),
      });
    },
    async rollback(ctx) {
      if (before === undefined) return;
      await restoreBytes(target(ctx), before);
    },
  };
}
