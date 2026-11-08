import { writeFile } from 'node:fs/promises';

import { stringifyLike } from '../../../core/json-text.js';
import type { Step, StepStatus } from '../../../core/step.js';
import { readOrNull } from '../../android/io.js';
import {
  LEGACY_RN_PACKAGE_NAME,
  RN_PACKAGE_NAME,
  RN_PACKAGE_VERSION,
  type RnContext,
} from '../types.js';

interface PackageJsonShape {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Ensure the RN wrapper (`@bugsee/react-native`) is in `package.json`'s
 * `dependencies`. Doesn't run the install — that's the next step's job
 * (and is opt-in). Preserves the user's indent style via `detect-indent`
 * so the diff is minimal.
 */
export const ensureRnBugseePackageStep: Step<RnContext> = {
  id: 'react-native.ensure-rn-bugsee-package',
  title: `Add ${RN_PACKAGE_NAME} to package.json`,

  async precheck(ctx): Promise<StepStatus> {
    const content = await readOrNull(ctx.rnPaths.packageJson);
    if (content === null) {
      return { kind: 'blocked', reason: `${ctx.rnPaths.packageJson} not found` };
    }
    let parsed: PackageJsonShape;
    try {
      parsed = JSON.parse(content) as PackageJsonShape;
    } catch (err) {
      return {
        kind: 'blocked',
        reason: `${ctx.rnPaths.packageJson} is not valid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
    const inDeps = !!parsed.dependencies?.[RN_PACKAGE_NAME];
    const inDevDeps = !!parsed.devDependencies?.[RN_PACKAGE_NAME];
    return inDeps || inDevDeps ? { kind: 'satisfied' } : { kind: 'pending' };
  },

  async apply(ctx) {
    const original = (await readOrNull(ctx.rnPaths.packageJson)) ?? '{}';
    const parsed = JSON.parse(original) as PackageJsonShape;
    parsed.dependencies = parsed.dependencies ?? {};
    parsed.dependencies[RN_PACKAGE_NAME] = RN_PACKAGE_VERSION;
    await writeFile(ctx.rnPaths.packageJson, stringifyLike(parsed, original));
  },

  async rollback(ctx) {
    const original = await readOrNull(ctx.rnPaths.packageJson);
    if (original === null) return;
    let parsed: PackageJsonShape;
    try {
      parsed = JSON.parse(original) as PackageJsonShape;
    } catch {
      return;
    }
    let changed = false;
    // the old wrapper too: wizards before the move to @bugsee/react-native installed it
    for (const name of [RN_PACKAGE_NAME, LEGACY_RN_PACKAGE_NAME]) {
      if (parsed.dependencies && name in parsed.dependencies) {
        delete parsed.dependencies[name];
        changed = true;
      }
      if (parsed.devDependencies && name in parsed.devDependencies) {
        delete parsed.devDependencies[name];
        changed = true;
      }
    }
    if (!changed) return;
    await writeFile(ctx.rnPaths.packageJson, stringifyLike(parsed, original));
  },
};
