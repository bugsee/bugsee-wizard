import { access } from 'node:fs/promises';
import { join } from 'node:path';

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

  const located = await locatePackage(opts, deps);
  if ('result' in located) {
    log.error(located.result.message ?? '');
    return located.result;
  }
  const dir = located.det.packageDir;

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
