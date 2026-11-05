import { writeFile } from 'node:fs/promises';

import type { Step, StepStatus } from '../../../core/step.js';
import { findBlock } from '../blocks.js';
import { readOrNull, stripMarkerBlock } from '../io.js';
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
val bugseeProps = java.util.Properties().apply {
    val f = rootProject.file("${PROPERTIES_FILE_NAME}")
    if (f.exists()) java.io.FileInputStream(f).use { load(it) }
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

/**
 * Where the loader goes. Gradle's Groovy DSL rejects any statement before
 * a `plugins {}` block, so the loader lands on the line after its closing
 * brace. With no `plugins {}` block (legacy `apply plugin:`), it goes at the
 * top of the file — but below any leading `import` lines, which Kotlin
 * scripts require before every other statement.
 */
function loaderInsertionPoint(source: string): number {
  const plugins = findBlock(source, 'plugins', { topLevel: true });
  if (plugins) {
    const nl = source.indexOf('\n', plugins.closeBrace);
    return nl === -1 ? source.length : nl + 1;
  }
  const header = /^(?:[ \t]*import\s[^\n]*\n|[ \t]*\n)*/.exec(source);
  return header ? header[0].length : 0;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    // Match the file's line endings so a CRLF build script stays uniformly CRLF.
    const eol = original.includes('\r\n') ? '\r\n' : '\n';
    let block = loaderBlock(ctx.androidPaths.appBuildGradleDsl).replaceAll('\n', eol);
    const insertAt = loaderInsertionPoint(original);
    // No trailing newline after `plugins {}` (it is the last line): separate
    // the loader with one and omit the block's own final newline, so rollback
    // (which strips this tail form whole) restores the file byte-for-byte.
    let lead = '';
    if (insertAt > 0 && original[insertAt - 1] !== '\n') {
      lead = eol;
      block = block.slice(0, -eol.length);
    }
    const updated = original.slice(0, insertAt) + lead + block + original.slice(insertAt);
    await writeFile(ctx.androidPaths.appBuildGradle, updated);
  },

  async rollback(ctx) {
    const content = await readOrNull(ctx.androidPaths.appBuildGradle);
    if (content === null) return;
    // Tail form written by apply() for a file with no trailing newline:
    // `<eol>BEGIN…END` at EOF. Remove the separator with it.
    const tail = new RegExp(
      `\\r?\\n[ \\t]*${escapeRegex(LOADER_MARKER_BEGIN)}[\\s\\S]*?${escapeRegex(LOADER_MARKER_END)}$`,
    );
    const stripped = tail.test(content)
      ? content.replace(tail, '')
      : stripMarkerBlock(content, LOADER_MARKER_BEGIN, LOADER_MARKER_END);
    if (stripped !== content) {
      await writeFile(ctx.androidPaths.appBuildGradle, stripped);
    }
  },
};
