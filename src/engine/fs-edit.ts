import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export interface EditResult {
  changed: boolean;
  before: string;
  after: string;
}

/** Write `content` to `path` via a temp file in the same directory + rename. */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const mode = (await stat(path)).mode & 0o777;
    await writeFile(tmp, content, { encoding: 'utf8', mode });
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/**
 * All-or-nothing text edit: the file is only replaced (atomically) when the
 * transformed output passes `validate`; otherwise it throws and the file is untouched.
 */
export async function editTextFile(
  path: string,
  transform: (src: string) => string,
  opts: { validate: (out: string) => boolean },
): Promise<EditResult> {
  const before = await readFile(path, 'utf8');
  const after = transform(before);
  if (after === before) return { changed: false, before, after };
  if (!opts.validate(after)) {
    throw new Error(`Refusing to write ${basename(path)}: edited output failed validation`);
  }
  await writeFileAtomic(path, after);
  return { changed: true, before, after };
}
