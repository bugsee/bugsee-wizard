import { writeFile } from 'node:fs/promises';

import type { Step, StepStatus } from '../../../core/step.js';
import { findBlock, maskCommentsAndStrings } from '../blocks.js';
import { closingBraceInsertion, readOrNull, stripMarkerBlock } from '../io.js';
import {
  type AndroidContext,
  BUGSEE_GRADLE_PLUGIN_ARTIFACT,
  BUGSEE_PLUGIN_VERSION,
  BUILDSCRIPT_CLASSPATH_MARKER_BEGIN,
  BUILDSCRIPT_CLASSPATH_MARKER_END,
  type GradleDsl,
} from '../types.js';

const CLASSPATH_PRESENT_RE = new RegExp(
  `["']${BUGSEE_GRADLE_PLUGIN_ARTIFACT.replace(/[.:-]/g, (c) => `\\${c}`)}`,
);

function classpathBlock(dsl: GradleDsl): string {
  const line =
    dsl === 'kotlin'
      ? `        classpath("${BUGSEE_GRADLE_PLUGIN_ARTIFACT}:${BUGSEE_PLUGIN_VERSION}")`
      : `        classpath '${BUGSEE_GRADLE_PLUGIN_ARTIFACT}:${BUGSEE_PLUGIN_VERSION}'`;
  return `        ${BUILDSCRIPT_CLASSPATH_MARKER_BEGIN}
${line}
        ${BUILDSCRIPT_CLASSPATH_MARKER_END}
`;
}

/**
 * Required for legacy-apply scripts. Adds a `classpath(...)` line to the
 * project-level build.gradle's `buildscript { dependencies { … } }` block
 * so the `apply plugin: "com.bugsee.android.gradle"` line in the app's
 * build script can resolve.
 *
 * No-op for plugins-dsl scripts (the plugin DSL handles resolution via
 * `pluginManagement` in `settings.gradle`).
 */
export const addBuildscriptClasspathStep: Step<AndroidContext> = {
  id: 'android.add-buildscript-classpath',
  title: 'Add Bugsee plugin classpath to project buildscript',

  async precheck(ctx): Promise<StepStatus> {
    const file = ctx.androidPaths.projectBuildGradle;
    const content = file === null ? null : await readOrNull(file);
    if (content === null) {
      return {
        kind: 'blocked',
        reason: `${file ?? 'project-level build.gradle[.kts]'} not found`,
      };
    }
    const buildscript = findBlock(content, 'buildscript');
    if (!buildscript) {
      return {
        kind: 'blocked',
        reason: 'No buildscript {} block in project-level build.gradle',
      };
    }
    const buildscriptBody = content.slice(buildscript.bodyStart, buildscript.bodyEnd);
    const deps = findBlock(buildscriptBody, 'dependencies');
    if (!deps) {
      return {
        kind: 'blocked',
        reason: 'No buildscript.dependencies {} block in project-level build.gradle',
      };
    }
    // Only an active declaration inside buildscript.dependencies counts: a
    // commented-out line or a top-level `dependencies` mention must not
    // satisfy the step (the legacy `apply plugin:` would then not resolve).
    const depsBody = buildscriptBody.slice(deps.bodyStart, deps.bodyEnd);
    if (CLASSPATH_PRESENT_RE.test(maskCommentsAndStrings(depsBody, true))) {
      return { kind: 'satisfied' };
    }
    return { kind: 'pending' };
  },

  async apply(ctx) {
    const { projectBuildGradle: file, projectBuildGradleDsl: dsl } = ctx.androidPaths;
    if (file === null || dsl === null)
      throw new Error('project-level build.gradle[.kts] not found');
    const original = (await readOrNull(file)) ?? '';
    const buildscript = findBlock(original, 'buildscript');
    if (!buildscript) {
      throw new Error('No buildscript {} block in project-level build.gradle');
    }
    const buildscriptBody = original.slice(buildscript.bodyStart, buildscript.bodyEnd);
    const depsRel = findBlock(buildscriptBody, 'dependencies');
    if (!depsRel) {
      throw new Error('No buildscript.dependencies {} block in project-level build.gradle');
    }
    const depsBodyEndAbs = buildscript.bodyStart + depsRel.bodyEnd;
    const { at, prefix } = closingBraceInsertion(original, depsBodyEndAbs, true);
    const updated = original.slice(0, at) + prefix + classpathBlock(dsl) + original.slice(at);
    await writeFile(file, updated);
  },

  async rollback(ctx) {
    const file = ctx.androidPaths.projectBuildGradle;
    const content = file === null ? null : await readOrNull(file);
    if (file === null || content === null) return;
    const stripped = stripMarkerBlock(
      content,
      BUILDSCRIPT_CLASSPATH_MARKER_BEGIN,
      BUILDSCRIPT_CLASSPATH_MARKER_END,
    );
    if (stripped !== content) {
      await writeFile(file, stripped);
    }
  },
};
