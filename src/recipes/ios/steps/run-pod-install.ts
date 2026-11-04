import { spawn } from 'node:child_process';
import path from 'node:path';

import * as clack from '@clack/prompts';

import type { Step, StepStatus } from '../../../core/step.js';
import { isPodOnPath } from '../pod.js';
import type { IosContext } from '../types.js';

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
      await runChild('pod', ['install'], podDir, ctx.debug);
      spinner.stop('pod install complete');
    } catch (err) {
      spinner.error('pod install failed');
      throw err;
    }
  },

  async rollback(_ctx) {
    // Intentionally no-op. Undoing `pod install` would mean deleting Pods/
    // and Podfile.lock — destructive and rarely what the user wants when
    // rolling back the wizard. The earlier add-pod step's rollback removes
    // our pod line; running `pod install` again afterwards re-syncs cleanly.
  },
};

async function runChild(
  cmd: string,
  args: readonly string[],
  cwd: string,
  forwardStdout: boolean,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    if (forwardStdout) {
      child.stdout?.on('data', (chunk: Buffer) => {
        process.stdout.write(chunk);
      });
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const tail = stderr.trim().split('\n').slice(-10).join('\n');
      reject(
        new Error(`${cmd} ${args.join(' ')} exited with code ${code}${tail ? `\n${tail}` : ''}`),
      );
    });
  });
}
