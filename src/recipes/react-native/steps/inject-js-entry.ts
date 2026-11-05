import { writeFile } from 'node:fs/promises';

import type { Step, StepStatus } from '../../../core/step.js';
import { readOrNull, stripMarkerBlock } from '../../android/io.js';
import {
  JS_INIT_MARKER_BEGIN,
  JS_INIT_MARKER_END,
  JS_LAUNCH_MARKER_BEGIN,
  JS_LAUNCH_MARKER_END,
  RN_PACKAGE_NAME,
  type RnContext,
} from '../types.js';

/** Match `import X from 'Y'` and `import {…} from 'Y'` and bare `import 'Y';`. */
const IMPORT_LINE_RE =
  /^\s*import\s+[^;]+?from\s+['"][^'"]+['"]\s*;?\s*$|^\s*import\s+['"][^'"]+['"]\s*;?\s*$/gm;

/**
 * The launch call for the platforms whose token is known. A platform without a token gets no
 * branch: a placeholder would ship as a real token string. Null when there is no token at all.
 */
export function launchStatement(
  tokens: Readonly<Record<string, string>>,
  platformIdent: string,
): string | null {
  const { ios, android } = tokens;
  if (ios !== undefined && android !== undefined) {
    return `Bugsee.launch(${platformIdent}.OS === 'ios' ? '${ios}' : '${android}');`;
  }
  if (ios !== undefined) {
    return `if (${platformIdent}.OS === 'ios') {\n  Bugsee.launch('${ios}');\n}`;
  }
  if (android !== undefined) {
    return `if (${platformIdent}.OS === 'android') {\n  Bugsee.launch('${android}');\n}`;
  }
  return null;
}

function jsLaunchBlock(tokens: Readonly<Record<string, string>>): string | null {
  const statement = launchStatement(tokens, 'BugseePlatform');
  if (statement === null) return null;
  return `${JS_LAUNCH_MARKER_BEGIN}
import Bugsee from '${RN_PACKAGE_NAME}';
import { Platform as BugseePlatform } from 'react-native';

${statement}
${JS_LAUNCH_MARKER_END}
`;
}

function findInsertPosition(source: string): number {
  // Place the block just after the last top-level `import` line so the
  // launch / init runs once at module load — before component code or
  // `AppRegistry.registerComponent`.
  let lastEnd = 0;
  let match: RegExpExecArray | null;
  // Use a global regex with a manual loop so we capture every match
  // without modifying the regex's lastIndex state across calls.
  const re = new RegExp(IMPORT_LINE_RE.source, 'gm');
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
  while ((match = re.exec(source))) {
    lastEnd = match.index + match[0].length;
  }
  if (lastEnd === 0) return 0;
  // Land on the start of the next line.
  return source[lastEnd] === '\n' ? lastEnd + 1 : lastEnd;
}

/** The note a skipped step carries when the user still has to add the launch by hand. */
export const SNIPPET_NOTE_MARK = 'snippet will be printed at the end';

/** The entry file as it was before this run replaced its launch block (per run). */
const replaced = new WeakMap<object, string>();

export const injectJsEntryStep: Step<RnContext> = {
  id: 'react-native.inject-js-entry',
  title: 'Launch Bugsee from the JS entry',

  async precheck(ctx): Promise<StepStatus> {
    if (!ctx.rnOptions.autoInjectJsEntry) {
      return { kind: 'satisfied', note: 'auto-inject not selected' };
    }
    if (!ctx.rnPaths.jsEntry) {
      return {
        kind: 'satisfied',
        note: `no App.tsx / index.js found — ${SNIPPET_NOTE_MARK}`,
      };
    }
    const content = await readOrNull(ctx.rnPaths.jsEntry.path);
    if (content === null) {
      return {
        kind: 'satisfied',
        note: `JS entry not readable — ${SNIPPET_NOTE_MARK}`,
      };
    }
    // only the exact block for these tokens counts: a stale or foreign one is replaced on apply
    const expected = jsLaunchBlock(ctx.tokens);
    if (
      expected !== null &&
      content.includes(expected) &&
      !content.includes(JS_INIT_MARKER_BEGIN)
    ) {
      return { kind: 'satisfied' };
    }
    return { kind: 'pending' };
  },

  async apply(ctx) {
    if (!ctx.rnPaths.jsEntry) throw new Error('JS entry path not resolved');
    const block = jsLaunchBlock(ctx.tokens);
    if (block === null) throw new Error('No Bugsee token to launch with');
    const read = (await readOrNull(ctx.rnPaths.jsEntry.path)) ?? '';
    replaced.set(ctx, read);
    let original = stripMarkerBlock(read, JS_LAUNCH_MARKER_BEGIN, JS_LAUNCH_MARKER_END);
    original = stripMarkerBlock(original, JS_INIT_MARKER_BEGIN, JS_INIT_MARKER_END);
    const insertAt = findInsertPosition(original);
    const updated = original.slice(0, insertAt) + block + original.slice(insertAt);
    await writeFile(ctx.rnPaths.jsEntry.path, updated);
  },

  async rollback(ctx) {
    if (!ctx.rnPaths.jsEntry) return;
    // this run replaced the entry: put back exactly what was there (a customised or stale block)
    const before = replaced.get(ctx);
    if (before !== undefined) {
      replaced.delete(ctx);
      await writeFile(ctx.rnPaths.jsEntry.path, before);
      return;
    }
    // uninstall: strip the launch block, and the init block an earlier wizard wrote
    const content = await readOrNull(ctx.rnPaths.jsEntry.path);
    if (content === null) return;
    let stripped = stripMarkerBlock(content, JS_LAUNCH_MARKER_BEGIN, JS_LAUNCH_MARKER_END);
    stripped = stripMarkerBlock(stripped, JS_INIT_MARKER_BEGIN, JS_INIT_MARKER_END);
    if (stripped !== content) {
      await writeFile(ctx.rnPaths.jsEntry.path, stripped);
    }
  },
};
