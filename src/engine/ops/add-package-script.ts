import { join } from 'node:path';
import type { ManualSnippet, Step } from '../../core/step.js';
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

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `script` runs `command` as a whole command, not as a prefix of a longer one. */
function includesCommand(script: string, command: string): boolean {
  return new RegExp(`(?:^|[\\s&|;(])${escapeRe(command)}(?![\\w:.-])`).test(script);
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
    title: `Add the "${spec.name}" script to package.json${spec.chainInto === undefined ? '' : ` and run it after "${spec.chainInto}"`}`,
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
      // chain target missing, or not running us yet: stay pending (apply reports it)
      if (
        spec.chainInto !== undefined &&
        !(
          typeof chained === 'string' &&
          includesCommand(chained, runScriptCommand(ctx.packageManager, spec.name))
        )
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
      let chainHint: ManualSnippet | undefined;
      if (spec.chainInto !== undefined) {
        const target = scripts[spec.chainInto];
        const run = runScriptCommand(ctx.packageManager, spec.name);
        if (typeof target !== 'string') {
          chainHint = {
            file: manifestPath(ctx, path),
            title: `Run "${spec.name}" as part of your "${spec.chainInto}" script`,
            code: `// package.json has no "${spec.chainInto}" script; chain this into the script that builds your app:\n${run}`,
          };
        } else if (!includesCommand(target, run)) {
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
      if (chainHint) {
        // anything this run wrote stays rollback-covered even though a manual step remains
        return { manual: chainHint, ...(after.equals(before as Buffer) ? {} : { applied: true }) };
      }
      return undefined;
    },
    async rollback(ctx) {
      if (before === undefined) return;
      await restoreBytes(pkgPath(ctx), before);
    },
  };
}
