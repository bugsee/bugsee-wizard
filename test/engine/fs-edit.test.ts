import { chmod, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { editTextFile, writeFileAtomic } from '../../src/engine/fs-edit.js';
import { makeTmp } from './helpers.js';

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir, cleanup } = await makeTmp());
});
afterEach(async () => {
  await cleanup();
});

describe('editTextFile', () => {
  it('writes the transformed content and reports before/after', async () => {
    const p = join(dir, 'a.txt');
    await writeFile(p, 'hello');
    const r = await editTextFile(p, (s) => `${s} world`, { validate: () => true });
    expect(r).toEqual({ changed: true, before: 'hello', after: 'hello world' });
    expect(await readFile(p, 'utf8')).toBe('hello world');
  });

  it('reports changed:false and leaves the file alone when transform is a no-op', async () => {
    const p = join(dir, 'a.txt');
    await writeFile(p, 'same');
    const r = await editTextFile(p, (s) => s, { validate: () => true });
    expect(r.changed).toBe(false);
    expect(await readFile(p, 'utf8')).toBe('same');
  });

  it('throws and leaves the file byte-identical when validate fails, with no temp files', async () => {
    const p = join(dir, 'a.txt');
    await writeFile(p, 'orig\r\n');
    await expect(editTextFile(p, () => 'broken', { validate: () => false })).rejects.toThrow(
      /validat/i,
    );
    expect(await readFile(p, 'utf8')).toBe('orig\r\n');
    expect(await readdir(dir)).toEqual(['a.txt']);
  });

  it('passes the transformed output to validate', async () => {
    const p = join(dir, 'a.txt');
    await writeFile(p, 'x');
    const seen: string[] = [];
    await editTextFile(p, () => 'y', {
      validate: (o) => {
        seen.push(o);
        return true;
      },
    });
    expect(seen).toEqual(['y']);
  });

  it('writes via a temp file in the same directory then renames (no leftovers)', async () => {
    const p = join(dir, 'a.txt');
    await writeFile(p, 'x');
    await editTextFile(p, () => 'y', { validate: () => true });
    expect(await readdir(dir)).toEqual(['a.txt']);
  });

  it('rejects and cleans up when the transform throws', async () => {
    const p = join(dir, 'a.txt');
    await writeFile(p, 'x');
    await expect(
      editTextFile(
        p,
        () => {
          throw new Error('boom');
        },
        { validate: () => true },
      ),
    ).rejects.toThrow('boom');
    expect(await readFile(p, 'utf8')).toBe('x');
    expect(await readdir(dir)).toEqual(['a.txt']);
  });

  it('rejects when the file is missing', async () => {
    await expect(
      editTextFile(join(dir, 'nope'), (s) => s, { validate: () => true }),
    ).rejects.toThrow();
  });

  it('writeFileAtomic cleans up the temp file when the rename fails', async () => {
    // target path is a directory: rename of a file over a directory fails
    const p = join(dir, 'sub');
    await mkdir(p);
    await expect(writeFileAtomic(p, 'x')).rejects.toThrow();
    expect(await readdir(dir)).toEqual(['sub']);
  });

  it.skipIf(process.platform === 'win32')('preserves the file mode', async () => {
    const p = join(dir, 'a.txt');
    await writeFile(p, 'x', { mode: 0o600 });
    await chmod(p, 0o600);
    await editTextFile(p, () => 'y', { validate: () => true });
    expect((await stat(p)).mode & 0o777).toBe(0o600);
  });
});
