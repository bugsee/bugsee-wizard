import { access } from 'node:fs/promises';
import { join, relative } from 'node:path';

import type { WizardOptions } from '../core/context.js';
import { loadManifest, type RollbackResult } from '../engine/manifest.js';
import {
  CancelledError,
  MissingInputError,
  type WizardRunResult,
} from '../engine/noninteractive.js';
import { type Deps, defaultDeps, failed, locatePackage } from './run.js';

const MANIFEST = '.bugsee/wizard-manifest.json';

const exists = (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false,
  );

const VERB: Record<RollbackResult['outcome'], string> = {
  reverted: 'restore',
  deleted: 'delete',
  skipped: 'skip',
  manual: 'leave for you',
  missing: 'already gone',
};

function changeList(results: readonly RollbackResult[]): string {
  return [
    'Bugsee uninstall will change:',
    ...results.map((r) => `  ${VERB[r.outcome]}: ${r.file}${r.note ? ` (${r.note})` : ''}`),
  ].join('\n');
}

/**
 * The directory whose manifest to roll back. `--package` decides when given. Otherwise the detected
 * project, unless it has no manifest and is a workspace root: then the packages that do have one
 * (one: used and named; several: `--package` non-interactively, a choice interactively).
 */
async function locateManifestDir(
  opts: WizardOptions,
  deps: Deps,
): Promise<{ dir: string } | { result: WizardRunResult }> {
  if (opts.package !== undefined) {
    const located = await locatePackage(opts, deps);
    return 'result' in located ? located : { dir: located.det.packageDir };
  }
  const det = await deps.detect(opts.cwd);
  if (det === null) {
    return { result: failed('no-project', `No JavaScript project found in ${opts.cwd}.`) };
  }
  const hasManifest = (d: string): Promise<boolean> => exists(join(d, MANIFEST));
  if (await hasManifest(det.packageDir)) return { dir: det.packageDir };
  const root = det.workspace?.root ?? det.packageDir;
  const found: { dir: string; name: string }[] = [];
  for (const p of det.workspace?.packages ?? []) {
    if (await hasManifest(p.dir)) found.push(p);
  }
  const show = (d: string): string => relative(root, d).split('\\').join('/');
  const [only] = found;
  if (only === undefined) return { dir: det.packageDir };
  if (found.length === 1) {
    deps.output.log.info(`Using the wizard changes recorded in ${show(only.dir)}.`);
    return { dir: only.dir };
  }
  if (opts.nonInteractive) throw new MissingInputError('package');
  const dir = await deps.prompts.select(
    'Bugsee was set up in several packages. Which one should it be removed from?',
    found.map((p) => ({ value: p.dir, label: `${show(p.dir)} (${p.name})` })),
  );
  return { dir };
}

/**
 * Reverse what the wizard recorded in `.bugsee/wizard-manifest.json`. Always shows the list of
 * changes first and asks (non-interactive runs need `--yes`); an unreadable manifest is a failure,
 * never a silent "nothing to do".
 */
export async function runJavaScriptUninstall(
  opts: WizardOptions,
  overrides: Partial<Deps> = {},
): Promise<WizardRunResult> {
  const deps = defaultDeps(opts, overrides);
  const log = deps.output.log;

  const located = await locateManifestDir(opts, deps);
  if ('result' in located) {
    log.error(located.result.message ?? '');
    return located.result;
  }
  const dir = located.dir;

  if ((await loadManifest(dir)) === null) {
    if (await exists(join(dir, MANIFEST))) {
      const message = `${join(dir, MANIFEST)} is not a valid wizard manifest, so the wizard cannot tell what to undo. Fix or remove it, or revert the changes by hand.`;
      log.error(message);
      return failed('invalid-manifest', message);
    }
    log.info('Nothing to uninstall: the wizard has not changed this project.');
    return { ok: true, incomplete: false, steps: [] };
  }

  const preview = await deps.rollback({ dir, log, dryRun: true });
  log.info(changeList(preview.results));

  if (!opts.dryRun && !opts.yes) {
    if (opts.nonInteractive) throw new MissingInputError('confirmation');
    if (!(await deps.prompts.confirm('Remove these Bugsee changes?'))) throw new CancelledError();
  }

  const run = opts.dryRun ? preview : await deps.rollback({ dir, log, dryRun: false });
  for (const r of run.results) {
    if (r.outcome === 'manual') log.warn(`${r.file}: ${r.note ?? 'needs a manual step'}`);
  }
  const incomplete = run.results.some((r) => r.outcome === 'manual');
  return {
    ok: !run.failed,
    incomplete,
    steps: run.results.map((r) => ({ id: r.file, outcome: r.outcome })),
    ...(run.failed
      ? { error: 'rollback-failed', message: 'Some files could not be rolled back; see above.' }
      : {}),
  };
}
