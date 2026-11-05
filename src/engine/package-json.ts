import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import detectIndent from 'detect-indent';
import { applyEdits, findNodeAtLocation, modify, parseTree } from 'jsonc-parser';
import { editTextFile } from './fs-edit.js';

export interface PackageJsonHandle {
  data: Record<string, unknown>;
  write: (next: Record<string, unknown>) => Promise<void>;
}

const BOM = '﻿';

type JsonPath = string[];
type Op = { kind: 'set' | 'add' | 'remove'; path: JsonPath; value?: unknown };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parse(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error('package.json root must be a JSON object');
  return parsed;
}

/** Key-level difference between two parsed documents (arrays and scalars are replaced whole). */
function diff(
  oldV: Record<string, unknown>,
  newV: Record<string, unknown>,
  path: JsonPath,
  ops: Op[],
): void {
  for (const key of Object.keys(oldV)) {
    if (newV[key] === undefined) ops.push({ kind: 'remove', path: [...path, key] });
  }
  for (const [key, value] of Object.entries(newV)) {
    if (value === undefined) continue;
    const old = oldV[key];
    if (!Object.hasOwn(oldV, key)) {
      ops.push({ kind: 'add', path: [...path, key], value });
    } else if (!isDeepStrictEqual(old, value)) {
      if (isRecord(old) && isRecord(value)) diff(old, value, [...path, key], ops);
      else ops.push({ kind: 'set', path: [...path, key], value });
    }
  }
}

interface Style {
  unit: string;
  eol: string;
}

function lineIndent(text: string, offset: number): string {
  const start = text.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(start, offset))?.[0] ?? '';
}

function pretty(value: unknown, base: string, st: Style): string {
  return JSON.stringify(value, null, st.unit).replace(/\n/g, st.eol + base);
}

/** Applies one op as a minimal text edit: only the touched value / inserted entry changes. */
function applyOp(text: string, op: Op, st: Style): string {
  const tree = parseTree(text);
  if (!tree) throw new Error('Cannot tokenize package.json');
  const key = op.path[op.path.length - 1] as string;
  const parentPath = op.path.slice(0, -1);

  if (op.kind === 'remove') return applyEdits(text, modify(text, op.path, undefined, {}));

  if (op.kind === 'set') {
    const node = findNodeAtLocation(tree, op.path);
    if (!node) throw new Error('Cannot locate key to edit');
    const old = text.slice(node.offset, node.offset + node.length);
    const rendered = old.includes('\n')
      ? pretty(op.value, lineIndent(text, node.offset), st)
      : JSON.stringify(op.value);
    return text.slice(0, node.offset) + rendered + text.slice(node.offset + node.length);
  }

  const parent = parentPath.length ? findNodeAtLocation(tree, parentPath) : tree;
  if (parent?.type !== 'object') throw new Error('Cannot locate object to insert into');
  const entryKey = JSON.stringify(key);
  const last = parent.children?.[parent.children.length - 1];
  if (!last) {
    const parentIndent = lineIndent(text, parent.offset);
    const ind = parentIndent + st.unit;
    const body = `{${st.eol}${ind}${entryKey}: ${pretty(op.value, ind, st)}${st.eol}${parentIndent}}`;
    return text.slice(0, parent.offset) + body + text.slice(parent.offset + parent.length);
  }
  const lastEnd = last.offset + last.length;
  const prefix = text.slice(text.lastIndexOf('\n', last.offset - 1) + 1, last.offset);
  const ownLine =
    /^[ \t]*$/.test(prefix) && text.lastIndexOf('\n', last.offset - 1) >= parent.offset;
  const insertion = ownLine
    ? `,${st.eol}${prefix}${entryKey}: ${pretty(op.value, prefix, st)}`
    : `, ${entryKey}: ${JSON.stringify(op.value)}`;
  return text.slice(0, lastEnd) + insertion + text.slice(lastEnd);
}

/**
 * Reads package.json, remembering indent, EOL, BOM and trailing newline.
 * `write` performs targeted text edits so bytes outside the changed keys are untouched;
 * a write with nothing changed touches nothing.
 */
export async function readPackageJson(path: string): Promise<PackageJsonHandle> {
  const file = await readFile(path, 'utf8');
  const raw = file.startsWith(BOM) ? file.slice(1) : file;
  const original = parse(raw);
  const snapshot = parse(raw);
  const st: Style = {
    unit: detectIndent(raw).indent || '  ',
    eol: raw.includes('\r\n') ? '\r\n' : '\n',
  };

  return {
    data: original,
    async write(next) {
      if (isDeepStrictEqual(next, snapshot)) return;
      const ops: Op[] = [];
      diff(snapshot, next, [], ops);
      const expected: unknown = JSON.parse(JSON.stringify(next));
      const strip = (s: string): string => (s.startsWith(BOM) ? s.slice(1) : s);
      await editTextFile(
        path,
        (src) => {
          const bom = src.startsWith(BOM) ? BOM : '';
          let text = strip(src);
          for (const op of ops) text = applyOp(text, op, st);
          return bom + text;
        },
        {
          validate: (out) => {
            try {
              return isDeepStrictEqual(JSON.parse(strip(out)), expected);
            } catch {
              return false;
            }
          },
        },
      );
    },
  };
}
