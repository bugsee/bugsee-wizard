import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Step } from '../../core/step.js';
import { setEnvVar } from '../env-file.js';
import type { OpSpec, RecipeContext } from '../recipe.js';
import { manifestPath, readBytes, resolveInside, restoreBytes } from './shared.js';

type Spec = Extract<OpSpec, { op: 'write-env-var' }>;

/**
 * The token is a secret: it is never placed in a title, log line, snippet, error
 * or manifest entry. The manifest records neither the file's text nor the value.
 */
export function writeEnvVarStep(spec: Spec): Step<RecipeContext> {
  let before: Buffer | null | undefined;
  return {
    id: `write-env-var:${spec.file}:${spec.key}`,
    title: `Write ${spec.key} to ${spec.file}`,
    async precheck(ctx) {
      if (ctx.token === '') return { kind: 'blocked', reason: 'No Bugsee token is available' };
      let path: string;
      try {
        path = await resolveInside(ctx.packageDir, spec.file);
      } catch (err) {
        return { kind: 'blocked', reason: (err as Error).message };
      }
      const current = await readBytes(path);
      if (current === null) return { kind: 'pending' };
      // Run the real setter on a private scratch copy (mkdtemp is 0700, file 0600, removed after).
      const scratch = await mkdtemp(join(tmpdir(), 'bugsee-env-'));
      try {
        const copy = join(scratch, basename(path));
        await writeFile(copy, current, { mode: 0o600 });
        const outcome = await setEnvVar(copy, spec.key, ctx.token);
        return outcome === 'present' ? { kind: 'satisfied' } : { kind: 'pending' };
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
    async apply(ctx) {
      const path = await resolveInside(ctx.packageDir, spec.file);
      before = await readBytes(path);
      const outcome = await setEnvVar(path, spec.key, ctx.token);
      if (outcome === 'conflict') {
        const file = manifestPath(ctx, path);
        ctx.manifest.record({ file, action: 'manual' });
        return {
          manual: {
            file,
            title: `Set ${spec.key} in ${spec.file}`,
            code: `${spec.key}=<your Bugsee app token>`,
          },
        };
      }
      if (outcome === 'present') return undefined;
      ctx.manifest.record({
        file: manifestPath(ctx, path),
        action: before === null ? 'created' : 'edited',
        // no before/after: the file may hold unrelated secrets. The marker lets
        // uninstall remove just this variable's line.
        marker: `env:${spec.key}`,
      });
      return undefined;
    },
    async rollback(ctx) {
      if (before === undefined) return;
      await restoreBytes(await resolveInside(ctx.packageDir, spec.file), before);
    },
  };
}
