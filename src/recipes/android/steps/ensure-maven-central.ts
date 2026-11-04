import { writeFile } from 'node:fs/promises';

import type { Step, StepStatus } from '../../../core/step.js';
import { findBlock } from '../blocks.js';
import { readOrNull } from '../io.js';
import type { AndroidContext } from '../types.js';

const MAVEN_CENTRAL_RE = /\bmavenCentral\s*\(\s*\)/;

const NEW_PLUGIN_MGMT = `pluginManagement {
    repositories {
        gradlePluginPortal()
        google()
        mavenCentral()
    }
}

`;

const NEW_REPOS_BLOCK = `
    repositories {
        gradlePluginPortal()
        google()
        mavenCentral()
    }
`;

export const ensureMavenCentralStep: Step<AndroidContext> = {
  id: 'android.ensure-maven-central',
  title: 'Ensure mavenCentral() is reachable for plugins',

  async precheck(ctx): Promise<StepStatus> {
    const content = await readOrNull(ctx.androidPaths.settingsGradle);
    if (content === null) {
      return { kind: 'blocked', reason: `${ctx.androidPaths.settingsGradle} not found` };
    }
    const pm = findBlock(content, 'pluginManagement');
    if (!pm) return { kind: 'pending' };
    const body = content.slice(pm.bodyStart, pm.bodyEnd);
    if (MAVEN_CENTRAL_RE.test(body)) return { kind: 'satisfied' };
    return { kind: 'pending' };
  },

  async apply(ctx) {
    const original = (await readOrNull(ctx.androidPaths.settingsGradle)) ?? '';
    const pm = findBlock(original, 'pluginManagement');
    let updated: string;
    if (!pm) {
      updated = NEW_PLUGIN_MGMT + original;
    } else {
      const body = original.slice(pm.bodyStart, pm.bodyEnd);
      const reposRel = findBlock(body, 'repositories');
      if (!reposRel) {
        updated = original.slice(0, pm.bodyEnd) + NEW_REPOS_BLOCK + original.slice(pm.bodyEnd);
      } else {
        const reposBodyEndAbs = pm.bodyStart + reposRel.bodyEnd;
        updated = `${original.slice(0, reposBodyEndAbs)}        mavenCentral()\n    ${original.slice(reposBodyEndAbs)}`;
      }
    }
    await writeFile(ctx.androidPaths.settingsGradle, updated);
  },

  async rollback(_ctx) {
    // Intentional no-op: an extra `mavenCentral()` in pluginManagement is
    // harmless and may be relied on by other plugins. Removing it could
    // break unrelated builds.
  },
};
