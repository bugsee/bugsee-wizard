import { writeFile } from 'node:fs/promises';

import type { Step, StepStatus } from '../../../core/step.js';
import { readOrNull, stripMarkerBlock } from '../io.js';
import {
  type AndroidContext,
  MANIFEST_META_MARKER_BEGIN,
  MANIFEST_META_MARKER_END,
} from '../types.js';

const APPLICATION_OPEN_RE = /<application\b[^>]*>/;

function metaForAutomatic(): string {
  return `    ${MANIFEST_META_MARKER_BEGIN}
    <meta-data
        android:name="com.bugsee.app-token"
        android:value="\${bugseeAppToken}" />
    ${MANIFEST_META_MARKER_END}
`;
}

function metaForManual(): string {
  return `    ${MANIFEST_META_MARKER_BEGIN}
    <meta-data
        android:name="com.bugsee.auto-init"
        android:value="false" />
    ${MANIFEST_META_MARKER_END}
`;
}

export const injectManifestMetaStep: Step<AndroidContext> = {
  id: 'android.inject-manifest-meta',
  title: 'Inject Bugsee meta-data into AndroidManifest.xml',

  async precheck(ctx): Promise<StepStatus> {
    const content = await readOrNull(ctx.androidPaths.appManifest);
    if (content === null) {
      return { kind: 'blocked', reason: `${ctx.androidPaths.appManifest} not found` };
    }
    if (content.includes(MANIFEST_META_MARKER_BEGIN)) {
      return { kind: 'satisfied' };
    }
    if (!APPLICATION_OPEN_RE.test(content)) {
      return {
        kind: 'blocked',
        reason: 'No <application> element found in AndroidManifest.xml',
      };
    }
    return { kind: 'pending' };
  },

  async apply(ctx) {
    const original = (await readOrNull(ctx.androidPaths.appManifest)) ?? '';
    const match = APPLICATION_OPEN_RE.exec(original);
    if (!match) {
      throw new Error('No <application> element found in AndroidManifest.xml');
    }
    // Insert at the start of the line *after* the <application ...> tag so
    // the meta-data block sits at column 0 with its own indentation.
    let insertAt = match.index + match[0].length;
    if (original[insertAt] === '\n') insertAt++;
    const meta = ctx.androidOptions.initMode === 'automatic' ? metaForAutomatic() : metaForManual();
    const updated = original.slice(0, insertAt) + meta + original.slice(insertAt);
    await writeFile(ctx.androidPaths.appManifest, updated);
  },

  async rollback(ctx) {
    const content = await readOrNull(ctx.androidPaths.appManifest);
    if (content === null) return;
    const stripped = stripMarkerBlock(
      content,
      MANIFEST_META_MARKER_BEGIN,
      MANIFEST_META_MARKER_END,
    );
    if (stripped !== content) {
      await writeFile(ctx.androidPaths.appManifest, stripped);
    }
  },
};
