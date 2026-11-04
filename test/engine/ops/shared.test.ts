import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveInside } from '../../../src/engine/ops/shared.js';
import { makeTmp } from '../helpers.js';

describe('resolveInside (lexical)', () => {
  let tmp: Awaited<ReturnType<typeof makeTmp>>;
  let dir: string;
  beforeEach(async () => {
    tmp = await makeTmp();
    dir = join(tmp.dir, 'p');
    await mkdir(dir);
  });
  afterEach(() => tmp.cleanup());

  it('resolves nested relative paths (existing or not) under the directory', async () => {
    expect(await resolveInside(dir, 'a/b.txt')).toBe(join(dir, 'a/b.txt'));
    expect(await resolveInside(dir, 'a/../b.txt')).toBe(join(dir, 'b.txt'));
  });

  it('accepts names that merely start with two dots', async () => {
    expect(await resolveInside(dir, '..hidden')).toBe(join(dir, '..hidden'));
  });

  it('refuses the directory itself, its parent, escapes and absolute paths', async () => {
    for (const bad of ['', '.', '..', '../x', 'a/../../x', '/etc/passwd']) {
      await expect(resolveInside(dir, bad), bad).rejects.toThrow(/escapes the package directory/);
    }
  });

  describe.skipIf(process.platform === 'win32')('symlinks', () => {
    it('refuses a file symlink pointing outside', async () => {
      await writeFile(join(tmp.dir, 'outside.txt'), 'x');
      await symlink(join(tmp.dir, 'outside.txt'), join(dir, 'link'));
      await expect(resolveInside(dir, 'link')).rejects.toThrow(/symlink/);
    });

    it('refuses a path through a symlinked directory pointing outside, even for a new file', async () => {
      await mkdir(join(tmp.dir, 'out'));
      await symlink(join(tmp.dir, 'out'), join(dir, 'bugsee'));
      await expect(resolveInside(dir, 'bugsee/new/deep.txt')).rejects.toThrow(/symlink/);
    });

    it('refuses a symlink to the parent of the package directory', async () => {
      await symlink(tmp.dir, join(dir, 'up'));
      await expect(resolveInside(dir, 'up')).rejects.toThrow(/symlink/);
    });

    it('refuses a dangling symlink', async () => {
      await symlink(join(tmp.dir, 'nowhere'), join(dir, 'dangling'));
      await expect(resolveInside(dir, 'dangling')).rejects.toThrow(/symlink/);
    });

    it('allows a symlink that stays inside the directory', async () => {
      await mkdir(join(dir, 'real'));
      await symlink(join(dir, 'real'), join(dir, 'alias'));
      expect(await resolveInside(dir, 'alias/f.txt')).toBe(join(dir, 'alias/f.txt'));
    });

    it('works when the package dir itself is reached through a symlink', async () => {
      await symlink(dir, join(tmp.dir, 'viaLink'));
      expect(await resolveInside(join(tmp.dir, 'viaLink'), 'f.txt')).toBe(
        join(tmp.dir, 'viaLink', 'f.txt'),
      );
    });
  });
});
