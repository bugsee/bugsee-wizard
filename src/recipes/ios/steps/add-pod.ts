import { writeFile } from 'node:fs/promises';

import type { Step, StepStatus } from '../../../core/step.js';
import { lineStartBefore, readOrNull, stripMarkerBlock } from '../../android/io.js';
import { findTargetBlock } from '../podfile.js';
import {
  BUGSEE_POD_NAME,
  type IosContext,
  PODFILE_MARKER_BEGIN,
  PODFILE_MARKER_END,
} from '../types.js';

const POD_PRESENT_RE = new RegExp(`\\bpod\\s+['"]${BUGSEE_POD_NAME}['"]`);

function podLine(): string {
  return `  ${PODFILE_MARKER_BEGIN}
  pod '${BUGSEE_POD_NAME}'
  ${PODFILE_MARKER_END}
`;
}

export const addPodStep: Step<IosContext> = {
  id: 'ios.add-pod',
  title: `Add pod '${BUGSEE_POD_NAME}' to Podfile`,

  async precheck(ctx): Promise<StepStatus> {
    if (ctx.iosOptions.distribution !== 'cocoapods') {
      return { kind: 'satisfied', note: 'CocoaPods not selected' };
    }
    if (!ctx.iosPaths.podfile) {
      return { kind: 'blocked', reason: 'CocoaPods selected but no Podfile found' };
    }
    const content = await readOrNull(ctx.iosPaths.podfile);
    if (content === null) {
      return { kind: 'blocked', reason: `${ctx.iosPaths.podfile} not readable` };
    }
    const target = findTargetBlock(content, ctx.iosPaths.schemeName);
    if (!target) {
      return {
        kind: 'blocked',
        reason: `No 'target ${JSON.stringify(ctx.iosPaths.schemeName)} do' block in Podfile`,
      };
    }
    const body = content.slice(target.bodyStart, target.bodyEnd);
    return POD_PRESENT_RE.test(body) ? { kind: 'satisfied' } : { kind: 'pending' };
  },

  async apply(ctx) {
    if (!ctx.iosPaths.podfile) throw new Error('Podfile not found');
    const original = (await readOrNull(ctx.iosPaths.podfile)) ?? '';
    const target = findTargetBlock(original, ctx.iosPaths.schemeName);
    if (!target) {
      throw new Error(`No 'target ${JSON.stringify(ctx.iosPaths.schemeName)} do' block in Podfile`);
    }
    // Insert at the start of the line containing the closing `end` so our
    // pod block sits on its own lines with consistent indentation. Same
    // column-zero anchoring as the Android steps.
    const insertAt = lineStartBefore(original, target.bodyEnd);
    const updated = original.slice(0, insertAt) + podLine() + original.slice(insertAt);
    await writeFile(ctx.iosPaths.podfile, updated);
  },

  async rollback(ctx) {
    if (!ctx.iosPaths.podfile) return;
    const content = await readOrNull(ctx.iosPaths.podfile);
    if (content === null) return;
    const stripped = stripMarkerBlock(content, PODFILE_MARKER_BEGIN, PODFILE_MARKER_END);
    if (stripped !== content) {
      await writeFile(ctx.iosPaths.podfile, stripped);
    }
  },
};
