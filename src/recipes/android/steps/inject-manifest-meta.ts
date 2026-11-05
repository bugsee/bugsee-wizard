import { writeFile } from 'node:fs/promises';

import type { Step, StepStatus } from '../../../core/step.js';
import { readOrNull, stripMarkerBlock } from '../io.js';
import {
  type AndroidContext,
  MANIFEST_META_MARKER_BEGIN,
  MANIFEST_META_MARKER_END,
} from '../types.js';

const APPLICATION_OPEN_RE = /<application\b[^>]*>/;

// A self-closing `<application … />` has no body to hold the <meta-data>;
// splicing after the tag would land OUTSIDE the element (invalid manifest).
function isSelfClosing(openTag: string): boolean {
  return openTag.endsWith('/>');
}

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
    const open = APPLICATION_OPEN_RE.exec(content);
    if (!open) {
      return {
        kind: 'blocked',
        reason: 'No <application> element found in AndroidManifest.xml',
      };
    }
    if (isSelfClosing(open[0])) {
      return {
        kind: 'blocked',
        reason:
          '<application/> is self-closing — convert to <application>…</application> and re-run, or add the meta-data manually.',
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
    if (isSelfClosing(match[0])) {
      throw new Error('<application/> is self-closing; cannot insert <meta-data> inside it');
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
