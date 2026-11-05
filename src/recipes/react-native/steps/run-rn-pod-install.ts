import { access } from 'node:fs/promises';
import path from 'node:path';

import * as clack from '@clack/prompts';

import { runChild } from '../../../core/run-child.js';
import type { Step, StepStatus } from '../../../core/step.js';
import { isPodOnPath } from '../../ios/pod.js';
import type { RnContext } from '../types.js';

function podfileOf(ctx: RnContext): string | null {
  return ctx.rnPaths.iosPath === null ? null : path.join(ctx.rnPaths.iosPath, 'Podfile');
}

/**
 * `pod install` after the wrapper was added, for a bare iOS app on React Native < 0.87 (where the
 * wrapper's pod vendors the SDK). The run decides whether it applies (`runPodInstall`): from 0.87
 * the SDK comes through SPM by autolinking and there is nothing to install. Rollback is a no-op:
 * undoing it would mean deleting Pods/ and Podfile.lock.
 */
export const runRnPodInstallStep: Step<RnContext> = {
  id: 'react-native.run-pod-install',
  title: 'Run pod install',

  async precheck(ctx): Promise<StepStatus> {
    if (!ctx.rnOptions.runPodInstall) {
      return { kind: 'satisfied', note: 'pod install not requested' };
    }
    const podfile = podfileOf(ctx);
    if (
      podfile === null ||
      (await access(podfile).then(
        () => false,
        () => true,
      ))
    ) {
      return { kind: 'blocked', reason: 'No ios/Podfile found' };
    }
    if (!isPodOnPath()) {
      return {
        kind: 'blocked',
        reason: '`pod` not found on PATH — install CocoaPods (https://cocoapods.org/) and re-run',
      };
    }
    return { kind: 'pending' };
  },

  async apply(ctx) {
    const podfile = podfileOf(ctx);
    if (podfile === null) throw new Error('ios/ directory not resolved');
    const spinner = clack.spinner();
    spinner.start('Running pod install — this can take a minute');
    try {
      await runChild('pod', ['install'], { cwd: path.dirname(podfile), forwardStdout: ctx.debug });
      spinner.stop('pod install complete');
    } catch (err) {
      spinner.error('pod install failed');
      throw err;
    }
  },

  async rollback(_ctx) {
    // Intentionally no-op: see the step's description.
  },
};
