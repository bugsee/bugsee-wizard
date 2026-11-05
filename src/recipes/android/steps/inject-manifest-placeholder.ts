import { writeFile } from 'node:fs/promises';

import type { Step, StepStatus } from '../../../core/step.js';
import { findBlock } from '../blocks.js';
import { closingBraceInsertion, readOrNull, stripMarkerBlock } from '../io.js';
import {
  type AndroidContext,
  MANIFEST_PLACEHOLDER_KEY,
  PLACEHOLDER_MARKER_BEGIN,
  PLACEHOLDER_MARKER_END,
} from '../types.js';

function placeholderInsert(): string {
  return `        ${PLACEHOLDER_MARKER_BEGIN}
        manifestPlaceholders["${MANIFEST_PLACEHOLDER_KEY}"] = bugseeAppToken
        ${PLACEHOLDER_MARKER_END}
`;
}

export const injectManifestPlaceholderStep: Step<AndroidContext> = {
  id: 'android.inject-manifest-placeholder',
  title: 'Inject manifestPlaceholders[bugseeAppToken] into defaultConfig',

  async precheck(ctx): Promise<StepStatus> {
    const content = await readOrNull(ctx.androidPaths.appBuildGradle);
    if (content === null) {
      return { kind: 'blocked', reason: `${ctx.androidPaths.appBuildGradle} not found` };
    }
    if (content.includes(PLACEHOLDER_MARKER_BEGIN)) {
      return { kind: 'satisfied' };
    }
    if (!findBlock(content, 'defaultConfig')) {
      return {
        kind: 'blocked',
        reason: 'No defaultConfig {} block found in app build script',
      };
    }
    return { kind: 'pending' };
  },

  async apply(ctx) {
    const original = (await readOrNull(ctx.androidPaths.appBuildGradle)) ?? '';
    const dc = findBlock(original, 'defaultConfig');
    if (!dc) {
      throw new Error('No defaultConfig {} block found in app build script');
    }
    // Insert at the start of the line that contains the closing brace, so
    // the inserted block sits on its own lines with consistent indentation
    // and rollback can strip it cleanly without mangling the brace's indent.
    // When the braces share a line (`defaultConfig { … }`) the block goes
    // right before the closing brace instead, so it stays inside defaultConfig.
    const { at, prefix } = closingBraceInsertion(original, dc.bodyEnd, true);
    const updated = original.slice(0, at) + prefix + placeholderInsert() + original.slice(at);
    await writeFile(ctx.androidPaths.appBuildGradle, updated);
  },

  async rollback(ctx) {
    const content = await readOrNull(ctx.androidPaths.appBuildGradle);
    if (content === null) return;
    const stripped = stripMarkerBlock(content, PLACEHOLDER_MARKER_BEGIN, PLACEHOLDER_MARKER_END);
    if (stripped !== content) {
      await writeFile(ctx.androidPaths.appBuildGradle, stripped);
    }
  },
};
