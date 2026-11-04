import * as clack from '@clack/prompts';

import type { WizardOptions } from '../core/context.js';
import { runDetectors } from '../core/detect.js';
import { createLogger } from '../core/logger.js';
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
  const detectedKinds = detected.map((d) => d.kind);

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

  let attemptedAny = false;
  for (const target of targets) {
    if (target === 'android') {
      const ran = await runAndroidRollback(opts);
      if (ran) attemptedAny = true;
    } else if (target === 'ios') {
      const ran = await runIosRollback(opts);
      if (ran) attemptedAny = true;
    } else if (target === 'react-native') {
      const ran = await runReactNativeRollback(opts);
      if (ran) attemptedAny = true;
    } else {
      log.warn(`No rollback implemented for ${PROJECT_KIND_LABELS[target]} yet.`);
    }
  }

  if (!attemptedAny) {
    clack.outro('No rollback was performed.');
    return;
  }

  await runExitPoll();
  clack.outro('Bugsee removed.');
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
