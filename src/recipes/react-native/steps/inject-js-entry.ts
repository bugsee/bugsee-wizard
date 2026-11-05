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

function jsLaunchBlock(androidToken: string, iosToken: string): string {
  return `${JS_LAUNCH_MARKER_BEGIN}
import Bugsee from '${RN_PACKAGE_NAME}';
import { Platform as BugseePlatform } from 'react-native';

Bugsee.launch(BugseePlatform.OS === 'ios' ? '${iosToken}' : '${androidToken}');
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
        note: 'no App.tsx / index.js found — snippet will be printed at the end',
      };
    }
    const content = await readOrNull(ctx.rnPaths.jsEntry.path);
    if (content === null) {
      return {
        kind: 'satisfied',
        note: 'JS entry not readable — snippet will be printed at the end',
      };
    }
    if (content.includes(JS_LAUNCH_MARKER_BEGIN) || content.includes(JS_INIT_MARKER_BEGIN)) {
      return { kind: 'satisfied' };
    }
    return { kind: 'pending' };
  },

  async apply(ctx) {
    if (!ctx.rnPaths.jsEntry) throw new Error('JS entry path not resolved');
    const original = (await readOrNull(ctx.rnPaths.jsEntry.path)) ?? '';
    const block = jsLaunchBlock(
      ctx.tokens.android ?? '<ANDROID_TOKEN>',
      ctx.tokens.ios ?? '<IOS_TOKEN>',
    );
    const insertAt = findInsertPosition(original);
    const updated = original.slice(0, insertAt) + block + original.slice(insertAt);
    await writeFile(ctx.rnPaths.jsEntry.path, updated);
  },

  async rollback(ctx) {
    if (!ctx.rnPaths.jsEntry) return;
    const content = await readOrNull(ctx.rnPaths.jsEntry.path);
    if (content === null) return;
    // The launch block, and the init block an earlier wizard wrote for the native launch path.
    let stripped = stripMarkerBlock(content, JS_LAUNCH_MARKER_BEGIN, JS_LAUNCH_MARKER_END);
    stripped = stripMarkerBlock(stripped, JS_INIT_MARKER_BEGIN, JS_INIT_MARKER_END);
    if (stripped !== content) {
      await writeFile(ctx.rnPaths.jsEntry.path, stripped);
    }
  },
};
