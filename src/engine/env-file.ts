import { readFile, writeFile } from 'node:fs/promises';
import { EOL } from 'node:os';
import { editTextFile } from './fs-edit.js';

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  return v;
}

function format(value: string): string {
  if (value !== '' && /^[A-Za-z0-9_.\-/:@+=,]+$/.test(value)) return value;
  return `"${value.replace(/(["\\])/g, '\\$1')}"`;
}

/**
 * Sets KEY=value in an env file. Never overwrites an existing different value
 * ('conflict'). Never logs or echoes the value.
 */
export async function setEnvVar(
  file: string,
  key: string,
  value: string,
): Promise<'added' | 'present' | 'conflict'> {
  if (!KEY_RE.test(key)) throw new Error('Invalid environment variable key');
  const entry = `${key}=${format(value)}`;

  let src: string;
  try {
    src = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    await writeFile(file, `${entry}${EOL}`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return 'added';
  }

  for (const l of src.split(/\r?\n/)) {
    const m = LINE_RE.exec(l);
    if (m && m[1] === key) return unquote(m[2] ?? '') === value ? 'present' : 'conflict';
  }

  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  await editTextFile(
    file,
    (s) =>
      `${s}${s === '' ? '' : s.endsWith('\n') ? '' : eol}${entry}${s.endsWith('\n') || s === '' ? eol : ''}`,
    {
      validate: (out) => out.split(/\r?\n/).some((l) => l === entry),
    },
  );
  return 'added';
}
