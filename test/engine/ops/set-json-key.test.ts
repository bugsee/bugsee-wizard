import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { opToStep } from '../../../src/engine/ops/index.js';
import type { OpSpec } from '../../../src/engine/recipe.js';
import { makeCtx, makeTmp } from '../helpers.js';

const spec: OpSpec = {
  op: 'set-json-key',
  file: 'tsconfig.json',
  path: ['compilerOptions', 'sourceMap'],
  value: true,
};
let tmp: Awaited<ReturnType<typeof makeTmp>>;
beforeEach(async () => {
  tmp = await makeTmp();
});
afterEach(() => tmp.cleanup());

const ORIGINAL =
  '{\r\n\t// keep me\r\n\t"compilerOptions": {\r\n\t\t"strict": true,\r\n\t},\r\n}\r\n';

describe('set-json-key op', () => {
  it('id and title', () => {
    const step = opToStep(spec);
    expect(step.id).toBe('set-json-key:tsconfig.json#compilerOptions.sourceMap');
    expect(step.title).toContain('compilerOptions.sourceMap');
  });

  it('sets the key keeping comments/EOL; rollback restores exact bytes; second run satisfied', async () => {
    await writeFile(join(tmp.dir, 'tsconfig.json'), ORIGINAL);
    const ctx = makeCtx(tmp.dir);
    const step = opToStep(spec);
    expect(await step.precheck(ctx)).toEqual({ kind: 'pending' });
    await step.apply(ctx);
    const after = await readFile(join(tmp.dir, 'tsconfig.json'), 'utf8');
    expect(after).toContain('// keep me');
    expect(after).toContain('"sourceMap": true');
    expect(after).toContain('\r\n');
    expect(ctx.entries).toEqual([
      { file: 'tsconfig.json', action: 'edited', before: ORIGINAL, after },
    ]);
    expect(await step.precheck(ctx)).toEqual({ kind: 'satisfied' });
    await step.rollback(ctx);
    expect(await readFile(join(tmp.dir, 'tsconfig.json'), 'utf8')).toBe(ORIGINAL);
  });

  it('a missing file yields a manual snippet (nested JSON) and writes nothing', async () => {
    const ctx = makeCtx(tmp.dir);
    const step = opToStep(spec);
    expect(await step.precheck(ctx)).toEqual({ kind: 'pending' });
    const res = await step.apply(ctx);
    expect(res?.manual?.file).toBe('tsconfig.json');
    expect(JSON.parse(res?.manual?.code ?? '')).toEqual({ compilerOptions: { sourceMap: true } });
    expect(ctx.entries).toEqual([{ file: 'tsconfig.json', action: 'manual' }]);
    await expect(readFile(join(tmp.dir, 'tsconfig.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await step.rollback(ctx);
  });

  it('is satisfied when the value is already there and records nothing on apply', async () => {
    const src = '{ "compilerOptions": { "sourceMap": true } }';
    await writeFile(join(tmp.dir, 'tsconfig.json'), src);
    const ctx = makeCtx(tmp.dir);
    const step = opToStep(spec);
    expect(await step.precheck(ctx)).toEqual({ kind: 'satisfied' });
    await step.apply(ctx);
    expect(ctx.entries).toEqual([]);
    expect(await readFile(join(tmp.dir, 'tsconfig.json'), 'utf8')).toBe(src);
  });

  it('fails (file untouched) when the existing file is not valid JSON-C', async () => {
    await writeFile(join(tmp.dir, 'tsconfig.json'), '{ "a": ');
    const ctx = makeCtx(tmp.dir);
    await expect(opToStep(spec).apply(ctx)).rejects.toThrow(/Refusing to write/);
    expect(await readFile(join(tmp.dir, 'tsconfig.json'), 'utf8')).toBe('{ "a": ');
  });

  it('is blocked for a file escaping the package dir', async () => {
    const status = await opToStep({ ...spec, file: '../x.json' } as OpSpec).precheck(
      makeCtx(tmp.dir),
    );
    expect(status).toMatchObject({ kind: 'blocked' });
  });

  it('rollback before apply is a no-op', async () => {
    await writeFile(join(tmp.dir, 'tsconfig.json'), ORIGINAL);
    await opToStep(spec).rollback(makeCtx(tmp.dir));
    expect(await readFile(join(tmp.dir, 'tsconfig.json'), 'utf8')).toBe(ORIGINAL);
  });

  describe.skipIf(process.platform === 'win32')('symlink containment', () => {
    it('a symlinked json file pointing outside is blocked and never written', async () => {
      const outside = join(tmp.dir, 'outside.json');
      await writeFile(outside, '{}');
      const pkg = join(tmp.dir, 'pkg');
      await mkdir(pkg);
      await symlink(outside, join(pkg, 'tsconfig.json'));
      const ctx = makeCtx(pkg);
      expect(await opToStep(spec).precheck(ctx)).toMatchObject({ kind: 'blocked' });
      await expect(opToStep(spec).apply(ctx)).rejects.toThrow(/symlink/);
      expect(await readFile(outside, 'utf8')).toBe('{}');
    });
  });
});
