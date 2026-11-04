import { readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { RecipeContext } from '../recipe.js';

/** Resolve `rel` under `dir`, refusing anything that lands outside it. */
export function resolveInside(dir: string, rel: string): string {
  const abs = resolve(dir, rel);
  const back = relative(resolve(dir), abs);
  if (back === '' || back === '..' || back.startsWith(`..${sep}`) || isAbsolute(back)) {
    throw new Error(`Path escapes the package directory: ${rel}`);
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
