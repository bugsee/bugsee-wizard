import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import detectIndent from 'detect-indent';
import { editTextFile } from './fs-edit.js';

export interface PackageJsonHandle {
  data: Record<string, unknown>;
  write: (next: Record<string, unknown>) => Promise<void>;
}

const BOM = '\uFEFF';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parse(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error('package.json root must be a JSON object');
  return parsed;
}

/**
 * Reads package.json, remembering indent, EOL, BOM and trailing newline so
 * `write` changes only what the caller changed. A no-op write touches nothing.
 */
export async function readPackageJson(path: string): Promise<PackageJsonHandle> {
  const file = await readFile(path, 'utf8');
  const bom = file.startsWith(BOM) ? BOM : '';
  const raw = bom ? file.slice(1) : file;
  const original = parse(raw);
  const indent = detectIndent(raw).indent || '  ';
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const trailing = /\n$/.test(raw) ? eol : '';
  const snapshot: unknown = JSON.parse(raw);

  return {
    data: original,
    async write(next) {
      if (isDeepStrictEqual(next, snapshot) && isOrderEqual(next, snapshot)) return;
      const body = JSON.stringify(next, null, indent).replace(/\n/g, eol);
      await editTextFile(path, () => `${bom}${body}${trailing}`, {
        validate: (out) => isRecord(JSON.parse(out.startsWith(BOM) ? out.slice(1) : out)),
      });
    },
  };
}

function isOrderEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
