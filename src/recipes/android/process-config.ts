import { findOpenTag, findOpenTags } from './io.js';

/**
 * Result of scanning AndroidManifest.xml for `android:process` attributes.
 *
 * `applicationProcess` is the value on the `<application>` tag, if any —
 * a non-null value here means the *whole app* runs in a custom process,
 * which prevents Bugsee's auto-init `ContentProvider` from firing
 * automatically. The wizard offers to write a `<provider>` re-declaration
 * with the matching process for this case.
 *
 * `componentProcesses` collects distinct values from `<activity>`,
 * `<service>`, `<provider>`, and `<receiver>` tags. These are sub-process
 * declarations for individual components; auto-init in those processes
 * is intentional opt-out territory and the wizard only warns.
 */
export interface AndroidProcessConfig {
  readonly applicationProcess: string | null;
  readonly componentProcesses: readonly string[];
}

// `(?![\w-])` after the tag name disallows `<activity-alias …>` matching
// the `<activity …>` alternative — `\b` would have matched at the
// `y`-to-`-` boundary, creating false positives on a tag that has its
// own role and may legitimately declare its own process.

// Match `android:process` with either single or double quotes. Both are
// legal XML; lint and Android Studio default to double, but third-party
// generators (and hand-edited manifests) sometimes emit single.
// The lookbehind requires whitespace before the attribute so a longer
// namespaced name (`tools:android:process`) is not mistaken for it.
const PROCESS_ATTR_RE = /(?<=\s)android:process\s*=\s*(?:"([^"]+)"|'([^']+)')/;

const COMPONENT_TAGS = ['activity', 'service', 'provider', 'receiver'] as const;
const XML_COMMENT_RE = /<!--[\s\S]*?-->/g;

/**
 * Trim whitespace and treat an empty / whitespace-only value as absent.
 * Manifest authors do clear an attribute value during editing, and we
 * don't want a literal empty `android:process=""` (or `=" "`) to cascade
 * into the recipe's picker and the override step's emitted XML.
 */
function nonEmptyOrNull(raw: string | undefined): string | null {
  const trimmed = raw?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function pickProcess(attrs: string): string | null {
  const m = PROCESS_ATTR_RE.exec(attrs);
  if (!m) return null;
  return nonEmptyOrNull(m[1] ?? m[2]);
}

export function detectProcessConfig(manifestContent: string): AndroidProcessConfig {
  // Strip XML comments first — manifest authors leave example/disabled
  // declarations in comments, which would otherwise produce false
  // positives in the component-process scan below.
  const cleaned = manifestContent.replace(XML_COMMENT_RE, '');

  // <application> is unique in a manifest; capture its attributes.
  const applicationProcess = (() => {
    const tag = findOpenTag(cleaned, 'application');
    return tag ? pickProcess(tag.attrs) : null;
  })();

  // Collect android:process from individual components, skipping the
  // <application> tag itself (already handled). Use a Set to dedupe —
  // multiple components can share the same custom process name.
  const componentProcesses = new Set<string>();
  for (const tag of findOpenTags(cleaned, COMPONENT_TAGS)) {
    const proc = pickProcess(tag.attrs);
    if (proc) componentProcesses.add(proc);
  }

  return {
    applicationProcess,
    componentProcesses: [...componentProcesses],
  };
}
