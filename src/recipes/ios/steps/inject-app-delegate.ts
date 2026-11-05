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

/**
 * Copy of `src` with comments and string/char-literal contents blanked to
 * spaces (newlines and the quote characters themselves kept), so indices
 * line up with the original while regexes and brace matching only ever see
 * active code. Handles `//`, `/* *\/` (nested in Swift), Swift `"""` blocks,
 * and ObjC `'c'` literals.
 */
function maskNonCode(src: string, language: AppDelegateLanguage): string {
  const out = src.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const swift = language === 'swift';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (two === '//') {
      let end = src.indexOf('\n', i);
      if (end === -1) end = src.length;
      blank(i, end);
      i = end;
    } else if (two === '/*') {
      let depth = 1;
      let j = i + 2;
      while (j < src.length && depth > 0) {
        const pair = src.slice(j, j + 2);
        if (pair === '*/') {
          depth--;
          j += 2;
        } else if (swift && pair === '/*') {
          depth++;
          j += 2;
        } else {
          j++;
        }
      }
      blank(i, j);
      i = j;
    } else if (swift && src.startsWith('"""', i)) {
      const close = src.indexOf('"""', i + 3);
      const end = close === -1 ? src.length : close;
      blank(i + 3, end);
      i = close === -1 ? src.length : close + 3;
    } else if (c === '"' || (!swift && c === "'")) {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') {
        j += src[j] === '\\' ? 2 : 1;
      }
      blank(i + 1, Math.min(j, src.length));
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

interface LaunchScan {
  /** Active (non-comment, non-string) text of the whole source. */
  readonly masked: string;
  /** Index just past the `{` of didFinishLaunching, or null if absent. */
  readonly bodyStart: number | null;
  /** Index of the matching `}` (or end of source), or null if absent. */
  readonly bodyEnd: number | null;
}

function scanLaunch(source: string, language: AppDelegateLanguage): LaunchScan {
  const masked = maskNonCode(source, language);
  const fn = LAUNCH_FUNC_RE[language].exec(masked);
  if (!fn) return { masked, bodyStart: null, bodyEnd: null };
  const bodyStart = fn.index + fn[0].length;
  let depth = 1;
  let j = bodyStart;
  for (; j < masked.length && depth > 0; j++) {
    if (masked[j] === '{') depth++;
    else if (masked[j] === '}') depth--;
  }
  return { masked, bodyStart, bodyEnd: depth === 0 ? j - 1 : masked.length };
}

/**
 * Whether the app already launches Bugsee from didFinishLaunching: either
 * our marker block is present, or the launch call appears as active code
 * inside that method's body. A mention in a comment/string or a call in
 * some other method does not count — launch would never run at startup.
 */
function launchesBugsee(source: string, language: AppDelegateLanguage, scan: LaunchScan): boolean {
  if (source.includes(LAUNCH_MARKER_BEGIN) && source.includes(LAUNCH_MARKER_END)) return true;
  if (scan.bodyStart === null || scan.bodyEnd === null) return false;
  return LAUNCH_PRESENT_RE[language].test(scan.masked.slice(scan.bodyStart, scan.bodyEnd));
}

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
    const scan = scanLaunch(content, lang);
    if (launchesBugsee(content, lang, scan) && IMPORT_PRESENT_RE[lang].test(content)) {
      // Not replaced automatically (the call may be hand-edited); just say so.
      const body =
        scan.bodyStart !== null && scan.bodyEnd !== null
          ? content.slice(scan.bodyStart, scan.bodyEnd)
          : content;
      const existing = LAUNCH_TOKEN_RE[lang].exec(body)?.[1];
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
    if (scan.bodyStart === null) {
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
    const scan = scanLaunch(updated, lang);
    if (!launchesBugsee(updated, lang, scan)) {
      if (scan.bodyStart === null) {
        throw new Error('Could not find didFinishLaunchingWithOptions function');
      }
      const braceEnd = scan.bodyStart;
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
