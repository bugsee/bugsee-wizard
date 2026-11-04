import { writeFile } from 'node:fs/promises';

import type { Step, StepStatus } from '../../../core/step.js';
import { readOrNull, stripMarkerBlock } from '../io.js';
import {
  type AndroidContext,
  PROVIDER_OVERRIDE_MARKER_BEGIN,
  PROVIDER_OVERRIDE_MARKER_END,
} from '../types.js';

const MANIFEST_OPEN_TAG_RE = /<manifest\b([^>]*)>/;
// Paired form only — a self-closing `<application … />` is detected
// separately in precheck so we can block with a clear message rather
// than splice the override XML *outside* the application element.
const APPLICATION_PAIRED_OPEN_RE = /<application\b[^>]*[^/]>/;
const APPLICATION_SELF_CLOSING_RE = /<application\b[^>]*\/>/;
const TOOLS_NS_ATTR_RE = /xmlns:tools\s*=\s*"http:\/\/schemas\.android\.com\/tools"/;

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
      return { kind: 'satisfied', note: 'no application process override needed' };
    }
    const content = await readOrNull(ctx.androidPaths.appManifest);
    if (content === null) {
      return { kind: 'blocked', reason: `${ctx.androidPaths.appManifest} not found` };
    }
    if (content.includes(PROVIDER_OVERRIDE_MARKER_BEGIN)) {
      return { kind: 'satisfied' };
    }
    if (!MANIFEST_OPEN_TAG_RE.test(content)) {
      return { kind: 'blocked', reason: 'No <manifest> root in AndroidManifest.xml' };
    }
    // A self-closing `<application/>` has no body to splice into. It's
    // rare but legal (Android Studio "No Activity" template emits this).
    // Block with a clear reason rather than silently inserting the
    // <provider> outside the application element, which would produce
    // an invalid manifest.
    if (APPLICATION_SELF_CLOSING_RE.test(content) && !APPLICATION_PAIRED_OPEN_RE.test(content)) {
      return {
        kind: 'blocked',
        reason:
          '<application/> is self-closing — convert to <application>…</application> and re-run, or add the override snippet manually.',
      };
    }
    if (!APPLICATION_PAIRED_OPEN_RE.test(content)) {
      return { kind: 'blocked', reason: 'No <application> element in AndroidManifest.xml' };
    }
    return { kind: 'pending' };
  },

  async apply(ctx) {
    const processName = ctx.androidOptions.providerProcessOverride;
    if (!processName) throw new Error('providerProcessOverride is null in apply()');

    const original = (await readOrNull(ctx.androidPaths.appManifest)) ?? '';

    let updated = original;

    // Step 1: ensure xmlns:tools is on <manifest>.
    if (!TOOLS_NS_ATTR_RE.test(updated)) {
      const manifestMatch = MANIFEST_OPEN_TAG_RE.exec(updated);
      if (!manifestMatch) throw new Error('No <manifest> root in AndroidManifest.xml');
      const attrs = manifestMatch[1] ?? '';
      // Insert the namespace as the last attribute on the <manifest> tag.
      const newOpenTag = `<manifest${attrs}\n    xmlns:tools="http://schemas.android.com/tools">`;
      updated =
        updated.slice(0, manifestMatch.index) +
        newOpenTag +
        updated.slice(manifestMatch.index + manifestMatch[0].length);
    }

    // Step 2: insert <provider> override at the start of the line right
    // after the <application> open tag. Precheck has already guarded
    // against a self-closing `<application/>`.
    const appMatch = APPLICATION_PAIRED_OPEN_RE.exec(updated);
    if (!appMatch) throw new Error('No <application> open tag in AndroidManifest.xml');
    let insertAt = appMatch.index + appMatch[0].length;
    if (updated[insertAt] === '\n') insertAt++;
    updated =
      updated.slice(0, insertAt) + providerOverrideXml(processName) + updated.slice(insertAt);

    await writeFile(ctx.androidPaths.appManifest, updated);
  },

  async rollback(ctx) {
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
