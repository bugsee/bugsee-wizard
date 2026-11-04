import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { opToStep } from '../../../src/engine/ops/index.js';
import type { OpSpec } from '../../../src/engine/recipe.js';
import { makeCtx, makeTmp } from '../helpers.js';

const spec: OpSpec = {
  op: 'write-env-var',
  file: '.env.bugsee-build-plugin',
  key: 'BUGSEE_TOKEN',
  from: 'token',
};
const FILE = '.env.bugsee-build-plugin';
let tmp: Awaited<ReturnType<typeof makeTmp>>;
beforeEach(async () => {
  tmp = await makeTmp();
});
afterEach(() => tmp.cleanup());

describe('write-env-var op', () => {
  it('id and title never include the token', () => {
    const step = opToStep(spec);
    expect(step.id).toBe(`write-env-var:${FILE}:BUGSEE_TOKEN`);
    expect(step.title).toContain('BUGSEE_TOKEN');
    expect(step.title + step.id).not.toContain('tok_SECRET');
  });

  it('creates the file 0600 with the token; no log, manifest after-text or error carries it', async () => {
    const ctx = makeCtx(tmp.dir);
    const step = opToStep(spec);
    expect(await step.precheck(ctx)).toEqual({ kind: 'pending' });
    const res = await step.apply(ctx);
    expect(res).toBeUndefined();
    expect(await readFile(join(tmp.dir, FILE), 'utf8')).toContain('BUGSEE_TOKEN=tok_SECRET_123');
    expect((await stat(join(tmp.dir, FILE))).mode & 0o777).toBe(0o600);
    expect(ctx.entries).toEqual([{ file: FILE, action: 'created', marker: 'env:BUGSEE_TOKEN' }]);
    expect(JSON.stringify(ctx.entries) + ctx.logs.join('\n')).not.toContain('tok_SECRET');
    expect(await step.precheck(ctx)).toEqual({ kind: 'satisfied' });
    await step.rollback(ctx);
    await expect(readFile(join(tmp.dir, FILE))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('appends to an existing file; rollback restores the exact bytes', async () => {
    const original = 'OTHER=1';
    await writeFile(join(tmp.dir, FILE), original);
    const ctx = makeCtx(tmp.dir);
    const step = opToStep(spec);
    await step.apply(ctx);
    expect(await readFile(join(tmp.dir, FILE), 'utf8')).toContain('BUGSEE_TOKEN=tok_SECRET_123');
    expect(ctx.entries).toEqual([{ file: FILE, action: 'edited', marker: 'env:BUGSEE_TOKEN' }]);
    // the pre-existing contents (possibly unrelated secrets) never reach the manifest
    expect(JSON.stringify(ctx.entries)).not.toContain(original);
    await step.rollback(ctx);
    expect(await readFile(join(tmp.dir, FILE), 'utf8')).toBe(original);
  });

  it('a different existing value yields a manual snippet without the token, file untouched', async () => {
    await writeFile(join(tmp.dir, FILE), 'BUGSEE_TOKEN=other_value\n');
    const ctx = makeCtx(tmp.dir);
    const step = opToStep(spec);
    expect(await step.precheck(ctx)).toEqual({ kind: 'pending' });
    const res = await step.apply(ctx);
    expect(res?.manual).toBeDefined();
    expect(res?.manual?.file).toBe(FILE);
    expect(res?.manual?.code).toContain('BUGSEE_TOKEN=');
    expect(JSON.stringify(res) + ctx.logs.join('\n') + JSON.stringify(ctx.entries)).not.toContain(
      'tok_SECRET',
    );
    expect(ctx.entries).toEqual([{ file: FILE, action: 'manual' }]);
    expect(await readFile(join(tmp.dir, FILE), 'utf8')).toBe('BUGSEE_TOKEN=other_value\n');
  });

  it('an identical existing value is satisfied and a re-apply changes nothing', async () => {
    await writeFile(join(tmp.dir, FILE), 'BUGSEE_TOKEN=tok_SECRET_123\n');
    const ctx = makeCtx(tmp.dir);
    const step = opToStep(spec);
    expect(await step.precheck(ctx)).toEqual({ kind: 'satisfied' });
    expect(await step.apply(ctx)).toBeUndefined();
    expect(ctx.entries).toEqual([]);
  });

  it('is blocked without a token, with the reason free of any value', async () => {
    const status = await opToStep(spec).precheck(makeCtx(tmp.dir, { token: '' }));
    expect(status).toMatchObject({ kind: 'blocked' });
  });

  it('is blocked when the file path escapes the package dir', async () => {
    const status = await opToStep({ ...spec, file: '../x' } as OpSpec).precheck(makeCtx(tmp.dir));
    expect(status).toMatchObject({ kind: 'blocked' });
  });

  it('precheck leaves no copy of the secret behind and never touches the real file', async () => {
    await writeFile(join(tmp.dir, FILE), 'A=1\n');
    await opToStep(spec).precheck(makeCtx(tmp.dir));
    expect(await readFile(join(tmp.dir, FILE), 'utf8')).toBe('A=1\n');
  });

  it('rollback before apply is a no-op', async () => {
    await writeFile(join(tmp.dir, FILE), 'A=1\n');
    await opToStep(spec).rollback(makeCtx(tmp.dir));
    expect(await readFile(join(tmp.dir, FILE), 'utf8')).toBe('A=1\n');
  });

  describe.skipIf(process.platform === 'win32')('symlink containment', () => {
    it('a symlinked env file pointing outside is blocked and the target is never written', async () => {
      const outside = join(tmp.dir, 'zshrc');
      await writeFile(outside, 'export A=1\n');
      const pkg = join(tmp.dir, 'pkg');
      await mkdir(pkg);
      await symlink(outside, join(pkg, FILE));
      const ctx = makeCtx(pkg);
      const step = opToStep(spec);
      const status = await step.precheck(ctx);
      expect(status).toMatchObject({ kind: 'blocked' });
      expect(status.kind === 'blocked' && status.reason).toContain('symlink');
      await expect(step.apply(ctx)).rejects.toThrow(/symlink/);
      expect(await readFile(outside, 'utf8')).toBe('export A=1\n');
    });

    it('a symlink that stays inside the package dir is fine', async () => {
      await writeFile(join(tmp.dir, 'real.env'), '');
      await symlink(join(tmp.dir, 'real.env'), join(tmp.dir, FILE));
      const ctx = makeCtx(tmp.dir);
      await opToStep(spec).apply(ctx);
      expect(await readFile(join(tmp.dir, 'real.env'), 'utf8')).toContain('BUGSEE_TOKEN=');
    });
  });
});
