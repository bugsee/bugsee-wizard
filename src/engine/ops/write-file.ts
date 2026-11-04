import { mkdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Step } from '../../core/step.js';
import type { OpSpec, RecipeContext } from '../recipe.js';
import { manifestPath, readBytes, resolveInside } from './shared.js';

type Spec = Extract<OpSpec, { op: 'write-file' }>;

export function writeFileStep(spec: Spec): Step<RecipeContext> {
  let created: { path: string; topDir: string | undefined } | undefined;
  return {
    id: `write-file:${spec.path}`,
    title: `Create ${spec.path}`,
    async precheck(ctx) {
      if (spec.template.includes('{{token}}')) {
        return { kind: 'blocked', reason: 'Templates may not contain the token' };
      }
      let path: string;
      try {
        path = await resolveInside(ctx.packageDir, spec.path);
      } catch (err) {
        return { kind: 'blocked', reason: (err as Error).message };
      }
      const current = await readBytes(path);
      if (current === null) return { kind: 'pending' };
      if (current.toString('utf8') === spec.template) return { kind: 'satisfied' };
      return { kind: 'blocked', reason: `${spec.path} already exists with different content` };
    },
    async apply(ctx) {
      const path = await resolveInside(ctx.packageDir, spec.path);
      const topDir = await mkdir(dirname(path), { recursive: true });
      try {
        await writeFile(path, spec.template, { encoding: 'utf8', flag: 'wx' });
      } catch (err) {
        await removeCreatedDirs(path, topDir);
        throw err;
      }
      created = { path, topDir };
      ctx.manifest.record({
        file: manifestPath(ctx, path),
        action: 'created',
        after: spec.template,
      });
    },
    async rollback() {
      if (!created) return;
      const { path, topDir } = created;
      await rm(path, { force: true });
      if (topDir === undefined) return;
      await removeCreatedDirs(path, topDir);
    },
  };
}

/** Remove only the directories this step created, innermost first, and only when empty. */
async function removeCreatedDirs(path: string, topDir: string | undefined): Promise<void> {
  if (topDir === undefined) return;
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    try {
      await rmdir(dir);
    } catch {
      return;
    }
    if (dir === topDir) return;
  }
}
