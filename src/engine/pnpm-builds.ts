import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isMap, parseDocument } from 'yaml';
import { runChildOutput } from '../core/run-child.js';
import { readBytes } from './ops/shared.js';

/**
 * pnpm 11 fails an install whose dependency has an unapproved install script
 * (ERR_PNPM_IGNORED_BUILDS), so on a stock project every install would die. With the user's
 * consent (`yes`, or a yes to the question in an interactive run), record the decision for exactly
 * the packages being installed in `allowBuilds` of pnpm-workspace.yaml first. Without consent
 * nothing is edited: the project's pnpm settings are not ours to change silently, and the install's
 * failure says how to proceed.
 *
 * Not `pnpm add --allow-build`: pnpm 11.3 REPLACES the whole `allowBuilds` map with the named
 * packages, silently dropping the project's own approvals. pnpm 10 only warns, and its flag merges,
 * so nothing is needed there. An existing `true`/`false` is the project's decision and is kept (and
 * not asked about); an undecided placeholder (what pnpm writes after a failed install) counts as
 * pending and is replaced by `value`. The file is part of the callers' install snapshot, so a failed
 * install or an uninstall restores it byte for byte.
 *
 * Resolves to `declined` when a decision was needed but consent was not given.
 */
export interface PnpmBuildsRequest {
  readonly packages: readonly string[];
  /** What to record: `true` lets the install script run, `false` records that it does not. */
  readonly value: boolean;
  /** Directory of the package being installed (where `pnpm --version` is asked). */
  readonly cwd: string;
  /** Directory of pnpm-workspace.yaml (the lockfile / workspace root). */
  readonly root: string;
  readonly yes: boolean;
  readonly nonInteractive: boolean;
  readonly confirm?: ((message: string) => Promise<boolean>) | undefined;
}

export async function decidePnpmBuilds(req: PnpmBuildsRequest): Promise<'done' | 'declined'> {
  let major: number;
  try {
    major = Number.parseInt(
      (await runChildOutput('pnpm', ['--version'], { cwd: req.cwd })).trim(),
      10,
    );
  } catch {
    return 'done';
  }
  if (!(major >= 11)) return 'done';
  const file = join(req.root, 'pnpm-workspace.yaml');
  const prior = await readBytes(file);
  const doc = parseDocument(prior ? prior.toString('utf8') : '');
  if (doc.errors.length > 0) return 'done'; // a file we cannot read is left for pnpm to complain about
  // a bare `allowBuilds:` has a null value: an empty map, ours to fill
  if (doc.get('allowBuilds') == null) doc.set('allowBuilds', doc.createNode({}));
  if (!isMap(doc.get('allowBuilds'))) return 'done'; // not a map: not ours to rewrite
  const pending = req.packages.filter((p) => {
    const current = doc.getIn(['allowBuilds', p]);
    return current !== true && current !== false;
  });
  if (pending.length === 0) return 'done';
  const consent =
    req.yes ||
    (!req.nonInteractive &&
      req.confirm !== undefined &&
      (await req.confirm(
        req.value
          ? `pnpm 11 blocks dependency install scripts until they are approved. Add ${pending.join(', ')} to allowBuilds in pnpm-workspace.yaml?`
          : `pnpm 11 makes every project decide whether dependency install scripts run. Record in pnpm-workspace.yaml that ${pending.join(', ')} does not run its install script (allowBuilds: false)?`,
      )));
  if (!consent) return 'declined';
  for (const p of pending) doc.setIn(['allowBuilds', p], req.value);
  await writeFile(file, doc.toString());
  return 'done';
}

export const PNPM_BUILDS_HINT =
  'pnpm 11 blocks install scripts that are not decided. Decide the packages above in pnpm-workspace.yaml (`pnpm approve-builds`), or rerun the wizard with --yes to let it do that.';
