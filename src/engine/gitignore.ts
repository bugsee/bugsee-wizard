import { readFile, writeFile } from 'node:fs/promises';
import { EOL } from 'node:os';
import { join } from 'node:path';
import { editTextFile } from './fs-edit.js';

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === '*') {
      if (glob.charAt(i + 1) === '*') {
        i++;
        if (glob.charAt(i + 1) === '/') i++;
        re += '(?:.*/)?';
        // a trailing "**" or "**/" prefix: remaining chars matched as usual
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

function covers(pattern: string, line: string): boolean {
  const p = pattern.trim();
  if (p === '' || p.startsWith('#')) return false;
  const normalized = p.startsWith('/') ? p.slice(1) : p;
  if (normalized === line) return true;
  // patterns with a slash in the middle are anchored to the root; ours is a root file name
  if (normalized.includes('/') && !normalized.startsWith('**/')) return false;
  return globToRegExp(normalized).test(line);
}

/** Make sure `line` is git-ignored at `root`. Glob-aware (`.env*` covers `.env.x`). */
export async function ensureGitignoreLine(
  root: string,
  line: string,
): Promise<'added' | 'present' | 'created'> {
  const path = join(root, '.gitignore');
  let src: string;
  try {
    src = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    await writeFile(path, `${line}${EOL}`, 'utf8');
    return 'created';
  }
  if (src.split(/\r?\n/).some((l) => covers(l, line))) return 'present';
  const eol = src.includes('\r\n') ? '\r\n' : src.includes('\n') ? '\n' : EOL;
  await editTextFile(
    path,
    (s) => {
      const sep = s === '' || s.endsWith('\n') ? '' : eol;
      return `${s}${sep}${line}${eol}`;
    },
    { validate: (out) => out.split(/\r?\n/).includes(line) },
  );
  return 'added';
}
