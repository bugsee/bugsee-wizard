import { writeFile } from 'node:fs/promises';

import type { Step, StepStatus } from '../../../core/step.js';
import { findBlock } from '../blocks.js';
import { lineStartBefore, readOrNull, stripMarkerBlock } from '../io.js';
import {
  type AndroidContext,
  type GradleDsl,
  LOADER_MARKER_BEGIN,
  LOADER_MARKER_END,
  PROPERTIES_FILE_NAME,
  TOKEN_PROPERTY_KEY,
} from '../types.js';

const LOADER_SIGNATURE_KOTLIN = /val\s+bugseeAppToken\s*:/;
const LOADER_SIGNATURE_GROOVY = /def\s+bugseeAppToken\s*=/;

function loaderBlock(dsl: GradleDsl): string {
  if (dsl === 'kotlin') {
    return `${LOADER_MARKER_BEGIN}
import java.io.FileInputStream
import java.util.Properties

val bugseeProps = Properties().apply {
    val f = rootProject.file("${PROPERTIES_FILE_NAME}")
    if (f.exists()) FileInputStream(f).use { load(it) }
}
val bugseeAppToken: String = bugseeProps.getProperty("${TOKEN_PROPERTY_KEY}", "")
${LOADER_MARKER_END}
`;
  }
  return `${LOADER_MARKER_BEGIN}
def bugseeProps = new Properties()
def bugseePropsFile = rootProject.file('${PROPERTIES_FILE_NAME}')
if (bugseePropsFile.exists()) {
    bugseePropsFile.withInputStream { bugseeProps.load(it) }
}
def bugseeAppToken = bugseeProps.getProperty('${TOKEN_PROPERTY_KEY}', '')
${LOADER_MARKER_END}
`;
}

function isLoaderPresent(content: string, dsl: GradleDsl): boolean {
  const sig = dsl === 'kotlin' ? LOADER_SIGNATURE_KOTLIN : LOADER_SIGNATURE_GROOVY;
  return sig.test(content);
}

export const injectLoaderStep: Step<AndroidContext> = {
  id: 'android.inject-loader',
  title: `Inject ${PROPERTIES_FILE_NAME} loader into app build script`,

  async precheck(ctx): Promise<StepStatus> {
    const content = await readOrNull(ctx.androidPaths.appBuildGradle);
    if (content === null) {
      return { kind: 'blocked', reason: `${ctx.androidPaths.appBuildGradle} not found` };
    }
    return isLoaderPresent(content, ctx.androidPaths.appBuildGradleDsl)
      ? { kind: 'satisfied' }
      : { kind: 'pending' };
  },

  async apply(ctx) {
    const original = (await readOrNull(ctx.androidPaths.appBuildGradle)) ?? '';
    const block = loaderBlock(ctx.androidPaths.appBuildGradleDsl);
    // Insert at the start of the line that contains `plugins`. Falls back
    // to file start when no plugins block is present. Anchoring at column
    // zero keeps the rollback strip-regex symmetric with the apply.
    const plugins = findBlock(original, 'plugins');
    const insertAt = plugins ? lineStartBefore(original, plugins.start) : 0;
    const updated = original.slice(0, insertAt) + block + original.slice(insertAt);
    await writeFile(ctx.androidPaths.appBuildGradle, updated);
  },

  async rollback(ctx) {
    const content = await readOrNull(ctx.androidPaths.appBuildGradle);
    if (content === null) return;
    const stripped = stripMarkerBlock(content, LOADER_MARKER_BEGIN, LOADER_MARKER_END);
    if (stripped !== content) {
      await writeFile(ctx.androidPaths.appBuildGradle, stripped);
    }
  },
};
