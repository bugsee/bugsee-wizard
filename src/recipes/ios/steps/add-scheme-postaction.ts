import { writeFile } from 'node:fs/promises';

import type { Step, StepStatus } from '../../../core/step.js';
import { readOrNull } from '../../android/io.js';
import { type IosContext, type IosOptions, POSTACTION_TITLE } from '../types.js';

interface BuildableReferenceAttrs {
  readonly BlueprintIdentifier: string;
  readonly BuildableName: string;
  readonly BlueprintName: string;
  readonly ReferencedContainer: string;
}

function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Read the BuildAction's BuildableReference attributes from the scheme XML.
 * The post-action's `<EnvironmentBuildable>` (the "Provide build settings
 * from" dropdown in Xcode) needs to point at the same target so the script
 * receives `$PROJECT_DIR`, `$INFOPLIST_PATH`, etc. that BugseeAgent needs.
 */
function extractBuildableReference(scheme: string): BuildableReferenceAttrs | null {
  const buildActionMatch = /<BuildAction\b[\s\S]*?<\/BuildAction>/.exec(scheme);
  if (!buildActionMatch) return null;
  const buildAction = buildActionMatch[0];
  const refMatch = /<BuildableReference\b([\s\S]*?)\/?>/.exec(buildAction);
  if (!refMatch) return null;
  const attrs = refMatch[1] ?? '';
  const get = (name: string): string | null => {
    const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
    return m ? (m[1] ?? null) : null;
  };
  const BlueprintIdentifier = get('BlueprintIdentifier');
  const BuildableName = get('BuildableName');
  const BlueprintName = get('BlueprintName');
  const ReferencedContainer = get('ReferencedContainer');
  if (!BlueprintIdentifier || !BuildableName || !BlueprintName || !ReferencedContainer) {
    return null;
  }
  return { BlueprintIdentifier, BuildableName, BlueprintName, ReferencedContainer };
}

function buildScriptText(token: string, opts: IosOptions): string {
  const lines: string[] = [
    `SCRIPT_SRC=$(find "$PROJECT_DIR" -name 'BugseeAgent' | head -1)`,
    `if [ ! "${'$'}{SCRIPT_SRC}" ]; then`,
    `  echo "Error: Bugsee build phase script not found. Make sure that you're including Bugsee in your project."`,
    '  exit 1',
    'fi',
  ];
  if (opts.sizeAnalysis) {
    lines.push('export BUGSEE_SIZE_ANALYSIS_ENABLED=1');
    if (opts.sizeAnalysisAllConfigurations) {
      lines.push('export BUGSEE_SIZE_ANALYSIS_ALL_CONFIGURATIONS=1');
    }
  }
  lines.push(`python3 "${'$'}{SCRIPT_SRC}" ${token}`);
  return lines.join('\n');
}

function buildPostActionXml(token: string, opts: IosOptions, ref: BuildableReferenceAttrs): string {
  const scriptText = escapeXmlAttr(buildScriptText(token, opts));
  return [
    '      <ExecutionAction',
    `         ActionType = "Xcode.IDEStandardExecutionActionsCore.ExecutionActionType.ShellScriptAction">`,
    '         <ActionContent',
    `            title = "${POSTACTION_TITLE}"`,
    `            scriptText = "${scriptText}"`,
    `            shellToInvoke = "/bin/sh">`,
    '            <EnvironmentBuildable>',
    '               <BuildableReference',
    `                  BuildableIdentifier = "primary"`,
    `                  BlueprintIdentifier = "${escapeXmlAttr(ref.BlueprintIdentifier)}"`,
    `                  BuildableName = "${escapeXmlAttr(ref.BuildableName)}"`,
    `                  BlueprintName = "${escapeXmlAttr(ref.BlueprintName)}"`,
    `                  ReferencedContainer = "${escapeXmlAttr(ref.ReferencedContainer)}">`,
    '               </BuildableReference>',
    '            </EnvironmentBuildable>',
    '         </ActionContent>',
    '      </ExecutionAction>',
  ].join('\n');
}

/**
 * Detect whether our post-action is already present. Sniffs for an
 * ExecutionAction whose ActionContent title matches our marker constant.
 */
function hasOurPostAction(scheme: string): boolean {
  const span = findArchiveAction(scheme);
  if (!span) return false;
  const body = scheme.slice(span.bodyStart, span.bodyEnd);
  const re = new RegExp(
    `<ExecutionAction\\b[\\s\\S]*?<ActionContent[\\s\\S]*?title\\s*=\\s*"${POSTACTION_TITLE}"`,
  );
  return re.test(body);
}

/**
 * Locate the `<ArchiveAction>` element in the scheme. Handles both shapes
 * Xcode emits:
 *  - paired:        `<ArchiveAction ...>...</ArchiveAction>`
 *  - self-closing:  `<ArchiveAction ... />` (when the action has no children)
 *
 * Returns the indices of the open / close so callers can splice into the
 * body. For self-closing, callers must first expand to a paired tag — see
 * `expandSelfClosingArchiveAction`.
 */
interface ArchiveSpan {
  readonly openStart: number;
  readonly bodyStart: number;
  readonly bodyEnd: number;
  readonly closeEnd: number;
  readonly isSelfClosing: boolean;
}

function findArchiveAction(scheme: string): ArchiveSpan | null {
  // Match the open tag, capturing whether it self-closes.
  const openRe = /<ArchiveAction\b([^>]*?)(\/?)>/;
  const open = openRe.exec(scheme);
  if (!open) return null;
  const openStart = open.index;
  const openEnd = open.index + open[0].length;
  if (open[2] === '/') {
    return {
      openStart,
      bodyStart: openEnd,
      bodyEnd: openEnd,
      closeEnd: openEnd,
      isSelfClosing: true,
    };
  }
  const closeIdx = scheme.indexOf('</ArchiveAction>', openEnd);
  if (closeIdx === -1) return null;
  return {
    openStart,
    bodyStart: openEnd,
    bodyEnd: closeIdx,
    closeEnd: closeIdx + '</ArchiveAction>'.length,
    isSelfClosing: false,
  };
}

/**
 * Replace a `<ArchiveAction ... />` self-closing tag with its paired
 * equivalent and an empty body. No-op when the tag is already paired.
 * Used to normalize before splicing PostActions in.
 */
function expandSelfClosingArchiveAction(scheme: string): string {
  return scheme.replace(/<ArchiveAction\b([^>]*?)\/>/, '<ArchiveAction$1>\n   </ArchiveAction>');
}

/**
 * Splice our post-action into <ArchiveAction>'s <PostActions>. Adds the
 * <PostActions> wrapper if it doesn't yet exist. Handles both paired and
 * self-closing ArchiveAction shapes.
 */
function insertPostAction(scheme: string, postActionXml: string): string {
  const span = findArchiveAction(scheme);
  if (!span) {
    throw new Error('No <ArchiveAction> in scheme — wizard cannot install post-action.');
  }
  // Normalize self-closing form first; everything below assumes a paired tag.
  if (span.isSelfClosing) {
    return insertPostAction(expandSelfClosingArchiveAction(scheme), postActionXml);
  }
  const body = scheme.slice(span.bodyStart, span.bodyEnd);
  const archiveStart = span.openStart;
  const archiveEnd = span.closeEnd;

  const existingPostActions = /<PostActions>[\s\S]*?<\/PostActions>/.exec(body);
  let updatedBody: string;
  if (existingPostActions) {
    // Append our ExecutionAction inside the existing <PostActions>.
    const insertAt =
      existingPostActions.index + existingPostActions[0].length - '</PostActions>'.length;
    updatedBody = `${body.slice(0, insertAt)}${postActionXml}\n      ${body.slice(insertAt)}`;
  } else {
    // Inject a <PostActions> wrapper inside the archive body.
    const wrapped = `\n   <PostActions>\n${postActionXml}\n   </PostActions>\n`;
    updatedBody = `${body.replace(/\s*$/, '')}${wrapped}   `;
  }
  return `${scheme.slice(0, archiveStart)}${scheme.slice(archiveStart, span.bodyStart)}${updatedBody}</ArchiveAction>${scheme.slice(archiveEnd)}`;
}

/**
 * Find and remove our `<ExecutionAction>` from the ArchiveAction's
 * `<PostActions>`, identified by its `<ActionContent title="...">`. The
 * search is *scoped to the archive subtree* so an unrelated PostAction
 * elsewhere in the scheme cannot be accidentally absorbed by a lazy regex
 * walking across element boundaries.
 *
 * Drops a now-empty `<PostActions>` wrapper.
 */
function removePostAction(scheme: string): string {
  const span = findArchiveAction(scheme);
  if (!span) return scheme;
  const body = scheme.slice(span.bodyStart, span.bodyEnd);

  // Walk every `<ExecutionAction>...</ExecutionAction>` block within the
  // archive body. ExecutionAction does not nest, so a non-greedy boundary
  // match is unambiguous when applied per-block.
  const execRe = /<ExecutionAction\b[\s\S]*?<\/ExecutionAction>/g;
  const titleRe = new RegExp(`<ActionContent\\b[\\s\\S]*?title\\s*=\\s*"${POSTACTION_TITLE}"`);
  let updatedBody = body;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
  while ((match = execRe.exec(updatedBody))) {
    if (titleRe.test(match[0])) {
      // Strip leading whitespace on the same line so removing the block
      // doesn't leave a hanging indented blank line.
      const start = (() => {
        let i = match.index;
        while (i > 0 && (updatedBody[i - 1] === ' ' || updatedBody[i - 1] === '\t')) i--;
        if (i > 0 && updatedBody[i - 1] === '\n') i--;
        return i;
      })();
      const end = match.index + match[0].length;
      updatedBody = updatedBody.slice(0, start) + updatedBody.slice(end);
      execRe.lastIndex = start;
    }
  }
  // Drop now-empty <PostActions> wrappers.
  updatedBody = updatedBody.replace(/\s*<PostActions>\s*<\/PostActions>/g, '');

  return scheme.slice(0, span.bodyStart) + updatedBody + scheme.slice(span.bodyEnd);
}

export const addSchemePostActionStep: Step<IosContext> = {
  id: 'ios.add-scheme-postaction',
  title: 'Add Bugsee post-action to Archive scheme',

  async precheck(ctx): Promise<StepStatus> {
    const content = await readOrNull(ctx.iosPaths.scheme);
    if (content === null) {
      return { kind: 'blocked', reason: `${ctx.iosPaths.scheme} not found` };
    }
    if (hasOurPostAction(content)) return { kind: 'satisfied' };
    if (!extractBuildableReference(content)) {
      return {
        kind: 'blocked',
        reason: 'Could not read BuildableReference from scheme — unexpected scheme shape',
      };
    }
    if (!findArchiveAction(content)) {
      return {
        kind: 'blocked',
        reason: 'No <ArchiveAction> in scheme — unexpected scheme shape',
      };
    }
    return { kind: 'pending' };
  },

  async apply(ctx) {
    const original = (await readOrNull(ctx.iosPaths.scheme)) ?? '';
    const ref = extractBuildableReference(original);
    if (!ref) throw new Error('Could not read BuildableReference from scheme');
    const token = ctx.tokens.ios;
    if (!token) throw new Error('iOS app token not provided in wizard context');
    const postAction = buildPostActionXml(token, ctx.iosOptions, ref);
    const updated = insertPostAction(original, postAction);
    await writeFile(ctx.iosPaths.scheme, updated);
  },

  async rollback(ctx) {
    const content = await readOrNull(ctx.iosPaths.scheme);
    if (content === null) return;
    const stripped = removePostAction(content);
    if (stripped !== content) {
      await writeFile(ctx.iosPaths.scheme, stripped);
    }
  },
};
