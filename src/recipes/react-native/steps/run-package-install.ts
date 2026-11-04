import * as clack from '@clack/prompts';

import type { Step, StepStatus } from '../../../core/step.js';
import { detectPackageManager, isManagerOnPath, runInstall } from '../package-manager.js';
import type { RnContext } from '../types.js';

/**
 * Opt-in: run `npm install` / `yarn install` / `pnpm install` / `bun
 * install` after `package.json` was edited so node_modules picks up the
 * new dependency. Detects the package manager via lockfile presence;
 * falls back to `npm` when no lockfile exists.
 *
 * Mirrors the iOS recipe's `pod install` pattern: only runs when the
 * user opted in *and* the manager is on PATH. Rollback is a deliberate
 * no-op — undoing it would mean deleting `node_modules`, which is
 * destructive and rarely what the user wants.
 *
 * Skipped silently when the user declined via `runPackageInstall=false`
 * in the parent recipe's options.
 */
export const runPackageInstallStep: Step<RnContext> = {
  id: 'react-native.run-package-install',
  title: 'Run package install',

  async precheck(ctx): Promise<StepStatus> {
    if (!ctx.rnOptions.runPackageInstall) {
      return { kind: 'satisfied', note: 'package install not requested' };
    }
    const manager = await detectPackageManager(ctx.cwd);
    if (!isManagerOnPath(manager)) {
      return {
        kind: 'blocked',
        reason: `${manager} is not on PATH — install it (or pick a different package manager) and re-run`,
      };
    }
    return { kind: 'pending' };
  },

  async apply(ctx) {
    const manager = await detectPackageManager(ctx.cwd);
    const spinner = clack.spinner();
    spinner.start(`Running ${manager} install — this can take a minute`);
    try {
      await runInstall(manager, ctx.cwd, ctx.debug);
      spinner.stop(`${manager} install complete`);
    } catch (err) {
      spinner.error(`${manager} install failed`);
      throw err;
    }
  },

  async rollback(_ctx) {
    // No-op: the equivalent of `pod deintegrate` for npm would be to
    // delete `node_modules` and revert the lockfile, both of which are
    // destructive in ways the user almost never wants when they're
    // rolling back the wizard. The earlier `ensureRnBugseePackageStep`
    // rollback drops our entry from `package.json`; running install
    // again afterwards lets the lockfile catch up cleanly.
  },
};
