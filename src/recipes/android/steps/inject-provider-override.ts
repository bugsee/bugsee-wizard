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
  PROVIDER_OVERRIDE_MARKER_BEGIN,
  PROVIDER_OVERRIDE_MARKER_END,
} from '../types.js';

// Paired form only — a self-closing `<application … />` is detected
// separately in precheck so we can block with a clear message rather
// than splice the override XML *outside* the application element.
const TOOLS_NS_ATTR_RE = /xmlns:tools\s*=\s*"http:\/\/schemas\.android\.com\/tools"/;

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Pre-apply manifest content per run context, so rollback restores the original exactly. */
const originals = new WeakMap<object, Map<string, string>>();

function unescapeXmlAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

/** The `android:process` of the provider an existing marker block declares, or null. */
function processIn(block: string): string | null {
  for (const m of block.matchAll(/<!--[\s\S]*?-->|<provider\b[^>]*>/g)) {
    if (!m[0].startsWith('<provider')) continue;
    const v = /android:process\s*=\s*"([^"]*)"/.exec(m[0])?.[1];
    if (v !== undefined) return unescapeXmlAttr(v);
  }
  return null;
}

/** The lines inside an existing marker block that are the user's: everything but the markers and the wizard's own provider element (with any children). */
function userLines(existing: string): string[] {
  const own =
    /[ \t]*<provider\b(?=[^>]*BugseeInitProvider)[^>]*?(?:\/>|>[\s\S]*?<\/provider\s*>)[ \t]*\r?\n?/g;
  return existing
    .split(/\r?\n/)
    .join('\n')
    .replace(own, '')
    .split('\n')
    .filter(
      (l) =>
        l.trim() !== '' &&
        !l.includes(PROVIDER_OVERRIDE_MARKER_BEGIN) &&
        !l.includes(PROVIDER_OVERRIDE_MARKER_END),
    );
}

const inFileEndings = (existing: string, text: string): string =>
  /\r\n/.test(existing) ? text.replace(/\n/g, '\r\n') : text;

/** The generated block plus any lines the user added inside the markers, in the file's line endings. */
function mergedProvider(existing: string, generated: string): string {
  const lines = generated.split('\n').filter((l) => l !== '');
  const end = lines.pop() ?? '';
  return inFileEndings(existing, `${[...lines, ...userLines(existing), end].join('\n')}\n`);
}

/** The manifest without the wizard's provider; the user's own lines inside the markers stay. */
function removedProvider(source: string): string {
  const block = findMarkerBlock(
    source,
    PROVIDER_OVERRIDE_MARKER_BEGIN,
    PROVIDER_OVERRIDE_MARKER_END,
  );
  if (block === null) return source;
  const kept = userLines(block);
  return replaceMarkerBlock(
    source,
    PROVIDER_OVERRIDE_MARKER_BEGIN,
    PROVIDER_OVERRIDE_MARKER_END,
    kept.length === 0 ? '' : inFileEndings(block, `${kept.join('\n')}\n`),
  );
}

function providerOverrideXml(processName: string): string {
  const escaped = escapeXmlAttr(processName);
  return `    ${PROVIDER_OVERRIDE_MARKER_BEGIN}
    <provider
        android:name="com.bugsee.library.BugseeInitProvider"
        android:authorities="\${applicationId}.bugseeinitprovider"
        android:exported="false"
        android:process="${escaped}"
        tools:replace="android:process" />
    ${PROVIDER_OVERRIDE_MARKER_END}
`;
}

/**
 * When the user's `<application>` runs in a custom process, the SDK's
 * auto-init `BugseeInitProvider` (declared in the SDK's manifest without
 * an explicit `android:process`) won't fire there. This step re-declares
 * the provider with `android:process` matching the user's app process and
 * `tools:replace="android:process"` so manifest-merger only overrides
 * that single attribute (preserving the SDK's `initOrder`,
 * `directBootAware`, etc.).
 *
 * Only runs when `providerProcessOverride` is set in the recipe options
 * — gated by the user's opt-in answer in the questionnaire. Idempotent
 * via marker comments; rollback strips the inserted block.
 *
 * Also ensures `xmlns:tools="http://schemas.android.com/tools"` is on
 * the `<manifest>` root, since the `tools:replace` attribute requires it.
 */
export const injectProviderOverrideStep: Step<AndroidContext> = {
  id: 'android.inject-provider-override',
  title: 'Re-declare BugseeInitProvider with custom process',

  async precheck(ctx): Promise<StepStatus> {
    if (!ctx.androidOptions.providerProcessOverride) {
      // An override from an earlier run that is no longer wanted must go.
      const old = await readOrNull(ctx.androidPaths.appManifest);
      const block =
        old === null || old === undefined
          ? null
          : findMarkerBlock(old, PROVIDER_OVERRIDE_MARKER_BEGIN, PROVIDER_OVERRIDE_MARKER_END);
      return block !== null
        ? { kind: 'pending' }
        : { kind: 'satisfied', note: 'no application process override needed' };
    }
    const content = await readOrNull(ctx.androidPaths.appManifest);
    if (content === null) {
      return { kind: 'blocked', reason: `${ctx.androidPaths.appManifest} not found` };
    }
    if (content.includes(PROVIDER_OVERRIDE_MARKER_BEGIN)) {
      const existing = findMarkerBlock(
        content,
        PROVIDER_OVERRIDE_MARKER_BEGIN,
        PROVIDER_OVERRIDE_MARKER_END,
      );
      if (existing === null) {
        return {
          kind: 'blocked',
          reason: `${ctx.androidPaths.appManifest} has a "${PROVIDER_OVERRIDE_MARKER_BEGIN}" marker without its end marker; fix or remove it and re-run`,
        };
      }
      // A re-run with a different process name must update the block, not keep the old one.
      return processIn(existing) === ctx.androidOptions.providerProcessOverride
        ? { kind: 'satisfied' }
        : { kind: 'pending' };
    }
    if (!findOpenTag(content, 'manifest')) {
      return { kind: 'blocked', reason: 'No <manifest> root in AndroidManifest.xml' };
    }
    // A self-closing `<application/>` has no body to splice into. It's
    // rare but legal (Android Studio "No Activity" template emits this).
    // Block with a clear reason rather than silently inserting the
    // <provider> outside the application element, which would produce
    // an invalid manifest.
    const app = findOpenTag(content, 'application');
    if (app?.selfClosing) {
      return {
        kind: 'blocked',
        reason:
          '<application/> is self-closing — convert to <application>…</application> and re-run, or add the override snippet manually.',
      };
    }
    if (!app) {
      return { kind: 'blocked', reason: 'No <application> element in AndroidManifest.xml' };
    }
    return { kind: 'pending' };
  },

  async apply(ctx) {
    const processName = ctx.androidOptions.providerProcessOverride;
    const original = (await readOrNull(ctx.androidPaths.appManifest)) ?? '';
    if (!processName) {
      // No override wanted any more: strip the block this wizard added earlier.
      rememberOriginal(originals, ctx, ctx.androidPaths.appManifest, original);
      await writeFile(ctx.androidPaths.appManifest, removedProvider(original));
      return;
    }

    let updated = original;

    if (original.includes(PROVIDER_OVERRIDE_MARKER_BEGIN)) {
      if (
        !findMarkerBlock(original, PROVIDER_OVERRIDE_MARKER_BEGIN, PROVIDER_OVERRIDE_MARKER_END)
      ) {
        throw new Error(
          `${PROVIDER_OVERRIDE_MARKER_BEGIN} marker without its end marker in ${ctx.androidPaths.appManifest}`,
        );
      }
      rememberOriginal(originals, ctx, ctx.androidPaths.appManifest, original);
      await writeFile(
        ctx.androidPaths.appManifest,
        replaceMarkerBlock(
          original,
          PROVIDER_OVERRIDE_MARKER_BEGIN,
          PROVIDER_OVERRIDE_MARKER_END,
          mergedProvider(
            findMarkerBlock(
              original,
              PROVIDER_OVERRIDE_MARKER_BEGIN,
              PROVIDER_OVERRIDE_MARKER_END,
            ) ?? '',
            providerOverrideXml(processName),
          ),
        ),
      );
      return;
    }

    // Step 1: ensure xmlns:tools is on <manifest>.
    // Judge only the <manifest> open tag: an `xmlns:tools` declared on some
    // nested element (or in a comment) does not make `tools:` resolve on the
    // `<provider>` we add, so the root still needs its own.
    const manifestMatch = findOpenTag(updated, 'manifest');
    if (!manifestMatch) throw new Error('No <manifest> root in AndroidManifest.xml');
    const attrs = manifestMatch.attrs;
    if (!TOOLS_NS_ATTR_RE.test(attrs)) {
      // Insert the namespace as the last attribute on the <manifest> tag.
      const newOpenTag = `<manifest${attrs}\n    xmlns:tools="http://schemas.android.com/tools">`;
      updated =
        updated.slice(0, manifestMatch.index) + newOpenTag + updated.slice(manifestMatch.end);
    }

    // Step 2: insert <provider> override at the start of the line right
    // after the <application> open tag. Precheck has already guarded
    // against a self-closing `<application/>`.
    const appMatch = findOpenTag(updated, 'application');
    if (!appMatch || appMatch.selfClosing)
      throw new Error('No <application> open tag in AndroidManifest.xml');
    let insertAt = appMatch.end;
    if (updated[insertAt] === '\n') insertAt++;
    updated =
      updated.slice(0, insertAt) + providerOverrideXml(processName) + updated.slice(insertAt);

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
      PROVIDER_OVERRIDE_MARKER_BEGIN,
      PROVIDER_OVERRIDE_MARKER_END,
    );
    // Note: the xmlns:tools namespace addition is intentionally NOT rolled
    // back. Adding it is harmless; removing it could break unrelated `tools:`
    // attributes the user (or other tooling) added afterwards.
    if (stripped !== content) {
      await writeFile(ctx.androidPaths.appManifest, stripped);
    }
  },
};
