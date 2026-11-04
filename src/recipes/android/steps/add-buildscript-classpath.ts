import { writeFile } from 'node:fs/promises';

import type { Step, StepStatus } from '../../../core/step.js';
import { findBlock } from '../blocks.js';
import { lineStartBefore, readOrNull, stripMarkerBlock } from '../io.js';
import {
  type AndroidContext,
  BUGSEE_GRADLE_PLUGIN_ARTIFACT,
  BUGSEE_PLUGIN_VERSION,
  BUILDSCRIPT_CLASSPATH_MARKER_BEGIN,
  BUILDSCRIPT_CLASSPATH_MARKER_END,
  type GradleDsl,
} from '../types.js';

const CLASSPATH_PRESENT_RE = new RegExp(
  `["']${BUGSEE_GRADLE_PLUGIN_ARTIFACT.replace(/[.:\-]/g, (c) => `\\${c}`)}`,
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
    const content = await readOrNull(ctx.androidPaths.projectBuildGradle);
    if (content === null) {
      return {
        kind: 'blocked',
        reason: `${ctx.androidPaths.projectBuildGradle} not found`,
      };
    }
    if (CLASSPATH_PRESENT_RE.test(content)) return { kind: 'satisfied' };
    const buildscript = findBlock(content, 'buildscript');
    if (!buildscript) {
      return {
        kind: 'blocked',
        reason: 'No buildscript {} block in project-level build.gradle',
      };
    }
    const buildscriptBody = content.slice(buildscript.bodyStart, buildscript.bodyEnd);
    if (!findBlock(buildscriptBody, 'dependencies')) {
      return {
        kind: 'blocked',
        reason: 'No buildscript.dependencies {} block in project-level build.gradle',
      };
    }
    return { kind: 'pending' };
  },

  async apply(ctx) {
    const original = (await readOrNull(ctx.androidPaths.projectBuildGradle)) ?? '';
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
    const insertAt = lineStartBefore(original, depsBodyEndAbs);
    const updated =
      original.slice(0, insertAt) +
      classpathBlock(ctx.androidPaths.projectBuildGradleDsl) +
      original.slice(insertAt);
    await writeFile(ctx.androidPaths.projectBuildGradle, updated);
  },

  async rollback(ctx) {
    const content = await readOrNull(ctx.androidPaths.projectBuildGradle);
    if (content === null) return;
    const stripped = stripMarkerBlock(
      content,
      BUILDSCRIPT_CLASSPATH_MARKER_BEGIN,
      BUILDSCRIPT_CLASSPATH_MARKER_END,
    );
    if (stripped !== content) {
      await writeFile(ctx.androidPaths.projectBuildGradle, stripped);
    }
  },
};
