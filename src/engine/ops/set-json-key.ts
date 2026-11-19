import { parse } from 'jsonc-parser';
import type { Step } from '../../core/step.js';
import { setJsonCKey } from '../config-ast.js';
import { editTextFile } from '../fs-edit.js';
import type { OpSpec, RecipeContext } from '../recipe.js';
import { manifestPath, readBytes, resolveInside, restoreBytes } from './shared.js';

type Spec = Extract<OpSpec, { op: 'set-json-key' }>;

function nested(path: string[], value: unknown): unknown {
  return path.reduceRight<unknown>((acc, key) => ({ [key]: acc }), value);
}

export function setJsonKeyStep(spec: Spec): Step<RecipeContext> {
  let before: Buffer | undefined;
  const keyPath = spec.path.join('.');
  return {
    id: `set-json-key:${spec.file}#${keyPath}`,
    title: `Set ${keyPath} in ${spec.file}`,
    async precheck(ctx) {
      let path: string;
      try {
        path = await resolveInside(ctx.packageDir, spec.file);
      } catch (err) {
        return { kind: 'blocked', reason: (err as Error).message };
      }
      const current = await readBytes(path);
      if (current === null) return { kind: 'pending' }; // apply hands back a manual snippet
      const src = current.toString('utf8');
      return setJsonCKey(src, spec.path, spec.value) === src
        ? { kind: 'satisfied' }
        : { kind: 'pending' };
    },
    async apply(ctx) {
      const path = await resolveInside(ctx.packageDir, spec.file);
      const file = manifestPath(ctx, path);
      const current = await readBytes(path);
      if (current === null) {
        ctx.manifest.record({ file, action: 'manual' });
        return {
          manual: {
            file,
            title: `Set ${keyPath} in ${spec.file}`,
            code: JSON.stringify(nested(spec.path, spec.value), null, 2),
          },
        };
      }
      before = current;
      const res = await editTextFile(path, (src) => setJsonCKey(src, spec.path, spec.value), {
        validate: (out) => {
          const errors: unknown[] = [];
          parse(out, errors as never[], { allowTrailingComma: true });
          return errors.length === 0;
        },
      });
      if (res.changed) {
        ctx.manifest.record({ file, action: 'edited', before: res.before, after: res.after });
      }
      return undefined;
    },
    async preview(ctx) {
      const path = await resolveInside(ctx.packageDir, spec.file);
      if ((await readBytes(path)) !== null) return undefined;
      return {
        manual: {
          file: manifestPath(ctx, path),
          title: `Set ${keyPath} in ${spec.file}`,
          code: JSON.stringify(nested(spec.path, spec.value), null, 2),
        },
      };
    },
    async rollback(ctx) {
      if (before === undefined) return;
      await restoreBytes(await resolveInside(ctx.packageDir, spec.file), before);
    },
  };
}
