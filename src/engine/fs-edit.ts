import { randomBytes } from 'node:crypto';
import { chmod, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export interface EditResult {
  changed: boolean;
  before: string;
  after: string;
}

/** Write `content` to `path` via a temp file in the same directory + rename. */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  // Write through symlinks: the temp file lives beside the real target. A target that does not
  // exist yet is created (still via temp + rename, so a crash never leaves a truncated file).
  let target = path;
  let mode: number | undefined;
  try {
    target = await realpath(path);
    mode = (await stat(target)).mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const tmp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, content, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
    // writeFile's mode is masked by the umask; restore the original permissions exactly.
    if (mode !== undefined) await chmod(tmp, mode);
    await rename(tmp, target);
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
