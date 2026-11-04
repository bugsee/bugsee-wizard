import { join } from 'node:path';
import type { Step } from '../../core/step.js';
import { readPackageJson } from '../package-json.js';
import type { DetectedPackageManager } from '../package-manager.js';
import type { OpSpec, RecipeContext } from '../recipe.js';
import { manifestPath, readBytes, restoreBytes } from './shared.js';

type Spec = Extract<OpSpec, { op: 'add-package-script' }>;

/** `<pm> run <name>` (deno: `deno task <name>`); npm when no package manager was detected. */
export function runScriptCommand(pm: DetectedPackageManager | null, name: string): string {
  if (pm?.name === 'deno') return `deno task ${name}`;
  return `${pm?.name ?? 'npm'} run ${name}`;
}

function scriptsOf(data: Record<string, unknown>): Record<string, unknown> {
  const s = data.scripts;
  return typeof s === 'object' && s !== null && !Array.isArray(s)
    ? (s as Record<string, unknown>)
    : {};
}

export function addPackageScriptStep(spec: Spec): Step<RecipeContext> {
  let before: Buffer | undefined;
  const pkgPath = (ctx: RecipeContext): string => join(ctx.packageDir, 'package.json');
  return {
    id: `add-package-script:${spec.name}`,
    title: `Add the "${spec.name}" script to package.json`,
    async precheck(ctx) {
      if ((await readBytes(pkgPath(ctx))) === null) {
        return { kind: 'blocked', reason: 'package.json not found' };
      }
      const scripts = scriptsOf((await readPackageJson(pkgPath(ctx))).data);
      const existing = scripts[spec.name];
      if (existing !== undefined && existing !== spec.command) {
        return {
          kind: 'blocked',
          reason: `scripts.${spec.name} already exists with a different command`,
        };
      }
      if (existing === undefined) return { kind: 'pending' };
      const chained = spec.chainInto === undefined ? undefined : scripts[spec.chainInto];
      if (
        typeof chained === 'string' &&
        !chained.includes(runScriptCommand(ctx.packageManager, spec.name))
      ) {
        return { kind: 'pending' };
      }
      return { kind: 'satisfied' };
    },
    async apply(ctx) {
      const path = pkgPath(ctx);
      before = (await readBytes(path)) ?? undefined;
      const pkg = await readPackageJson(path);
      const scripts = { ...scriptsOf(pkg.data) };
      scripts[spec.name] = spec.command;
      if (spec.chainInto !== undefined) {
        const target = scripts[spec.chainInto];
        const run = runScriptCommand(ctx.packageManager, spec.name);
        if (typeof target !== 'string') {
          ctx.log.info(`No "${spec.chainInto}" script to chain into; run "${run}" yourself`);
        } else if (!target.includes(run)) {
          scripts[spec.chainInto] = `${target} && ${run}`;
        }
      }
      await pkg.write({ ...pkg.data, scripts });
      const after = (await readBytes(path)) as Buffer;
      if (!after.equals(before as Buffer)) {
        ctx.manifest.record({
          file: manifestPath(ctx, path),
          action: 'edited',
          before: (before as Buffer).toString('utf8'),
          after: after.toString('utf8'),
        });
      }
    },
    async rollback(ctx) {
      if (before === undefined) return;
      await restoreBytes(pkgPath(ctx), before);
    },
  };
}
