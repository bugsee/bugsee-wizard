import { basename } from 'node:path';
import { applyEdits, modify, type ParseError, parse } from 'jsonc-parser';

/**
 * Structured "what the wizard changed" descriptors stored next to a manifest entry, so uninstall can
 * undo exactly the wizard's part of a file the user has edited since (the whole-file hash no longer
 * matches then). Entries written before these existed simply have none.
 */
export type ManifestEdit =
  /** A JSON key that did not exist before; `value` is what the wizard wrote. */
  | { kind: 'json-add'; path: string[]; value: unknown }
  /** A JSON value the wizard changed from `before` to `after`. */
  | { kind: 'json-set'; path: string[]; before: unknown; after: unknown }
  /** A text hunk: the wizard replaced the lines `del` with `add` (either may be empty). */
  | { kind: 'lines'; del: string[]; add: string[]; context?: string };

const MAX_EDIT_BYTES = 200_000;
const MAX_LCS_CELLS = 1_000_000;
const MAX_HUNK_LINES = 500;
const DEP_SECTIONS = new Set([
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]);
const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'deno.lock',
]);

export const isLockfile = (file: string): boolean => LOCKFILES.has(basename(file));

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => jsonEqual(x, b[i]))
    );
  }
  if (isRecord(a) && isRecord(b)) {
    const ka = Object.keys(a);
    return (
      ka.length === Object.keys(b).length &&
      ka.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]))
    );
  }
  return a === b;
}

// ------------------------------------------------------------------ computing (record time)

function jsonDiff(
  oldV: Record<string, unknown>,
  newV: Record<string, unknown>,
  path: string[],
  out: ManifestEdit[],
): void {
  for (const [key, value] of Object.entries(newV)) {
    if (value === undefined) continue;
    if (!Object.hasOwn(oldV, key)) {
      out.push({ kind: 'json-add', path: [...path, key], value });
      continue;
    }
    const old = oldV[key];
    if (jsonEqual(old, value)) continue;
    if (isRecord(old) && isRecord(value)) jsonDiff(old, value, [...path, key], out);
    else out.push({ kind: 'json-set', path: [...path, key], before: old, after: value });
  }
}

const splitLines = (s: string): string[] => s.split(/\r?\n/);

function lineHunks(before: string, after: string): ManifestEdit[] | undefined {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const am = a.slice(start, endA);
  const bm = b.slice(start, endB);
  if (am.length > MAX_HUNK_LINES || bm.length > MAX_HUNK_LINES) return undefined;
  const n = am.length;
  const m = bm.length;
  if (n * m > MAX_LCS_CELLS) return undefined;
  // longest common subsequence of the differing middle, to split it into separate hunks
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = lcs[i] as number[];
      row[j] =
        am[i] === bm[j]
          ? ((lcs[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((lcs[i + 1] as number[])[j] as number, row[j + 1] as number);
    }
  }
  const hunks: ManifestEdit[] = [];
  let del: string[] = [];
  let add: string[] = [];
  let context: string | undefined = start > 0 ? a[start - 1] : undefined;
  const flush = (): void => {
    if (add.some((l) => l.trim() !== '')) {
      hunks.push({ kind: 'lines', del, add, ...(context === undefined ? {} : { context }) });
    }
    del = [];
    add = [];
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && am[i] === bm[j]) {
      flush();
      context = am[i];
      i++;
      j++;
    } else if (
      j < m &&
      (i === n ||
        ((lcs[i] as number[])[j + 1] as number) >= ((lcs[i + 1] as number[])[j] as number))
    ) {
      add.push(bm[j] as string);
      j++;
    } else {
      del.push(am[i] as string);
      i++;
    }
  }
  flush();
  return hunks;
}

/** The structured edits for one recorded change, or undefined when none can be described safely. */
export function computeEdits(
  file: string,
  action: 'created' | 'edited',
  before: string | undefined,
  after: string | undefined,
): ManifestEdit[] | undefined {
  if (after === undefined || after.length > MAX_EDIT_BYTES || isLockfile(file)) return undefined;
  const name = basename(file);
  if (action === 'created') {
    if (name !== '.gitignore') return undefined;
    const lines = splitLines(after).filter((l) => l.trim() !== '');
    return [{ kind: 'lines', del: [], add: lines }];
  }
  if (before === undefined || before.length > MAX_EDIT_BYTES) return undefined;
  if (name === 'package.json') {
    try {
      const o: unknown = JSON.parse(before);
      const n: unknown = JSON.parse(after);
      if (!isRecord(o) || !isRecord(n)) return undefined;
      const out: ManifestEdit[] = [];
      jsonDiff(o, n, [], out);
      return out;
    } catch {
      return undefined;
    }
  }
  return lineHunks(before, after);
}

// ------------------------------------------------------------------ validating (load time)

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === 'string');

export function validEdits(v: unknown): v is ManifestEdit[] {
  if (!Array.isArray(v)) return false;
  return v.every((e) => {
    if (!isRecord(e)) return false;
    if (e['kind'] === 'json-add') return isStringArray(e['path']) && e['path'].length > 0;
    if (e['kind'] === 'json-set') {
      return isStringArray(e['path']) && e['path'].length > 0;
    }
    if (e['kind'] === 'lines') {
      return (
        isStringArray(e['del']) &&
        isStringArray(e['add']) &&
        (e['context'] === undefined || typeof e['context'] === 'string')
      );
    }
    return false;
  });
}

// ------------------------------------------------------------------ applying (uninstall time)

export interface TargetedRevert {
  /** The file text with the wizard's part taken out. */
  text: string;
  /** What could not be taken out safely, each phrased as an instruction to the user. */
  manual: string[];
}

const show = (s: string): string => JSON.stringify(s.length > 120 ? `${s.slice(0, 117)}...` : s);

function getAt(root: unknown, path: readonly string[]): unknown {
  let cur = root;
  for (const k of path) {
    if (!isRecord(cur) || !Object.hasOwn(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
}

function parseJson(text: string): Record<string, unknown> | undefined {
  const errors: ParseError[] = [];
  const v: unknown = parse(text, errors, { allowTrailingComma: true });
  return errors.length === 0 && isRecord(v) ? v : undefined;
}

function removeKey(text: string, path: string[]): string {
  return applyEdits(text, modify(text, path, undefined, {}));
}

function revertJsonAdd(text: string, path: string[], value: unknown, manual: string[]): string {
  const root = parseJson(text);
  const cur = getAt(root, path);
  if (cur === undefined) return text; // already gone
  const dotted = path.join('.');
  if (isRecord(value) && isRecord(cur)) {
    let out = text;
    for (const [k, v] of Object.entries(value)) out = revertJsonAdd(out, [...path, k], v, manual);
    const left = getAt(parseJson(out), path);
    return isRecord(left) && Object.keys(left).length === 0 ? removeKey(out, path) : out;
  }
  // a dependency's version is the user's to move; anything else is removed only when still ours
  if (DEP_SECTIONS.has(path[0] as string) || jsonEqual(cur, value)) return removeKey(text, path);
  manual.push(`remove "${dotted}" (you changed it since the wizard added it)`);
  return text;
}

function revertJsonSet(
  text: string,
  path: string[],
  before: unknown,
  after: unknown,
  manual: string[],
): string {
  const cur = getAt(parseJson(text), path);
  const dotted = path.join('.');
  if (cur === undefined) return text;
  const set = (v: unknown): string =>
    applyEdits(
      text,
      modify(text, path, v, { formattingOptions: { insertSpaces: true, tabSize: 2 } }),
    );
  if (jsonEqual(cur, after)) return set(before);
  if (
    typeof cur === 'string' &&
    typeof before === 'string' &&
    typeof after === 'string' &&
    after.startsWith(before)
  ) {
    const suffix = after.slice(before.length);
    const at = suffix === '' ? -1 : cur.lastIndexOf(suffix);
    if (at !== -1) return set(cur.slice(0, at) + cur.slice(at + suffix.length));
    if (!cur.includes(suffix)) return text; // the wizard's addition is already gone
    manual.push(`remove ${show(suffix)} from "${dotted}"`);
    return text;
  }
  manual.push(`set "${dotted}" back to ${show(JSON.stringify(before))}`);
  return text;
}

function revertLines(
  text: string,
  hunk: Extract<ManifestEdit, { kind: 'lines' }>,
  manual: string[],
): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = splitLines(text);
  const { add, del } = hunk;
  const matches: number[] = [];
  for (let i = 0; i + add.length <= lines.length; i++) {
    if (add.every((l, k) => lines[i + k] === l)) matches.push(i);
  }
  if (matches.length === 0 && add.length > 0) {
    // the replaced lines being back means an earlier, partial uninstall already did this
    const done =
      del.length > 0 &&
      (() => {
        for (let i = 0; i + del.length <= lines.length; i++) {
          if (del.every((l, k) => lines[i + k] === l)) return true;
        }
        return false;
      })();
    if (!done) {
      const lead = add.map(show).join(', ');
      manual.push(
        del.length === 0
          ? `remove the line${add.length > 1 ? 's' : ''} ${lead}`
          : `replace ${lead} with ${del.map(show).join(', ')}`,
      );
    }
    return text;
  }
  const preferred = matches.find(
    (i) => hunk.context !== undefined && lines[i - 1] === hunk.context,
  );
  const at = preferred ?? (matches[matches.length - 1] as number);
  lines.splice(at, add.length, ...del);
  return lines.join(eol);
}

/** Take the wizard's recorded edits out of `text`, newest first; keep everything else. */
export function revertEdits(text: string, edits: readonly ManifestEdit[]): TargetedRevert {
  const manual: string[] = [];
  let out = text;
  const needsJson = edits.some((e) => e.kind !== 'lines');
  if (needsJson && parseJson(text) === undefined) {
    return {
      text,
      manual: ['fix the JSON syntax, then remove the Bugsee entries the wizard added'],
    };
  }
  for (const e of [...edits].reverse()) {
    if (e.kind === 'json-add') out = revertJsonAdd(out, e.path, e.value, manual);
    else if (e.kind === 'json-set') out = revertJsonSet(out, e.path, e.before, e.after, manual);
    else out = revertLines(out, e, manual);
  }
  return { text: out, manual };
}

/** The package names the wizard added to a dependency section (for the lockfile instruction). */
export function addedPackages(edits: readonly ManifestEdit[] | undefined): string[] {
  const names: string[] = [];
  for (const e of edits ?? []) {
    if (e.kind !== 'json-add' || !DEP_SECTIONS.has(e.path[0] as string)) continue;
    if (e.path.length === 2) names.push(e.path[1] as string);
    else if (e.path.length === 1 && isRecord(e.value)) names.push(...Object.keys(e.value));
  }
  return names;
}

const REMOVE_COMMAND: Record<string, string> = {
  'package-lock.json': 'npm uninstall',
  'npm-shrinkwrap.json': 'npm uninstall',
  'pnpm-lock.yaml': 'pnpm remove',
  'yarn.lock': 'yarn remove',
  'bun.lock': 'bun remove',
  'bun.lockb': 'bun remove',
};

/** What to tell the user about a lockfile that changed since the wizard wrote it. */
export function lockfileNote(file: string, packages: readonly string[]): string {
  const cmd = REMOVE_COMMAND[basename(file)];
  if (packages.length === 0 || cmd === undefined) {
    return 'changed since the wizard wrote it; left untouched. Remove the Bugsee packages (@bugsee/*) with your package manager so it updates this lockfile';
  }
  const list = packages.join(' ');
  return `changed since the wizard wrote it; left untouched. Run \`${cmd} ${list}\` to take Bugsee out of it`;
}
