import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { opToStep } from '../../../src/engine/ops/index.js';
import type { OpSpec } from '../../../src/engine/recipe.js';
import { makeCtx, makeTmp } from '../helpers.js';

const spec: OpSpec = { op: 'write-file', path: 'config/deep/bugsee.txt', template: 'hello\n' };
let tmp: Awaited<ReturnType<typeof makeTmp>>;
beforeEach(async () => {
  tmp = await makeTmp();
});
afterEach(() => tmp.cleanup());

const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );

describe('write-file op', () => {
  it('id and title', () => {
    const step = opToStep(spec);
    expect(step.id).toBe('write-file:config/deep/bugsee.txt');
    expect(step.title).toContain('config/deep/bugsee.txt');
  });

  it('creates parent dirs and the file, records it; rollback removes file AND the dirs it created', async () => {
    const ctx = makeCtx(tmp.dir);
    const step = opToStep(spec);
    expect(await step.precheck(ctx)).toEqual({ kind: 'pending' });
    await step.apply(ctx);
    expect(await readFile(join(tmp.dir, 'config/deep/bugsee.txt'), 'utf8')).toBe('hello\n');
    expect(ctx.entries).toEqual([
      { file: 'config/deep/bugsee.txt', action: 'created', after: 'hello\n' },
    ]);
    expect(await step.precheck(ctx)).toEqual({ kind: 'satisfied' });
    await step.rollback(ctx);
    expect(await exists(join(tmp.dir, 'config'))).toBe(false);
  });

  it('rollback keeps pre-existing directories and unrelated files', async () => {
    await mkdir(join(tmp.dir, 'config'));
    await writeFile(join(tmp.dir, 'config/other.txt'), 'x');
    const ctx = makeCtx(tmp.dir);
    const step = opToStep(spec);
    await step.apply(ctx);
    await step.rollback(ctx);
    expect(await exists(join(tmp.dir, 'config/deep'))).toBe(false);
    expect(await readFile(join(tmp.dir, 'config/other.txt'), 'utf8')).toBe('x');
  });

  it('rollback never removes a pre-existing (empty) parent directory', async () => {
    await mkdir(join(tmp.dir, 'config'));
    const ctx = makeCtx(tmp.dir);
    const step = opToStep(spec);
    await step.apply(ctx);
    await step.rollback(ctx);
    expect(await exists(join(tmp.dir, 'config/deep'))).toBe(false);
    expect(await exists(join(tmp.dir, 'config'))).toBe(true);
  });

  it('rollback leaves a created dir that gained other content', async () => {
    const ctx = makeCtx(tmp.dir);
    const step = opToStep(spec);
    await step.apply(ctx);
    await writeFile(join(tmp.dir, 'config/deep/mine.txt'), 'x');
    await step.rollback(ctx);
    expect(await exists(join(tmp.dir, 'config/deep/bugsee.txt'))).toBe(false);
    expect(await exists(join(tmp.dir, 'config/deep/mine.txt'))).toBe(true);
  });

  it('flat file: no directory is created or removed', async () => {
    const ctx = makeCtx(tmp.dir);
    const step = opToStep({ op: 'write-file', path: 'flat.txt', template: '' });
    await step.apply(ctx);
    await step.rollback(ctx);
    expect(await exists(join(tmp.dir, 'flat.txt'))).toBe(false);
    expect(await exists(tmp.dir)).toBe(true);
  });

  it('is blocked when the file exists with different content, untouched', async () => {
    await mkdir(join(tmp.dir, 'config/deep'), { recursive: true });
    await writeFile(join(tmp.dir, 'config/deep/bugsee.txt'), 'mine');
    const status = await opToStep(spec).precheck(makeCtx(tmp.dir));
    expect(status).toMatchObject({ kind: 'blocked' });
    expect(status.kind === 'blocked' && status.reason).toContain('different content');
    expect(await readFile(join(tmp.dir, 'config/deep/bugsee.txt'), 'utf8')).toBe('mine');
  });

  it('defense in depth: blocks a path escaping the package dir and a token template', async () => {
    const esc = await opToStep({ op: 'write-file', path: '../x', template: '' }).precheck(
      makeCtx(tmp.dir),
    );
    expect(esc).toMatchObject({ kind: 'blocked' });
    const tok = await opToStep({ op: 'write-file', path: 'x', template: '{{token}}' }).precheck(
      makeCtx(tmp.dir),
    );
    expect(tok).toMatchObject({ kind: 'blocked' });
  });

  it('apply refuses to overwrite a file that appeared after precheck', async () => {
    const ctx = makeCtx(tmp.dir);
    const step = opToStep({ op: 'write-file', path: 'f.txt', template: 'new' });
    await writeFile(join(tmp.dir, 'f.txt'), 'old');
    await expect(step.apply(ctx)).rejects.toThrow();
    expect(await readFile(join(tmp.dir, 'f.txt'), 'utf8')).toBe('old');
    await step.rollback(ctx);
    expect(await readFile(join(tmp.dir, 'f.txt'), 'utf8')).toBe('old');
  });

  describe.skipIf(process.platform === 'win32')('symlink containment', () => {
    it('a symlinked directory pointing outside is blocked; nothing is created outside', async () => {
      const outside = join(tmp.dir, 'out');
      await mkdir(outside);
      const pkg = join(tmp.dir, 'pkg');
      await mkdir(pkg);
      await symlink(outside, join(pkg, 'config'));
      const ctx = makeCtx(pkg);
      const step = opToStep(spec);
      expect(await step.precheck(ctx)).toMatchObject({ kind: 'blocked' });
      await expect(step.apply(ctx)).rejects.toThrow(/symlink/);
      expect(await exists(join(outside, 'deep'))).toBe(false);
    });
  });
});
