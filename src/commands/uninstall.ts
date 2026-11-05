import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import * as clack from '@clack/prompts';

import type { WizardOptions } from '../core/context.js';
import { runDetectors } from '../core/detect.js';
import { createLogger } from '../core/logger.js';
import type { RollbackResult } from '../core/result.js';
import { registerAllDetectors } from '../detectors/index.js';
import { PROJECT_KIND_LABELS, type ProjectKind } from '../project-kind.js';
import { runAndroidRollback } from '../recipes/android/run.js';
import { runIosRollback } from '../recipes/ios/run.js';
import { runReactNativeRollback } from '../recipes/react-native/run.js';

type ExitReason = 'switching' | 'not-needed' | 'cost' | 'integration' | 'bugs' | 'other' | 'skip';

export async function runUninstall(opts: WizardOptions): Promise<void> {
  registerAllDetectors();
  const log = createLogger({ debug: opts.debug });
  clack.intro('Bugsee uninstall');

  const detected = await runDetectors({ cwd: opts.cwd });
  const detectedKinds: ProjectKind[] = detected.map((d) => d.kind);

  // Detection requires the `react-native` dependency; a half-removed or
  // unusual RN project can still carry Bugsee leftovers, so offer the RN
  // rollback (a no-op where nothing is present) when there are signs of one.
  if (detectedKinds.length === 0 && (await hasReactNativeLeftovers(opts.cwd))) {
    detectedKinds.push('react-native');
  }

  if (detectedKinds.length === 0) {
    clack.outro('No supported platform detected here. Nothing to uninstall.');
    return;
  }

  // Determine which platforms to roll back.
  const targets = await pickTargets(detectedKinds);
  if (targets === null) {
    clack.cancel('Cancelled.');
    return;
  }
  if (targets.length === 0) {
    clack.outro('Nothing selected. Cancelled.');
    return;
  }

  const results: RollbackResult[] = [];
  for (const target of targets) {
    if (target === 'android') {
      results.push(await runAndroidRollback(opts));
    } else if (target === 'ios') {
      results.push(await runIosRollback(opts));
    } else if (target === 'react-native') {
      results.push(await runReactNativeRollback(opts));
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

  if (opts.dryRun) {
    clack.outro('Dry run complete — no changes were made.');
    return;
  }

  await runExitPoll();
  clack.outro('Bugsee removed.');
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function hasReactNativeLeftovers(cwd: string): Promise<boolean> {
  if ((await exists(path.join(cwd, 'android'))) || (await exists(path.join(cwd, 'ios')))) {
    return true;
  }
  try {
    const pkg = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8')) as Record<
      string,
      Record<string, unknown> | undefined
    >;
    return 'react-native-bugsee' in { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    return false;
  }
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
