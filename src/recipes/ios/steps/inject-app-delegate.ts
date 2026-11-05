import { writeFile } from 'node:fs/promises';

import type { Step, StepStatus } from '../../../core/step.js';
import { readOrNull, stripMarkerBlock } from '../../android/io.js';
import {
  type AppDelegateLanguage,
  IMPORT_MARKER_BEGIN,
  IMPORT_MARKER_END,
  type IosContext,
  LAUNCH_MARKER_BEGIN,
  LAUNCH_MARKER_END,
} from '../types.js';

const LAUNCH_PRESENT_RE = {
  swift: /\bBugsee\.launch\b/,
  objc: /\[\s*Bugsee\s+launchWithToken\s*:/,
} as const;

// Captures the literal token of an existing launch call, to detect a re-run
// with a different one.
const LAUNCH_TOKEN_RE = {
  swift: /\bBugsee\.launch\(\s*token:\s*"([^"]*)"/,
  objc: /\[\s*Bugsee\s+launchWithToken\s*:\s*@"([^"]*)"/,
} as const;

const IMPORT_PRESENT_RE = {
  swift: /^\s*import\s+Bugsee\s*$/m,
  objc: /^\s*#import\s+<Bugsee\/Bugsee\.h>\s*$/m,
} as const;

const LAUNCH_FUNC_RE = {
  swift:
    /func\s+application\s*\(\s*_\s+application\s*:\s*UIApplication\s*,\s*didFinishLaunchingWithOptions\s+launchOptions[\s\S]*?\)\s*->\s*Bool\s*\{/,
  objc: /-\s*\(\s*BOOL\s*\)\s*application\s*:\s*\(\s*UIApplication\s*\*\s*\)\s*application\s+didFinishLaunchingWithOptions\s*:\s*\([^)]*\)\s*\w+\s*\{/,
} as const;

function importBlock(language: AppDelegateLanguage): string {
  const importLine = language === 'swift' ? 'import Bugsee' : '#import <Bugsee/Bugsee.h>';
  return `${IMPORT_MARKER_BEGIN}
${importLine}
${IMPORT_MARKER_END}
`;
}

function launchBlock(language: AppDelegateLanguage, token: string): string {
  const indent = '    ';
  const callLine =
    language === 'swift'
      ? `${indent}Bugsee.launch(token: "${token}")`
      : `${indent}[Bugsee launchWithToken:@"${token}"];`;
  return `${indent}${LAUNCH_MARKER_BEGIN}
${callLine}
${indent}${LAUNCH_MARKER_END}
`;
}

function findLastImportEnd(source: string, language: AppDelegateLanguage): number | null {
  const re =
    language === 'swift'
      ? /^\s*import\s+\w+(?:\.\w+)*\s*$/gm
      : /^\s*#import\s+(?:<[^>]+>|"[^"]+")\s*$/gm;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
  while ((m = re.exec(source))) last = m;
  return last ? last.index + last[0].length : null;
}

export const injectAppDelegateStep: Step<IosContext> = {
  id: 'ios.inject-app-delegate',
  title: 'Inject Bugsee.launch into AppDelegate',

  async precheck(ctx): Promise<StepStatus> {
    if (!ctx.iosOptions.autoInjectAppDelegate) {
      return { kind: 'satisfied', note: 'auto-inject not selected' };
    }
    // No AppDelegate at all (typical for modern SwiftUI `@main App` projects).
    // Treat as satisfied + note so run.ts can print the snippet for the user
    // instead of failing the whole run.
    if (!ctx.iosPaths.appDelegate || !ctx.iosPaths.appDelegateLanguage) {
      return {
        kind: 'satisfied',
        note: 'no AppDelegate found — snippet will be printed at the end',
      };
    }
    const content = await readOrNull(ctx.iosPaths.appDelegate);
    if (content === null) {
      return {
        kind: 'satisfied',
        note: 'AppDelegate not readable — snippet will be printed at the end',
      };
    }
    const lang = ctx.iosPaths.appDelegateLanguage;
    if (LAUNCH_PRESENT_RE[lang].test(content) && IMPORT_PRESENT_RE[lang].test(content)) {
      // Not replaced automatically (the call may be hand-edited); just say so.
      const existing = LAUNCH_TOKEN_RE[lang].exec(content)?.[1];
      const supplied = ctx.tokens.ios;
      if (existing !== undefined && supplied && existing !== supplied) {
        ctx.log.warn(
          'AppDelegate already launches Bugsee with a different token than the one you entered; left unchanged — update it manually if needed.',
        );
      }
      return { kind: 'satisfied' };
    }
    // AppDelegate exists but lacks the canonical launch function (e.g. it's a
    // small adapter for `@UIApplicationDelegateAdaptor` that doesn't override
    // `application(_:didFinishLaunchingWithOptions:)`). Same fallback —
    // print the snippet rather than blocking.
    if (!LAUNCH_FUNC_RE[lang].exec(content)) {
      return {
        kind: 'satisfied',
        note: 'AppDelegate lacks didFinishLaunchingWithOptions — snippet will be printed at the end',
      };
    }
    return { kind: 'pending' };
  },

  async apply(ctx) {
    if (!ctx.iosPaths.appDelegate || !ctx.iosPaths.appDelegateLanguage) {
      throw new Error('AppDelegate path not resolved in context');
    }
    const lang = ctx.iosPaths.appDelegateLanguage;
    const token = ctx.tokens.ios;
    if (!token) throw new Error('iOS app token not provided in wizard context');

    const original = (await readOrNull(ctx.iosPaths.appDelegate)) ?? '';

    let updated = original;
    // 1) Add import (if not already present), after the last existing import.
    if (!IMPORT_PRESENT_RE[lang].test(updated)) {
      const lastImportEnd = findLastImportEnd(updated, lang);
      // If the source has imports, we splice after the last one's newline.
      // Otherwise insert at the very top.
      if (lastImportEnd !== null) {
        const insertAt = updated[lastImportEnd] === '\n' ? lastImportEnd + 1 : lastImportEnd;
        updated = `${updated.slice(0, insertAt)}${importBlock(lang)}${updated.slice(insertAt)}`;
      } else {
        updated = importBlock(lang) + updated;
      }
    }

    // 2) Insert Bugsee.launch at the start of the launch function body.
    if (!LAUNCH_PRESENT_RE[lang].test(updated)) {
      const funcMatch = LAUNCH_FUNC_RE[lang].exec(updated);
      if (!funcMatch) {
        throw new Error('Could not find didFinishLaunchingWithOptions function');
      }
      const braceEnd = funcMatch.index + funcMatch[0].length;
      // Anchor at the start of the next line so the inserted block sits on
      // its own lines with consistent indentation; rollback can strip cleanly.
      const eol = updated.indexOf('\n', braceEnd);
      const restOfLine = updated.slice(braceEnd, eol === -1 ? undefined : eol);
      if (restOfLine.trim() !== '') {
        // Code follows the brace on the same line (`{ return true }`): break
        // the line right after the brace so the block stays inside the body.
        updated = `${updated.slice(0, braceEnd)}\n${launchBlock(lang, token)}${updated.slice(braceEnd)}`;
      } else {
        const insertAt = eol === -1 ? braceEnd : eol + 1;
        const prefix = eol === -1 ? '\n' : '';
        updated = `${updated.slice(0, insertAt)}${prefix}${launchBlock(lang, token)}${updated.slice(insertAt)}`;
      }
    }

    await writeFile(ctx.iosPaths.appDelegate, updated);
  },

  async rollback(ctx) {
    if (!ctx.iosPaths.appDelegate) return;
    const content = await readOrNull(ctx.iosPaths.appDelegate);
    if (content === null) return;
    let stripped = stripMarkerBlock(content, IMPORT_MARKER_BEGIN, IMPORT_MARKER_END);
    stripped = stripMarkerBlock(stripped, LAUNCH_MARKER_BEGIN, LAUNCH_MARKER_END);
    if (stripped !== content) {
      await writeFile(ctx.iosPaths.appDelegate, stripped);
    }
  },
};
