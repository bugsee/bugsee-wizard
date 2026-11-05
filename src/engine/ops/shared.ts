import { lstat, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { RecipeContext } from '../recipe.js';

/**
 * Resolve `rel` under `dir`, refusing anything that lands outside it: lexically
 * (`..`, absolute) and through symlinks (the deepest existing ancestor, or the
 * file itself, must resolve inside the real package directory).
 */
export async function resolveInside(dir: string, rel: string): Promise<string> {
  const abs = resolve(dir, rel);
  const back = relative(resolve(dir), abs);
  if (back === '' || back === '..' || back.startsWith(`..${sep}`) || isAbsolute(back)) {
    throw new Error(`Path escapes the package directory: ${rel}`);
  }
  const realRoot = await realpath(dir);
  let existing = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      existing = await realpath(existing);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      if (
        await lstat(existing).then(
          () => true,
          () => false,
        )
      ) {
        throw new Error(`Path escapes the package directory via a dangling symlink: ${rel}`);
      }
      tail.unshift(basename(existing));
      existing = dirname(existing);
    }
  }
  const real = join(existing, ...tail);
  const inside = relative(realRoot, real);
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error(`Path escapes the package directory via a symlink: ${rel}`);
  }
  return abs;
}

/** Bytes of a file, or null when it does not exist. */
export async function readBytes(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Put a file back exactly as captured: the bytes, or gone when it did not exist. */
export async function restoreBytes(path: string, bytes: Buffer | null): Promise<void> {
  if (bytes === null) await rm(path, { force: true });
  else await writeFile(path, bytes);
}

/** Manifest-friendly path: relative to the run's cwd, forward slashes. */
export function manifestPath(ctx: RecipeContext, abs: string): string {
  return relative(ctx.cwd, abs).split(sep).join('/');
}

export function text(bytes: Buffer | null): string | undefined {
  return bytes === null ? undefined : bytes.toString('utf8');
}
