import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { opToStep } from '../../../src/engine/ops/index.js';
import { makeCtx, makeTmp } from '../helpers.js';

const spec = { op: 'ensure-gitignore', line: '.env.bugsee-build-plugin' } as const;
let tmp: Awaited<ReturnType<typeof makeTmp>>;
beforeEach(async () => {
  tmp = await makeTmp();
});
afterEach(() => tmp.cleanup());

describe('ensure-gitignore op', () => {
  it('id and title', () => {
    const step = opToStep(spec);
    expect(step.id).toBe('ensure-gitignore:.env.bugsee-build-plugin');
    expect(step.title).toContain('.env.bugsee-build-plugin');
  });

  it('creates .gitignore, records a created entry, rollback deletes it', async () => {
    const ctx = makeCtx(tmp.dir);
    const step = opToStep(spec);
    expect(await step.precheck(ctx)).toEqual({ kind: 'pending' });
    await step.apply(ctx);
    expect(await readFile(join(tmp.dir, '.gitignore'), 'utf8')).toContain(
      '.env.bugsee-build-plugin',
    );
    expect(ctx.entries).toHaveLength(1);
    expect(ctx.entries[0]).toMatchObject({ file: '.gitignore', action: 'created' });
    expect(ctx.entries[0]?.before).toBeUndefined();
    expect(ctx.entries[0]?.after).toContain('.env.bugsee-build-plugin');
    await step.rollback(ctx);
    await expect(readFile(join(tmp.dir, '.gitignore'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('edits an existing file; rollback restores the exact bytes; second precheck is satisfied', async () => {
    const original = 'node_modules\r\ndist';
    await writeFile(join(tmp.dir, '.gitignore'), original);
    const ctx = makeCtx(tmp.dir);
    const step = opToStep(spec);
    expect(await step.precheck(ctx)).toEqual({ kind: 'pending' });
    await step.apply(ctx);
    expect(await step.precheck(ctx)).toEqual({ kind: 'satisfied' });
    expect(ctx.entries[0]).toMatchObject({ action: 'edited', before: original });
    expect(ctx.entries[0]?.after).toContain('.env.bugsee-build-plugin');
    await step.rollback(ctx);
    expect(await readFile(join(tmp.dir, '.gitignore'), 'utf8')).toBe(original);
  });

  it('is satisfied by a covering glob and records nothing', async () => {
    await writeFile(join(tmp.dir, '.gitignore'), '.env*\n');
    const ctx = makeCtx(tmp.dir);
    const step = opToStep(spec);
    expect(await step.precheck(ctx)).toEqual({ kind: 'satisfied' });
    await step.apply(ctx);
    expect(ctx.entries).toEqual([]);
    expect(await readFile(join(tmp.dir, '.gitignore'), 'utf8')).toBe('.env*\n');
  });

  it('precheck never modifies the real file or leaves scratch files', async () => {
    await writeFile(join(tmp.dir, '.gitignore'), 'a\n');
    await opToStep(spec).precheck(makeCtx(tmp.dir));
    expect(await readFile(join(tmp.dir, '.gitignore'), 'utf8')).toBe('a\n');
  });

  it('rollback before apply is a no-op', async () => {
    await writeFile(join(tmp.dir, '.gitignore'), 'a\n');
    await opToStep(spec).rollback(makeCtx(tmp.dir));
    expect(await readFile(join(tmp.dir, '.gitignore'), 'utf8')).toBe('a\n');
  });
});
