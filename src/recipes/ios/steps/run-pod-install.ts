import path from 'node:path';

import * as clack from '@clack/prompts';

import { runChild } from '../../../core/run-child.js';
import type { Step, StepStatus } from '../../../core/step.js';
import { readOrNull } from '../../android/io.js';
import { isPodOnPath } from '../pod.js';
import { type IosContext, PODFILE_MARKER_BEGIN } from '../types.js';

export const runPodInstallStep: Step<IosContext> = {
  id: 'ios.run-pod-install',
  title: 'Run pod install',

  async precheck(ctx): Promise<StepStatus> {
    if (ctx.iosOptions.distribution !== 'cocoapods') {
      return { kind: 'satisfied', note: 'CocoaPods not selected' };
    }
    if (!ctx.iosOptions.runPodInstall) {
      return { kind: 'satisfied', note: 'pod install not requested' };
    }
    if (!ctx.iosPaths.podfile) {
      return { kind: 'blocked', reason: 'No Podfile found' };
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
    if (!ctx.iosPaths.podfile) throw new Error('Podfile path not resolved');
    const podDir = path.dirname(ctx.iosPaths.podfile);
    const spinner = clack.spinner();
    spinner.start('Running pod install — this can take a minute');
    try {
      await runChild('pod', ['install'], { cwd: podDir, forwardStdout: ctx.debug });
      spinner.stop('pod install complete');
    } catch (err) {
      spinner.error('pod install failed');
      throw err;
    }
  },

  async rollback(ctx) {
    // Intentionally non-destructive. Undoing `pod install` would mean deleting
    // Pods/ and Podfile.lock — rarely what the user wants when rolling back
    // the wizard. The add-pod step's rollback (which runs after this one)
    // removes our pod line; the user re-syncs with `pod install`. Tell them so
    // when a Podfile still carries our marker block.
    if (!ctx.iosPaths.podfile) return;
    const content = await readOrNull(ctx.iosPaths.podfile);
    if (content?.includes(PODFILE_MARKER_BEGIN)) {
      ctx.log.info(
        `Bugsee is removed from the Podfile; run \`pod install\` in ${path.dirname(ctx.iosPaths.podfile)} to sync Pods/ and Podfile.lock.`,
      );
    }
  },
};
