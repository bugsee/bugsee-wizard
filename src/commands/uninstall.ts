import * as clack from '@clack/prompts';

import type { WizardOptions } from '../core/context.js';
import { runDetectors } from '../core/detect.js';
import { createLogger } from '../core/logger.js';
import type { RollbackResult } from '../core/result.js';
import { registerAllDetectors } from '../detectors/index.js';
import {
  CancelledError,
  createOutput,
  exitCodeFor,
  MissingInputError,
  type WizardRunResult,
} from '../engine/noninteractive.js';
import { PROJECT_KIND_LABELS, type ProjectKind } from '../project-kind.js';
import { runAndroidRollback } from '../recipes/android/run.js';
import { runIosRollback } from '../recipes/ios/run.js';
import { runReactNativeRollback } from '../recipes/react-native/run.js';
import { runJavaScriptUninstall } from '../web/uninstall.js';

type ExitReason = 'switching' | 'not-needed' | 'cost' | 'integration' | 'bugs' | 'other' | 'skip';

export async function runUninstall(opts: WizardOptions): Promise<void> {
  registerAllDetectors();
  if (opts.json || opts.nonInteractive) {
    await runUninstallNonInteractive(opts);
    return;
  }
  const log = createLogger({ debug: opts.debug });
  clack.intro('Bugsee uninstall');

  const detected = await runDetectors({ cwd: opts.cwd });
  const detectedKinds = detected.map((d) => d.kind);

  if (detectedKinds.length === 0) {
    clack.outro('No supported platform detected here. Nothing to uninstall.');
    return;
  }

  // Determine which platforms to roll back. The JavaScript flow lists its changes and asks itself.
  const onlyJs = detectedKinds.length === 1 && detectedKinds[0] === 'javascript';
  const targets = onlyJs ? detectedKinds : await pickTargets(detectedKinds);
  if (targets === null) {
    clack.cancel('Cancelled.');
    return;
  }
  if (targets.length === 0) {
    clack.outro('Nothing selected. Cancelled.');
    return;
  }

  const results: RollbackResult[] = [];
  /** Files a JavaScript rollback left for the user (changed since the wizard wrote them). */
  const remaining: string[] = [];
  for (const target of targets) {
    if (target === 'android') {
      results.push(await runAndroidRollback(opts));
    } else if (target === 'ios') {
      results.push(await runIosRollback(opts));
    } else if (target === 'react-native') {
      results.push(await runReactNativeRollback(opts));
    } else if (target === 'javascript') {
      const js = await javascriptRollback(opts);
      if (js === null) {
        clack.cancel('Cancelled.');
        return;
      }
      results.push(js.result);
      remaining.push(...js.remaining);
    } else {
      log.warn(`No rollback implemented for ${PROJECT_KIND_LABELS[target]} yet.`);
    }
  }

  if (results.includes('failed')) {
    // Skip the exit poll: the user is looking at errors, and scripted callers
    // need a non-zero exit to know Bugsee may still be partly present.
    clack.outro('Bugsee removal finished with errors — see above.');
    process.exitCode = 1;
    return;
  }

  if (!results.some((r) => r === 'ok')) {
    clack.outro('No rollback was performed.');
    return;
  }

  // nothing was removed, or not all of it: say so, and do not ask why the user is leaving
  if (opts.dryRun) {
    clack.outro('Dry run — nothing was changed.');
    return;
  }
  if (remaining.length > 0) {
    clack.outro(
      `Bugsee was partly removed. These files need a manual step:\n${remaining.map((f) => `  ${f}`).join('\n')}`,
    );
    return;
  }

  await runExitPoll();
  clack.outro('Bugsee removed.');
}

/** The JavaScript uninstall as a RollbackResult plus the files it left; null when cancelled. */
async function javascriptRollback(
  opts: WizardOptions,
): Promise<{ result: RollbackResult; remaining: string[] } | null> {
  let r: WizardRunResult;
  try {
    r = await runJavaScriptUninstall(opts);
  } catch (err) {
    if (err instanceof CancelledError) return null;
    throw err;
  }
  const remaining = r.steps.filter((s) => s.outcome === 'manual').map((s) => s.id);
  if (!r.ok) return { result: 'failed', remaining };
  return { result: r.steps.length === 0 ? 'not-found' : 'ok', remaining };
}

/**
 * `--json` / `--non-interactive`: no prompts and never the exit poll. Only JavaScript can be
 * removed without prompts (it still needs `--yes`).
 */
async function runUninstallNonInteractive(opts: WizardOptions): Promise<void> {
  const output = createOutput({ json: opts.json, debug: opts.debug });
  const detected = await runDetectors({ cwd: opts.cwd });
  if (detected.length > 1) throw new MissingInputError('kind');
  const only = detected[0];
  let result: WizardRunResult;
  if (only === undefined) {
    output.log.info('No supported platform detected here. Nothing to uninstall.');
    result = { ok: true, incomplete: false, steps: [] };
  } else if (only.kind === 'javascript') {
    result = await runJavaScriptUninstall({ ...opts, nonInteractive: true }, { output });
  } else {
    const message = `${PROJECT_KIND_LABELS[only.kind]} removal is interactive only; run the wizard without --non-interactive / --json.`;
    output.log.error(message);
    result = {
      ok: false,
      incomplete: false,
      steps: [],
      error: 'unsupported-non-interactive',
      field: only.kind,
      message,
    };
  }
  output.result(result);
  process.exitCode = exitCodeFor(result, true);
}

/**
 * Prompt the user about which detected platform(s) to roll back. Returns
 * `null` when the user cancels at any prompt.
 */
async function pickTargets(
  detected: readonly ProjectKind[],
): Promise<readonly ProjectKind[] | null> {
  if (detected.length === 1) {
    const only = detected[0];
    if (!only) return null;
    const confirm = await clack.confirm({
      message: `Remove Bugsee from this ${PROJECT_KIND_LABELS[only]} project?`,
      initialValue: false,
    });
    if (clack.isCancel(confirm)) return null;
    return confirm ? [only] : [];
  }

  // Multiple platforms detected (e.g. an RN-style project where iOS and
  // Android both match). Default to "remove from all" but let the user
  // narrow down.
  const allLabel = detected.map((k) => PROJECT_KIND_LABELS[k]).join(' + ');
  const scope = await clack.select<'all' | 'one'>({
    message: `Detected ${allLabel}. Roll back from…`,
    options: [
      { value: 'all', label: 'all detected platforms' },
      { value: 'one', label: 'pick one' },
    ],
    initialValue: 'all',
  });
  if (clack.isCancel(scope)) return null;
  if (scope === 'all') return detected;

  const single = await clack.select<ProjectKind>({
    message: 'Which platform?',
    options: detected.map((k) => ({ value: k, label: PROJECT_KIND_LABELS[k] })),
  });
  if (clack.isCancel(single)) return null;
  return [single];
}

async function runExitPoll(): Promise<void> {
  const reason = await clack.select<ExitReason>({
    message: 'Before you go — what was the main reason?',
    options: [
      { value: 'switching', label: 'Switching to another tool' },
      { value: 'not-needed', label: 'No longer need crash/bug reporting' },
      { value: 'cost', label: 'Cost / pricing' },
      { value: 'integration', label: 'Integration was difficult' },
      { value: 'bugs', label: 'Hit bugs or limitations' },
      { value: 'other', label: 'Other' },
      { value: 'skip', label: 'Skip' },
    ],
    initialValue: 'skip',
  });
  if (clack.isCancel(reason) || reason === 'skip') return;

  // TODO(feedback): POST { reason } to a Bugsee feedback endpoint via native fetch.
}
