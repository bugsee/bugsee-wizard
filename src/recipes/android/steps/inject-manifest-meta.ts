import { writeFile } from 'node:fs/promises';

import type { Step, StepStatus } from '../../../core/step.js';
import {
  findMarkerBlock,
  findOpenTag,
  readOrNull,
  rememberOriginal,
  replaceMarkerBlock,
  stripMarkerBlock,
} from '../io.js';
import {
  type AndroidContext,
  MANIFEST_META_MARKER_BEGIN,
  MANIFEST_META_MARKER_END,
} from '../types.js';

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

/** Pre-apply manifest content per run context, so rollback restores the original exactly. */
const originals = new WeakMap<object, Map<string, string>>();

const APP_TOKEN_META = 'com.bugsee.app-token';
const AUTO_INIT_META = 'com.bugsee.auto-init';

const OWN_META_RE =
  /[ \t]*<meta-data\b[^>]*android:name\s*=\s*"com\.bugsee\.(?:app-token|auto-init)"[^>]*\/>[ \t]*\r?\n?/g;

/** The replacement block: the generated one plus any lines the user added inside the markers, in the file's line endings. */
function mergedMeta(existing: string, generated: string): string {
  const kept = existing
    .split(/\r?\n/)
    .join('\n')
    .replace(OWN_META_RE, '')
    .split('\n')
    .filter(
      (l) =>
        l.trim() !== '' &&
        !l.includes(MANIFEST_META_MARKER_BEGIN) &&
        !l.includes(MANIFEST_META_MARKER_END),
    );
  const lines = generated.split('\n').filter((l) => l !== '');
  const end = lines.pop() ?? '';
  const text = `${[...lines, ...kept, end].join('\n')}\n`;
  return /\r\n/.test(existing) ? text.replace(/\n/g, '\r\n') : text;
}

function metaFor(ctx: AndroidContext): string {
  return ctx.androidOptions.initMode === 'automatic' ? metaForAutomatic() : metaForManual();
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
      const existing = findMarkerBlock(
        content,
        MANIFEST_META_MARKER_BEGIN,
        MANIFEST_META_MARKER_END,
      );
      if (existing === null) {
        return {
          kind: 'blocked',
          reason: `${ctx.androidPaths.appManifest} has a "${MANIFEST_META_MARKER_BEGIN}" marker without its end marker; fix or remove it and re-run`,
        };
      }
      // Compare the answer (which meta-data the block carries), not the bytes:
      // re-indenting or CRLF must not make an identical re-run rewrite it.
      const [want, other] =
        ctx.androidOptions.initMode === 'automatic'
          ? [APP_TOKEN_META, AUTO_INIT_META]
          : [AUTO_INIT_META, APP_TOKEN_META];
      // Active elements only: a comment that merely names a meta-data does not count.
      const active = existing.replace(/<!--[\s\S]*?-->/g, '');
      const has = (name: string): boolean =>
        new RegExp(`<meta-data\\b[^>]*android:name\\s*=\\s*"${name.replace(/\./g, '\\.')}"`).test(
          active,
        );
      return has(want) && !has(other) ? { kind: 'satisfied' } : { kind: 'pending' };
    }
    const open = findOpenTag(content, 'application');
    if (!open) {
      return {
        kind: 'blocked',
        reason: 'No <application> element found in AndroidManifest.xml',
      };
    }
    if (open.selfClosing) {
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
    if (original.includes(MANIFEST_META_MARKER_BEGIN)) {
      if (!findMarkerBlock(original, MANIFEST_META_MARKER_BEGIN, MANIFEST_META_MARKER_END)) {
        throw new Error(
          `${MANIFEST_META_MARKER_BEGIN} marker without its end marker in ${ctx.androidPaths.appManifest}`,
        );
      }
      rememberOriginal(originals, ctx, ctx.androidPaths.appManifest, original);
      await writeFile(
        ctx.androidPaths.appManifest,
        replaceMarkerBlock(
          original,
          MANIFEST_META_MARKER_BEGIN,
          MANIFEST_META_MARKER_END,
          mergedMeta(
            findMarkerBlock(original, MANIFEST_META_MARKER_BEGIN, MANIFEST_META_MARKER_END) ?? '',
            metaFor(ctx),
          ),
        ),
      );
      return;
    }
    const match = findOpenTag(original, 'application');
    if (!match) {
      throw new Error('No <application> element found in AndroidManifest.xml');
    }
    if (match.selfClosing) {
      throw new Error('<application/> is self-closing; cannot insert <meta-data> inside it');
    }
    // Insert at the start of the line *after* the <application ...> tag so
    // the meta-data block sits at column 0 with its own indentation.
    let insertAt = match.end;
    if (original[insertAt] === '\n') insertAt++;
    const meta = metaFor(ctx);
    const updated = original.slice(0, insertAt) + meta + original.slice(insertAt);
    await writeFile(ctx.androidPaths.appManifest, updated);
  },

  async rollback(ctx) {
    const saved = originals.get(ctx)?.get(ctx.androidPaths.appManifest);
    if (saved !== undefined) {
      originals.get(ctx)?.delete(ctx.androidPaths.appManifest);
      await writeFile(ctx.androidPaths.appManifest, saved);
      return;
    }
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
