import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { runChild, runChildOutput } from '../../core/run-child.js';
import type { Step } from '../../core/step.js';
import { readPackageJson } from '../package-json.js';
import type { PackageManagerName } from '../package-manager.js';
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

/**
 * pnpm 11 fails an install whose dependency has an unapproved install script
 * (ERR_PNPM_IGNORED_BUILDS), so on a stock project every recipe died at its first step. Approve
 * exactly the packages being installed in `allowBuilds` of pnpm-workspace.yaml first.
 *
 * Not `pnpm add --allow-build`: pnpm 11.3 REPLACES the whole `allowBuilds` map with the named
 * packages, silently dropping the project's own approvals. pnpm 10 only warns, and its flag merges,
 * so nothing is needed there. An explicit `false` is the project's decision and is kept; an
 * undecided placeholder (what pnpm writes after a failed install) becomes `true`. The file is part
 * of the install snapshot, so a failed install or an uninstall restores it byte for byte.
 */
async function approvePnpmBuilds(
  packages: readonly string[],
  cwd: string,
  root: string,
): Promise<void> {
  let major: number;
  try {
    major = Number.parseInt((await runChildOutput('pnpm', ['--version'], { cwd })).trim(), 10);
  } catch {
    return;
  }
  if (!(major >= 11)) return;
  const file = join(root, 'pnpm-workspace.yaml');
  const prior = await readBytes(file);
  const doc = parseDocument(prior ? prior.toString('utf8') : '');
  if (doc.errors.length > 0) return; // a file we cannot read is left for pnpm to complain about
  let changed = false;
  try {
    // a bare `allowBuilds:` has a null value: an empty map, ours to fill
    if (doc.get('allowBuilds') == null) doc.set('allowBuilds', doc.createNode({}));
    for (const p of packages) {
      const current = doc.getIn(['allowBuilds', p]);
      if (current === true || current === false) continue;
      doc.setIn(['allowBuilds', p], true);
      changed = true;
    }
  } catch {
    return; // allowBuilds is not a map: not ours to rewrite
  }
  if (changed) await writeFile(file, doc.toString());
}

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
      const pkgs = spec.packages.map((p) => (spec.tag ? `${p}@${spec.tag}` : p));
      try {
        if (pm.name === 'pnpm') await approvePnpmBuilds(spec.packages, ctx.packageDir, pm.root);
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
        // the install error stays primary; restore problems ride along
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
