import { join } from 'node:path';
import { runChild } from '../../core/run-child.js';
import type { Step } from '../../core/step.js';
import { readPackageJson } from '../package-json.js';
import type { PackageManagerName } from '../package-manager.js';
import { decidePnpmBuilds, PNPM_BUILDS_HINT } from '../pnpm-builds.js';
import type { OpSpec, RecipeContext } from '../recipe.js';
import { manifestPath, readBytes, restoreBytes, text } from './shared.js';

type Spec = Extract<OpSpec, { op: 'install-package' }>;

/**
 * Files at the package manager root that an install may rewrite besides package.json: the lockfile
 * and, for pnpm >= 10, pnpm-workspace.yaml (`pnpm add` writes `allowBuilds` entries there).
 */
const LOCKFILES: Record<PackageManagerName, readonly string[]> = {
  npm: ['package-lock.json', 'npm-shrinkwrap.json'],
  yarn: ['yarn.lock'],
  pnpm: ['pnpm-lock.yaml', 'pnpm-workspace.yaml'],
  bun: ['bun.lock', 'bun.lockb'],
  deno: ['deno.lock'],
};

type Snapshot = ReadonlyMap<string, Buffer | null>;

export function installPackageStep(spec: Spec): Step<RecipeContext> {
  let snapshot: Snapshot | undefined;
  const files = (ctx: RecipeContext): string[] => {
    const lock = ctx.packageManager ? LOCKFILES[ctx.packageManager.name] : [];
    return [
      join(ctx.packageDir, 'package.json'),
      ...lock.map((l) => join((ctx.packageManager as { root: string }).root, l)),
    ];
  };
  return {
    id: `install-package:${spec.packages.join(',')}`,
    title: `Install ${spec.packages.join(', ')}${spec.tag ? `@${spec.tag}` : ''}`,
    async precheck(ctx) {
      if (!ctx.packageManager) {
        return { kind: 'blocked', reason: 'No package manager detected (no lockfile found)' };
      }
      if ((await readBytes(join(ctx.packageDir, 'package.json'))) === null) {
        return { kind: 'pending' };
      }
      const data = (await readPackageJson(join(ctx.packageDir, 'package.json'))).data;
      const declared = (key: string): Record<string, unknown> => {
        const v = data[key];
        return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
      };
      const have = { ...declared('devDependencies'), ...declared('dependencies') };
      return spec.packages.every((p) => p in have) ? { kind: 'satisfied' } : { kind: 'pending' };
    },
    async apply(ctx) {
      const pm = ctx.packageManager;
      if (!pm) throw new Error('No package manager detected');
      const paths = files(ctx);
      const snap = new Map<string, Buffer | null>();
      for (const p of paths) snap.set(p, await readBytes(p));
      let declined = false;
      const pkgs = spec.packages.map((p) => (spec.tag ? `${p}@${spec.tag}` : p));
      try {
        if (pm.name === 'pnpm') {
          declined =
            (await decidePnpmBuilds({
              packages: spec.packages,
              value: true,
              cwd: ctx.packageDir,
              root: pm.root,
              yes: ctx.yes,
              nonInteractive: ctx.nonInteractive,
              confirm: ctx.confirm,
            })) === 'declined';
        }
        const args = pm.installArgs(pkgs, spec.dev === true);
        await runChild(pm.name, args, {
          cwd: ctx.packageDir,
          forwardStdout: ctx.debug,
          // JavaScript runs may print a JSON result on stdout: the package manager talks on stderr
          forwardTo: 'stderr',
        });
      } catch (err) {
        // leave nothing of the failed install in the repo
        const failures: string[] = [];
        for (const [p, bytes] of snap) {
          try {
            await restoreBytes(p, bytes);
          } catch (restoreErr) {
            failures.push(`${p}: ${(restoreErr as Error).message}`);
          }
        }
        // the install error stays primary; restore problems and the approval hint ride along
        if (declined && err instanceof Error) err.message += `\n${PNPM_BUILDS_HINT}`;
        if (failures.length > 0 && err instanceof Error) {
          err.message += `\n(also failed to restore: ${failures.join('; ')})`;
        }
        throw err;
      }
      snapshot = snap;
      for (const [p, bytes] of snap) {
        const after = await readBytes(p);
        // binary lockfiles (bun.lockb) have no meaningful text form
        if (p.endsWith('.lockb') || (bytes === null && after === null)) continue;
        if (bytes !== null && after !== null && bytes.equals(after)) continue;
        const prior = text(bytes);
        ctx.manifest.record({
          file: manifestPath(ctx, p),
          action: bytes === null ? 'created' : 'edited',
          ...(prior !== undefined ? { before: prior } : {}),
          ...(after !== null ? { after: after.toString('utf8') } : {}),
        });
      }
    },
    async rollback() {
      // node_modules is deliberately left alone
      if (!snapshot) return;
      for (const [p, bytes] of snapshot) await restoreBytes(p, bytes);
    },
  };
}
