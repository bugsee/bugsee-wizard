import { writeFile } from 'node:fs/promises';

import type { Step, StepStatus } from '../../../core/step.js';
import { findBlock } from '../blocks.js';
import { readOrNull, stripMarkerBlock } from '../io.js';
import {
  type AndroidContext,
  APPLY_PLUGIN_MARKER_BEGIN,
  APPLY_PLUGIN_MARKER_END,
  BUGSEE_PLUGIN_ID,
  BUGSEE_PLUGIN_VERSION,
  type GradleDsl,
} from '../types.js';

const PLUGIN_PRESENT_RE = new RegExp(`["']${BUGSEE_PLUGIN_ID.replace(/\./g, '\\.')}["']`);

function pluginsDslLine(dsl: GradleDsl): string {
  return dsl === 'kotlin'
    ? `    id("${BUGSEE_PLUGIN_ID}") version "${BUGSEE_PLUGIN_VERSION}"\n`
    : `    id '${BUGSEE_PLUGIN_ID}' version '${BUGSEE_PLUGIN_VERSION}'\n`;
}

/**
 * Imperative `apply plugin: "…"` (Groovy) or `apply(plugin = "…")` (Kotlin)
 * line wrapped in markers so rollback can strip it cleanly. Used for
 * legacy-style scripts where the plugin ID is applied imperatively. The
 * plugin's classpath must be added separately in the project-level
 * buildscript by `addBuildscriptClasspathStep`.
 */
function legacyApplyBlock(dsl: GradleDsl): string {
  const line =
    dsl === 'kotlin'
      ? `apply(plugin = "${BUGSEE_PLUGIN_ID}")`
      : `apply plugin: "${BUGSEE_PLUGIN_ID}"`;
  return `${APPLY_PLUGIN_MARKER_BEGIN}
${line}
${APPLY_PLUGIN_MARKER_END}
`;
}

/** Match an existing imperative `apply` line in the appropriate DSL. */
function existingApplyRegex(dsl: GradleDsl): RegExp {
  return dsl === 'kotlin'
    ? /^\s*apply\s*\(\s*plugin\s*=\s*["'][^"']+["']\s*\)\s*$/gm
    : /^\s*apply\s+plugin\s*:\s*["'][^"']+["']\s*$/gm;
}

export const applyPluginStep: Step<AndroidContext> = {
  id: 'android.apply-plugin',
  title: `Apply ${BUGSEE_PLUGIN_ID} in app build script`,

  async precheck(ctx): Promise<StepStatus> {
    const content = await readOrNull(ctx.androidPaths.appBuildGradle);
    if (content === null) {
      return { kind: 'blocked', reason: `${ctx.androidPaths.appBuildGradle} not found` };
    }
    if (PLUGIN_PRESENT_RE.test(content)) return { kind: 'satisfied' };
    if (ctx.androidPaths.appBuildScriptStyle === 'plugins-dsl') {
      const plugins = findBlock(content, 'plugins');
      if (!plugins) {
        return {
          kind: 'blocked',
          reason: 'plugins-dsl style was detected but plugins {} block is missing',
        };
      }
    }
    return { kind: 'pending' };
  },

  async apply(ctx) {
    const original = (await readOrNull(ctx.androidPaths.appBuildGradle)) ?? '';
    let updated: string;
    if (ctx.androidPaths.appBuildScriptStyle === 'plugins-dsl') {
      const plugins = findBlock(original, 'plugins');
      if (!plugins) throw new Error('No plugins {} block found in app build script');
      const insertAt = plugins.bodyEnd;
      updated =
        original.slice(0, insertAt) +
        pluginsDslLine(ctx.androidPaths.appBuildGradleDsl) +
        original.slice(insertAt);
    } else {
      // Legacy: append our imperative apply line after the last existing
      // one of the same DSL form so the ordering stays predictable. If
      // none exist, prepend at the top.
      const dsl = ctx.androidPaths.appBuildGradleDsl;
      const applyLineRe = existingApplyRegex(dsl);
      let lastEnd = 0;
      let any = false;
      for (const m of original.matchAll(applyLineRe)) {
        if (m.index === undefined) continue;
        any = true;
        lastEnd = m.index + m[0].length;
      }
      const insertAt = any ? skipNewline(original, lastEnd) : 0;
      updated = original.slice(0, insertAt) + legacyApplyBlock(dsl) + original.slice(insertAt);
    }
    await writeFile(ctx.androidPaths.appBuildGradle, updated);
  },

  async rollback(ctx) {
    const content = await readOrNull(ctx.androidPaths.appBuildGradle);
    if (content === null) return;
    if (ctx.androidPaths.appBuildScriptStyle === 'plugins-dsl') {
      // Remove any line that mentions the plugin id. Targets the line we
      // wrote in plugins-dsl mode.
      const updated = content
        .split('\n')
        .filter((line) => !PLUGIN_PRESENT_RE.test(line))
        .join('\n');
      if (updated !== content) {
        await writeFile(ctx.androidPaths.appBuildGradle, updated);
      }
      return;
    }
    const stripped = stripMarkerBlock(content, APPLY_PLUGIN_MARKER_BEGIN, APPLY_PLUGIN_MARKER_END);
    if (stripped !== content) {
      await writeFile(ctx.androidPaths.appBuildGradle, stripped);
    }
  },
};

/**
 * Advance past a `\n` immediately following `idx`, if any. Lets the caller
 * insert at the start of the *next* line — column-zero anchored insertion.
 */
function skipNewline(s: string, idx: number): number {
  if (s[idx] === '\n') return idx + 1;
  // Be tolerant of a trailing space + newline on the matched line.
  let i = idx;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  if (s[i] === '\n') return i + 1;
  return idx;
}
