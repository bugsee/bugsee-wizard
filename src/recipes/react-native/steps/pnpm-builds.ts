import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as ask from '../../../core/ask.js';
import type { Step, StepStatus } from '../../../core/step.js';
import { decidePnpmBuilds } from '../../../engine/pnpm-builds.js';
import { readOrNull } from '../../android/io.js';
import { detectPackageManager } from '../package-manager.js';
import type { RnContext } from '../types.js';

/**
 * `@bugsee/react-native` depends on `@bugsee/cli`, which has a `postinstall` that is only a download
 * fallback for registry mirrors lacking its platform packages. pnpm 11 fails the install until the
 * project decides whether that script runs, so (with consent) record `false` in pnpm-workspace.yaml:
 * the package's README recommends it, and `true` only for such mirrors. Without consent the file is
 * left alone and the install may fail with pnpm's own message.
 */
const PACKAGES = ['@bugsee/cli'] as const;

/** The file as it was before this run, per run (undefined = this run did not touch it). */
const before = new WeakMap<object, string | null>();

export const rnPnpmBuildsStep: Step<RnContext> = {
  id: 'react-native.pnpm-builds',
  title: 'Record the pnpm install-script decision for @bugsee/cli',

  async precheck(ctx): Promise<StepStatus> {
    if (!ctx.rnOptions.runPackageInstall) {
      return { kind: 'satisfied', note: 'package install not requested' };
    }
    if ((await detectPackageManager(ctx.cwd)) !== 'pnpm') {
      return { kind: 'satisfied', note: 'not a pnpm project' };
    }
    return { kind: 'pending' };
  },

  async apply(ctx) {
    const file = join(ctx.cwd, 'pnpm-workspace.yaml');
    const prior = await readOrNull(file);
    before.set(ctx, prior);
    await decidePnpmBuilds({
      packages: PACKAGES,
      value: false,
      cwd: ctx.cwd,
      root: ctx.cwd,
      yes: ctx.yes,
      nonInteractive: ctx.nonInteractive,
      confirm: async (message) =>
        (await ask.confirm(false, { message, initialValue: true })) === true,
    });
  },

  async rollback(ctx) {
    if (!before.has(ctx)) return; // uninstall: the decision is the project's now
    const prior = before.get(ctx);
    before.delete(ctx);
    const file = join(ctx.cwd, 'pnpm-workspace.yaml');
    if (prior === null || prior === undefined) await rm(file, { force: true });
    else await writeFile(file, prior);
  },
};
