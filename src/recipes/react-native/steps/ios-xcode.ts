import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ApplyResult, Step, StepStatus } from '../../../core/step.js';
import { readOrNull } from '../../android/io.js';
import { discoverIosPaths } from '../../ios/paths.js';
import type { RnContext } from '../types.js';

/**
 * iOS edits of a BARE React Native app that `@bugsee/react-native` prescribes for release
 * symbolication (README "iOS: bundle phase"; the Expo config plugin does the same on prebuilt
 * projects, `plugin/src/{bundle-phase,scheme,dsym-script}.ts`):
 *   1. bundle phase runs `bugsee-xcode.sh` instead of `react-native-xcode.sh`,
 *   2. the scheme's Archive action uploads dSYMs,
 *   3. the token goes to `ios/.xcode.env.local` (git-ignored).
 * Everything is edited as TEXT (never re-serialised) so rollback restores the exact bytes.
 */

// ───────────────────────────── shared helpers ─────────────────────────────

const NO_TOKEN_NOTE = 'No iOS app token: nothing to wire';
const NO_IOS_NOTE = 'No ios/ directory';

function skipNote(ctx: RnContext): string | null {
  if (ctx.rnPaths.iosPath === null) return NO_IOS_NOTE;
  if (!ctx.tokens.ios) return NO_TOKEN_NOTE;
  return null;
}

async function iosProject(ctx: RnContext): Promise<{ pbxproj: string; scheme: string } | null> {
  if (ctx.rnPaths.iosPath === null) return null;
  try {
    const paths = await discoverIosPaths(ctx.rnPaths.iosPath);
    return { pbxproj: path.join(paths.xcodeProject, 'project.pbxproj'), scheme: paths.scheme };
  } catch {
    return null;
  }
}

const NO_PROJECT_NOTE = 'No .xcodeproj / shared scheme found under ios/';

// ───────────────────────────── 1. bundle phase ─────────────────────────────

const BUNDLE_PHASE_NAME = 'Bundle React Native code and images';
const BUNDLE_MARKER = '# bugsee:wizard:rn-bundle:';
const BUGSEE_XCODE_VALUE =
  '${SRCROOT}/../node_modules/@bugsee/react-native/scripts/bugsee-xcode.sh';

/** The README's script, shown when the phase cannot be edited automatically. */
export const BUNDLE_PHASE_SNIPPET = [
  'set -e',
  '',
  'WITH_ENVIRONMENT="$REACT_NATIVE_PATH/scripts/xcode/with-environment.sh"',
  `REACT_NATIVE_XCODE="${BUGSEE_XCODE_VALUE}"`,
  '',
  '/bin/sh -c "\\"$WITH_ENVIRONMENT\\" \\"$REACT_NATIVE_XCODE\\""',
].join('\n');

interface PhaseScript {
  /** Offsets of the raw (still pbx-escaped) shellScript string body inside the file. */
  readonly start: number;
  readonly end: number;
  readonly raw: string;
}

/** Raw shellScript bodies of every "Bundle React Native code and images" phase. */
function findBundlePhases(pbx: string): PhaseScript[] {
  const section =
    /\/\* Begin PBXShellScriptBuildPhase section \*\/([\s\S]*?)\/\* End PBXShellScriptBuildPhase section \*\//.exec(
      pbx,
    );
  if (!section) return [];
  const sectionStart = section.index + section[0].indexOf(section[1] ?? '');
  const out: PhaseScript[] = [];
  const blockRe = /^\t\t\w+ (?:\/\*[^*]*\*\/ )?= \{\n[\s\S]*?^\t\t\};$/gm;
  const body = section[1] ?? '';
  for (const block of body.matchAll(blockRe)) {
    const text = block[0];
    const nameRe = new RegExp(`^\\t\\t\\tname = "?${BUNDLE_PHASE_NAME}"?;$`, 'm');
    if (!nameRe.test(text)) continue;
    const script = /^\t\t\tshellScript = "((?:[^"\\]|\\[\s\S])*)";$/m.exec(text);
    if (!script) {
      out.push({ start: -1, end: -1, raw: '' });
      continue;
    }
    const start = sectionStart + (block.index ?? 0) + script.index + script[0].indexOf('"') + 1;
    out.push({ start, end: start + (script[1] ?? '').length, raw: script[1] ?? '' });
  }
  return out;
}

const SEP = '\\n'; // a literal backslash + n inside the raw pbx string

type Plan = { kind: 'done' } | { kind: 'rewrite'; raw: string } | { kind: 'unrecognised' };

function planBundleRewrite(raw: string): Plan {
  if (raw.includes('bugsee-xcode.sh')) return { kind: 'done' };
  // bugsee-xcode.sh needs REACT_NATIVE_PATH (it cd's into it), which only the templates that
  // reference it in the phase get from CocoaPods/SPM.
  if (!raw.includes('with-environment.sh') || !raw.includes('REACT_NATIVE_PATH')) {
    return { kind: 'unrecognised' };
  }
  const segments = raw.split(SEP);
  const assignRe = /^(\s*)(\w+)=\\"[^"\\]*react-native-xcode\.sh\\"$/;
  const assignAt = segments.findIndex((s) => assignRe.test(s));
  if (assignAt < 0) return { kind: 'unrecognised' };
  const assign = assignRe.exec(segments[assignAt] ?? '');
  const indent = assign?.[1] ?? '';
  const variable = assign?.[2] ?? '';
  const original = segments[assignAt] ?? '';
  segments[assignAt] = withMarker(`${indent}${variable}=\\"${BUGSEE_XCODE_VALUE}\\"`, original);
  // `/bin/sh -c "$WITH_ENVIRONMENT $VAR"` breaks on a project path with spaces: use README's form.
  const invokeRe = /^(\s*)\/bin\/sh -c \\"\$(\w+) \$(\w+)\\"$/;
  const invokeAt = segments.findIndex((s) => invokeRe.test(s) && s.includes(`$${variable}`));
  if (invokeAt >= 0) {
    const inv = invokeRe.exec(segments[invokeAt] ?? '');
    const original2 = segments[invokeAt] ?? '';
    segments[invokeAt] = withMarker(
      `${inv?.[1] ?? ''}/bin/sh -c \\"\\\\\\"$${inv?.[2]}\\\\\\" \\\\\\"$${inv?.[3]}\\\\\\"\\"`,
      original2,
    );
  }
  return { kind: 'rewrite', raw: segments.join(SEP) };
}

function withMarker(next: string, original: string): string {
  return `${next} ${BUNDLE_MARKER}${Buffer.from(original, 'utf8').toString('base64')}`;
}

function restoreBundleRaw(raw: string): string {
  const markerRe = /^.* # bugsee:wizard:rn-bundle:([A-Za-z0-9+/=]+)$/;
  return raw
    .split(SEP)
    .map((s) => {
      const m = markerRe.exec(s);
      return m ? Buffer.from(m[1] ?? '', 'base64').toString('utf8') : s;
    })
    .join(SEP);
}

function replaceRaw(pbx: string, phase: PhaseScript, raw: string): string {
  return pbx.slice(0, phase.start) + raw + pbx.slice(phase.end);
}

const bundlePhaseStep: Step<RnContext> = {
  id: 'rn.ios.bundle-phase',
  title: 'Run bugsee-xcode.sh from the "Bundle React Native code and images" build phase',

  async precheck(ctx): Promise<StepStatus> {
    const skip = skipNote(ctx);
    if (skip) return { kind: 'satisfied', note: skip };
    const project = await iosProject(ctx);
    if (!project) return { kind: 'satisfied', note: NO_PROJECT_NOTE };
    const pbx = await readOrNull(project.pbxproj);
    if (pbx === null) return { kind: 'satisfied', note: NO_PROJECT_NOTE };
    const phases = findBundlePhases(pbx);
    if (
      phases.length > 0 &&
      phases.every((p) => p.start >= 0 && planBundleRewrite(p.raw).kind === 'done')
    ) {
      return { kind: 'satisfied' };
    }
    return { kind: 'pending' };
  },

  async apply(ctx): Promise<ApplyResult | undefined> {
    const project = await iosProject(ctx);
    const pbx = project ? await readOrNull(project.pbxproj) : null;
    if (!project || pbx === null) throw new Error(NO_PROJECT_NOTE);
    const manual = (reason: string): ApplyResult => ({
      manual: {
        file: project.pbxproj,
        title: `In Xcode, make the "${BUNDLE_PHASE_NAME}" build phase run bugsee-xcode.sh (${reason})`,
        code: BUNDLE_PHASE_SNIPPET,
      },
    });
    const phases = findBundlePhases(pbx);
    if (phases.length === 0) return manual('phase not found');
    if (phases.some((p) => p.start < 0)) return manual('phase has an unexpected shape');
    const plans = phases.map((p) => planBundleRewrite(p.raw));
    if (plans.some((p) => p.kind === 'unrecognised')) {
      return manual('phase has an unexpected shape');
    }
    let next = pbx;
    // Back to front so earlier offsets stay valid.
    for (let i = phases.length - 1; i >= 0; i--) {
      const plan = plans[i];
      const phase = phases[i];
      if (plan?.kind === 'rewrite' && phase) next = replaceRaw(next, phase, plan.raw);
    }
    if (next !== pbx) await writeFile(project.pbxproj, next);
    return undefined;
  },

  async rollback(ctx): Promise<void> {
    const project = await iosProject(ctx);
    const pbx = project ? await readOrNull(project.pbxproj) : null;
    if (!project || pbx === null) return;
    let next = pbx;
    const phases = findBundlePhases(pbx);
    for (let i = phases.length - 1; i >= 0; i--) {
      const phase = phases[i];
      if (phase && phase.start >= 0) next = replaceRaw(next, phase, restoreBundleRaw(phase.raw));
    }
    if (next !== pbx) await writeFile(project.pbxproj, next);
  },
};

// ───────────────────────────── 2. scheme post-action ─────────────────────────────

export const DSYM_ACTION_TITLE = 'Bugsee: upload dSYMs (React Native)';
/** Present in every dSYM post-action (ours, the Expo plugin's, the example's). */
const DSYM_CLI_MARKER = 'xcode post-action';

function encodeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, '&#10;');
}

// The script below is `plugin/src/dsym-script.ts` of @bugsee/react-native with the baked token and
// endpoint parameters dropped: the token is read from the environment / .xcode.env(.local), never
// written into the (committed) scheme.

const locateCli = [
  "const path = require('path');",
  'const appRoot = process.argv[1];',
  "const wrapperPkg = require.resolve('@bugsee/react-native/package.json', { paths: [appRoot] });",
  'const wrapperDir = path.dirname(wrapperPkg);',
  "const cliPkg = require.resolve('@bugsee/cli/package.json', { paths: [wrapperDir] });",
  'const cliDir = path.dirname(cliPkg);',
].join(' ');

function nativePkgSource(pkg: string): string {
  return `try { ${locateCli} require.resolve('${pkg}', { paths: [cliDir] }); } catch (e) { '' }`;
}

const CLI_JS_SOURCE = `try { const fs = require('fs'); ${locateCli} const rel = JSON.parse(fs.readFileSync(cliPkg, 'utf8')).bin['bugsee-cli']; rel ? path.join(cliDir, rel) : ''; } catch (e) { '' }`;

function nodePrint(source: string): string {
  return `"$("$NODE_BINARY" --print "${source}" "$APP_ROOT")"`;
}

const TOKEN_GUARD: readonly string[] = [
  "TOKEN_CHECK=$(printf '%s' \"$TOKEN\" | /usr/bin/tr -d ' \\t\\r\\n-')",
  'if [ -z "$TOKEN_CHECK" ]; then',
  '  echo "warning: bugsee: dSYM upload skipped: no app token is configured"',
  '  exit 0',
  'fi',
  'case "$TOKEN_CHECK" in',
  '  000000000000[0123456789abcdefABCDEF]000[0123456789abcdefABCDEF]000000000000000)',
  '    echo "warning: bugsee: dSYM upload skipped: the app token is the placeholder"',
  '    exit 0',
  '    ;;',
  'esac',
];

const ENV_FILE_TOKEN: readonly string[] = [
  'if [ -z "$TOKEN" ]; then',
  '  for ENV_FILE in "${PROJECT_DIR}/.xcode.env" "${PROJECT_DIR}/.xcode.env.local"; do',
  '    if [ -f "$ENV_FILE" ]; then',
  '      ENV_TOKEN=$( ( . "$ENV_FILE" >/dev/null 2>&1; if [ -n "$BUGSEE_APP_TOKEN" ]; then printf \'%s\' "$BUGSEE_APP_TOKEN"; else printf \'%s\' "$BUGSEE_TOKEN_IOS"; fi ) 2>/dev/null || true )',
  '      if [ -n "$ENV_TOKEN" ]; then',
  '        TOKEN="$ENV_TOKEN"',
  '      fi',
  '    fi',
  '  done',
  'fi',
];

const CLI_OUTPUT_FILTER: readonly string[] = [
  '# An "error:" line reads as a build error to Xcode; a failed upload is a warning.',
  'run_cli() {',
  '  CLI_OUT=$("$@" 2>&1)',
  '  CLI_RC=$?',
  '  if [ -n "$CLI_OUT" ]; then',
  "    printf '%s\\n' \"$CLI_OUT\" | /usr/bin/sed -E 's/^(.*: )?([Ff]atal [Ee]rror|[Ee]rror): (.*)$/warning: bugsee: \\3/'",
  '  fi',
  '  return $CLI_RC',
  '}',
];

export function dsymPostActionScript(): string {
  return [
    'CREDS="${PROJECT_DIR}/../credentials.json"',
    'TOKEN="$BUGSEE_APP_TOKEN"',
    'if [ -z "$TOKEN" ]; then',
    '  TOKEN="$BUGSEE_TOKEN_IOS"',
    'fi',
    ...ENV_FILE_TOKEN,
    'if [ -z "$TOKEN" ] && [ -f "$CREDS" ]; then',
    '  TOKEN=$(/usr/bin/plutil -extract ios raw -o - "$CREDS" 2>/dev/null || true)',
    'fi',
    ...TOKEN_GUARD,
    ...CLI_OUTPUT_FILTER,
    'if [ -n "$TOKEN" ]; then',
    '  export BUGSEE_APP_TOKEN="$TOKEN"',
    'fi',
    'if [ -z "$BUGSEE_ENDPOINT" ] && [ -f "$CREDS" ]; then',
    '  ENDPOINT=$(/usr/bin/plutil -extract endpoint raw -o - "$CREDS" 2>/dev/null || true)',
    '  if [ -n "$ENDPOINT" ]; then',
    '    export BUGSEE_ENDPOINT="$ENDPOINT"',
    '  fi',
    'fi',
    '',
    "# Archive's PATH has no node, and the npm shim's shebang searches PATH.",
    'if [ ! -x "$NODE_BINARY" ]; then',
    '  if [ -f "${PROJECT_DIR}/.xcode.env" ]; then',
    '    . "${PROJECT_DIR}/.xcode.env"',
    '  fi',
    '  if [ -f "${PROJECT_DIR}/.xcode.env.local" ]; then',
    '    . "${PROJECT_DIR}/.xcode.env.local"',
    '  fi',
    'fi',
    'if [ ! -x "$NODE_BINARY" ]; then',
    '  RN_FIND=""',
    '  if [ -n "$REACT_NATIVE_PATH" ] && [ -f "$REACT_NATIVE_PATH/scripts/find-node-for-xcode.sh" ]; then',
    '    RN_FIND="$REACT_NATIVE_PATH/scripts/find-node-for-xcode.sh"',
    '  elif [ -f "${PROJECT_DIR}/../node_modules/react-native/scripts/find-node-for-xcode.sh" ]; then',
    '    RN_FIND="${PROJECT_DIR}/../node_modules/react-native/scripts/find-node-for-xcode.sh"',
    '  fi',
    '  if [ -n "$RN_FIND" ]; then',
    '    NODE_BINARY=$(/bin/bash -c \'. "$1" >/dev/null 2>&1; command -v node\' _ "$RN_FIND" || true)',
    '  fi',
    'fi',
    'if [ -n "$NODE_BINARY" ] && [ -x "$NODE_BINARY" ]; then',
    '  PATH="$(dirname "$NODE_BINARY"):$PATH"',
    '  export PATH NODE_BINARY',
    '  APP_ROOT="${PROJECT_DIR}/.."',
    '  if [ "$(uname -m)" = "x86_64" ]; then',
    `    NATIVE_PKG=${nodePrint(nativePkgSource('@bugsee/cli-darwin-x64/package.json'))}`,
    '  else',
    `    NATIVE_PKG=${nodePrint(nativePkgSource('@bugsee/cli-darwin-arm64/package.json'))}`,
    '  fi',
    '  if [ -n "$NATIVE_PKG" ]; then',
    '    NATIVE_BIN="$(dirname "$NATIVE_PKG")/bin/bugsee-cli"',
    '    if [ -x "$NATIVE_BIN" ]; then',
    `      run_cli "$NATIVE_BIN" ${DSYM_CLI_MARKER}`,
    '      exit $?',
    '    fi',
    '  fi',
    `  CLI_JS=${nodePrint(CLI_JS_SOURCE)}`,
    '  if [ -n "$CLI_JS" ]; then',
    `    run_cli "$NODE_BINARY" "$CLI_JS" ${DSYM_CLI_MARKER}`,
    '    exit $?',
    '  fi',
    'fi',
    '',
    'echo "bugsee-cli: not found" >&2',
    'exit 1',
    '',
  ].join('\n');
}

const ARCHIVE_ACTION = /<ArchiveAction\b[\s\S]*?<\/ArchiveAction>/;
const SELF_CLOSING_ARCHIVE = /<ArchiveAction\b[^>]*\/>/;
const EXECUTION_ACTION = /[ \t]*<ExecutionAction\b[\s\S]*?<\/ExecutionAction>\n?/g;
const EMPTY_POST_ACTIONS = /\n[ \t]*<PostActions\b[^>]*>\s*<\/PostActions>/g;

function appBuildableReference(scheme: string): string | null {
  const refs = scheme.match(/<BuildableReference\b[\s\S]*?<\/BuildableReference>/g) ?? [];
  return refs.find((r) => /BuildableName\s*=\s*"[^"]+\.app"/.test(r)) ?? null;
}

/** Shifts the BuildAction's reference (other depth) so it nests under EnvironmentBuildable. */
function nestReference(reference: string, indent: string): string {
  const lines = reference.split('\n');
  const closing = lines[lines.length - 1] ?? '';
  const depth = closing.length - closing.trimStart().length;
  return lines.map((l, i) => indent + (i === 0 ? l : l.slice(depth))).join('\n');
}

function executionActionXml(reference: string): string {
  return [
    '         <ExecutionAction',
    '            ActionType = "Xcode.IDEStandardExecutionActionsCore.ExecutionActionType.ShellScriptAction">',
    '            <ActionContent',
    `               title = "${DSYM_ACTION_TITLE}"`,
    `               scriptText = "${encodeXmlAttr(dsymPostActionScript())}">`,
    '               <EnvironmentBuildable>',
    nestReference(reference, '                  '),
    '               </EnvironmentBuildable>',
    '            </ActionContent>',
    '         </ExecutionAction>',
  ].join('\n');
}

function isOurs(block: string): boolean {
  return block.includes(`title = "${DSYM_ACTION_TITLE}"`);
}

/** True when the Archive action already runs a Bugsee dSYM upload (ours, the plugin's, the example's). */
function hasDsymUpload(scheme: string): boolean {
  const archive = ARCHIVE_ACTION.exec(scheme);
  if (!archive) return false;
  return (archive[0].match(EXECUTION_ACTION) ?? []).some((b) => b.includes(DSYM_CLI_MARKER));
}

function insertPostAction(scheme: string, reference: string): string {
  const archive = ARCHIVE_ACTION.exec(scheme);
  if (!archive) throw new Error('ArchiveAction missing');
  const execution = executionActionXml(reference);
  const xml = archive[0];
  const open = /<PostActions\b[^>]*>/.exec(xml);
  const closeAt = xml.indexOf('</PostActions>');
  let updated: string;
  if (open && closeAt > open.index) {
    const lineStart = xml.lastIndexOf('\n', closeAt - 1) + 1;
    updated = `${xml.slice(0, lineStart)}${execution}\n${xml.slice(lineStart)}`;
  } else {
    const block = ['      <PostActions>', execution, '      </PostActions>'].join('\n');
    updated = xml.replace(/[ \t]*<\/ArchiveAction>/, `${block}\n   </ArchiveAction>`);
  }
  return scheme.slice(0, archive.index) + updated + scheme.slice(archive.index + xml.length);
}

function removePostAction(scheme: string): string {
  const archive = ARCHIVE_ACTION.exec(scheme);
  if (!archive) return scheme;
  let removed = false;
  let xml = archive[0].replace(EXECUTION_ACTION, (block) => {
    if (!isOurs(block)) return block;
    removed = true;
    return '';
  });
  if (!removed) return scheme;
  xml = xml.replace(EMPTY_POST_ACTIONS, '');
  return scheme.slice(0, archive.index) + xml + scheme.slice(archive.index + archive[0].length);
}

const schemePostActionStep: Step<RnContext> = {
  id: 'rn.ios.dsym-postaction',
  title: 'Add the Bugsee dSYM upload to the scheme Archive action',

  async precheck(ctx): Promise<StepStatus> {
    const skip = skipNote(ctx);
    if (skip) return { kind: 'satisfied', note: skip };
    const project = await iosProject(ctx);
    if (!project) return { kind: 'satisfied', note: NO_PROJECT_NOTE };
    const scheme = await readOrNull(project.scheme);
    if (scheme === null) return { kind: 'satisfied', note: NO_PROJECT_NOTE };
    return hasDsymUpload(scheme) ? { kind: 'satisfied' } : { kind: 'pending' };
  },

  async apply(ctx): Promise<ApplyResult | undefined> {
    const project = await iosProject(ctx);
    const scheme = project ? await readOrNull(project.scheme) : null;
    if (!project || scheme === null) throw new Error(NO_PROJECT_NOTE);
    const reference = appBuildableReference(scheme);
    if (!ARCHIVE_ACTION.test(scheme) || SELF_CLOSING_ARCHIVE.test(scheme) || reference === null) {
      return {
        manual: {
          file: project.scheme,
          title:
            'In Xcode, add a post-action to the scheme Archive action that runs the Bugsee dSYM upload (bugsee-cli xcode post-action); see the @bugsee/react-native README, "iOS: bundle phase"',
          code: dsymPostActionScript(),
        },
      };
    }
    await writeFile(project.scheme, insertPostAction(scheme, reference));
    return undefined;
  },

  async rollback(ctx): Promise<void> {
    const project = await iosProject(ctx);
    const scheme = project ? await readOrNull(project.scheme) : null;
    if (!project || scheme === null) return;
    const stripped = removePostAction(scheme);
    if (stripped !== scheme) await writeFile(project.scheme, stripped);
  },
};

// ───────────────────────────── 3. token + gitignore ─────────────────────────────

const TOKEN_BEGIN = '# bugsee:wizard:rn-token:begin';
const TOKEN_END = '# bugsee:wizard:rn-token:end';
const IGNORE_BEGIN = '# bugsee:wizard:rn-ignore:begin';
const IGNORE_END = '# bugsee:wizard:rn-ignore:end';
/** Suffix on the begin marker when we had to add a newline to an unterminated file. */
const NONL = ' nonl';

function blockRe(begin: string, end: string): RegExp {
  return new RegExp(`${begin}( nonl)?\\n[\\s\\S]*?${end}\\n?`);
}

/** Appends a marker-wrapped block, keeping every existing byte (`existing` null = new file). */
function addBlock(
  existing: string | null,
  begin: string,
  end: string,
  lines: readonly string[],
): string {
  const base = existing ?? '';
  const needsNl = base.length > 0 && !base.endsWith('\n');
  return `${base}${needsNl ? '\n' : ''}${begin}${needsNl ? NONL : ''}\n${lines.join('\n')}\n${end}\n`;
}

/** Inverse of addBlock. */
function stripBlock(content: string, begin: string, end: string): string {
  const re = blockRe(begin, end);
  const m = re.exec(content);
  if (!m) return content;
  const before = content.slice(0, m.index);
  const after = content.slice(m.index + m[0].length);
  // `nonl`: the newline just before the block was ours.
  const trimmed = m[1] && before.endsWith('\n') ? before.slice(0, -1) : before;
  return trimmed + after;
}

async function rollbackBlock(file: string, begin: string, end: string): Promise<void> {
  const content = await readOrNull(file);
  if (content === null) return;
  const stripped = stripBlock(content, begin, end);
  if (stripped === content) return;
  if (stripped === '') await rm(file, { force: true });
  else await writeFile(file, stripped);
}

function shellValue(value: string): string {
  return /^[\w.-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

const IGNORED_LINES = new Set([
  '.xcode.env.local',
  '/.xcode.env.local',
  '**/.xcode.env.local',
  'ios/.xcode.env.local',
  '/ios/.xcode.env.local',
]);

function ignoresEnvLocal(gitignore: string | null): boolean {
  if (gitignore === null) return false;
  return gitignore.split(/\r?\n/).some((l) => IGNORED_LINES.has(l.trim()));
}

const gitignoreStep: Step<RnContext> = {
  id: 'rn.ios.xcode-env-gitignore',
  title: 'Git-ignore ios/.xcode.env.local (it holds the app token)',

  async precheck(ctx): Promise<StepStatus> {
    const skip = skipNote(ctx);
    if (skip) return { kind: 'satisfied', note: skip };
    const iosPath = ctx.rnPaths.iosPath as string;
    const local = await readOrNull(path.join(iosPath, '.gitignore'));
    const root = await readOrNull(path.join(ctx.cwd, '.gitignore'));
    if (ignoresEnvLocal(local) || ignoresEnvLocal(root)) {
      return { kind: 'satisfied', note: '.xcode.env.local is already git-ignored' };
    }
    return { kind: 'pending' };
  },

  async apply(ctx): Promise<undefined> {
    const file = path.join(ctx.rnPaths.iosPath as string, '.gitignore');
    const existing = await readOrNull(file);
    await writeFile(file, addBlock(existing, IGNORE_BEGIN, IGNORE_END, ['.xcode.env.local']));
    ctx.log.info('Added .xcode.env.local to ios/.gitignore');
    return undefined;
  },

  async rollback(ctx): Promise<void> {
    if (ctx.rnPaths.iosPath === null) return;
    await rollbackBlock(path.join(ctx.rnPaths.iosPath, '.gitignore'), IGNORE_BEGIN, IGNORE_END);
  },
};

const USER_TOKEN_RE = /^\s*export\s+(BUGSEE_APP_TOKEN|BUGSEE_TOKEN_IOS)=/m;

function tokenLines(token: string): string[] {
  return [`export BUGSEE_TOKEN_IOS=${shellValue(token)}`];
}

const tokenStep: Step<RnContext> = {
  id: 'rn.ios.xcode-env-token',
  title: 'Write the iOS app token to ios/.xcode.env.local',

  async precheck(ctx): Promise<StepStatus> {
    const skip = skipNote(ctx);
    if (skip) return { kind: 'satisfied', note: skip };
    const file = path.join(ctx.rnPaths.iosPath as string, '.xcode.env.local');
    const content = await readOrNull(file);
    if (content === null) return { kind: 'pending' };
    const ours = blockRe(TOKEN_BEGIN, TOKEN_END).exec(content);
    if (ours) {
      const wanted = addBlock(null, TOKEN_BEGIN, TOKEN_END, tokenLines(ctx.tokens.ios as string));
      return ours[0] === wanted ? { kind: 'satisfied' } : { kind: 'pending' };
    }
    if (USER_TOKEN_RE.test(content)) {
      return { kind: 'satisfied', note: '.xcode.env.local already exports a Bugsee token' };
    }
    return { kind: 'pending' };
  },

  async apply(ctx): Promise<undefined> {
    const file = path.join(ctx.rnPaths.iosPath as string, '.xcode.env.local');
    const existing = await readOrNull(file);
    const base = existing === null ? null : stripBlock(existing, TOKEN_BEGIN, TOKEN_END);
    await writeFile(
      file,
      addBlock(base, TOKEN_BEGIN, TOKEN_END, tokenLines(ctx.tokens.ios as string)),
    );
    return undefined;
  },

  async rollback(ctx): Promise<void> {
    if (ctx.rnPaths.iosPath === null) return;
    await rollbackBlock(path.join(ctx.rnPaths.iosPath, '.xcode.env.local'), TOKEN_BEGIN, TOKEN_END);
  },
};

/** Order matters: the ignore entry lands before the token file exists. */
export const iosXcodeSteps: Step<RnContext>[] = [
  bundlePhaseStep,
  schemePostActionStep,
  gitignoreStep,
  tokenStep,
];
