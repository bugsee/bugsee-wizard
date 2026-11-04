import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setEnvVar } from '../../src/engine/env-file.js';
import { makeTmp } from './helpers.js';

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir, cleanup } = await makeTmp());
});
afterEach(async () => {
  await cleanup();
});
const f = () => join(dir, '.env.bugsee-build-plugin');

describe('setEnvVar', () => {
  it('creates a missing file', async () => {
    expect(await setEnvVar(f(), 'TOKEN', 'abc')).toBe('added');
    expect(await readFile(f(), 'utf8')).toMatch(/^TOKEN=abc\r?\n$/);
  });

  it('appends, preserving LF and the trailing newline', async () => {
    await writeFile(f(), 'A=1\n');
    expect(await setEnvVar(f(), 'TOKEN', 'abc')).toBe('added');
    expect(await readFile(f(), 'utf8')).toBe('A=1\nTOKEN=abc\n');
  });

  it('appends, preserving CRLF', async () => {
    await writeFile(f(), 'A=1\r\nB=2\r\n');
    await setEnvVar(f(), 'TOKEN', 'abc');
    expect(await readFile(f(), 'utf8')).toBe('A=1\r\nB=2\r\nTOKEN=abc\r\n');
  });

  it('preserves a missing trailing newline by not inventing one', async () => {
    await writeFile(f(), 'A=1');
    await setEnvVar(f(), 'TOKEN', 'abc');
    expect(await readFile(f(), 'utf8')).toBe('A=1\nTOKEN=abc');
  });

  it('returns present for an identical value and does not touch the file', async () => {
    const c = 'A=1\r\nTOKEN=abc\r\n';
    await writeFile(f(), c);
    expect(await setEnvVar(f(), 'TOKEN', 'abc')).toBe('present');
    expect(await readFile(f(), 'utf8')).toBe(c);
  });

  it('returns conflict and does not overwrite a different value', async () => {
    const c = 'TOKEN=old\n';
    await writeFile(f(), c);
    expect(await setEnvVar(f(), 'TOKEN', 'new')).toBe('conflict');
    expect(await readFile(f(), 'utf8')).toBe(c);
  });

  it('understands export prefix, spaces and quotes when comparing', async () => {
    await writeFile(f(), 'export TOKEN = "abc"\n');
    expect(await setEnvVar(f(), 'TOKEN', 'abc')).toBe('present');
    await writeFile(f(), "TOKEN='abc'\n");
    expect(await setEnvVar(f(), 'TOKEN', 'abc')).toBe('present');
    await writeFile(f(), 'TOKEN=abc \r\n');
    expect(await setEnvVar(f(), 'TOKEN', 'abc')).toBe('present');
  });

  it('does not match other keys sharing a prefix or commented lines', async () => {
    await writeFile(f(), '# TOKEN=old\nTOKEN_2=x\nMY_TOKEN=y\n');
    expect(await setEnvVar(f(), 'TOKEN', 'abc')).toBe('added');
    expect(await readFile(f(), 'utf8')).toBe('# TOKEN=old\nTOKEN_2=x\nMY_TOKEN=y\nTOKEN=abc\n');
  });

  it('quotes values that need it and recognizes them again', async () => {
    expect(await setEnvVar(f(), 'K', 'a b#c')).toBe('added');
    expect(await readFile(f(), 'utf8')).toMatch(/^K="a b#c"\r?\n$/);
    expect(await setEnvVar(f(), 'K', 'a b#c')).toBe('present');
    expect(await setEnvVar(f(), 'K', 'other')).toBe('conflict');
  });

  it('escapes embedded quotes and backslashes in quoted values and round-trips them', async () => {
    const v = 'say "hi" \\ there';
    await setEnvVar(f(), 'K', v);
    expect(await readFile(f(), 'utf8')).toMatch(/^K="say \\"hi\\" \\\\ there"\r?\n$/);
    expect(await setEnvVar(f(), 'K', v)).toBe('present');
  });

  it('quotes an empty value', async () => {
    await setEnvVar(f(), 'K', '');
    expect(await readFile(f(), 'utf8')).toMatch(/^K=""\r?\n$/);
    expect(await setEnvVar(f(), 'K', '')).toBe('present');
  });

  it.skipIf(process.platform === 'win32')(
    'creates the file owner-only (token is a secret)',
    async () => {
      await setEnvVar(f(), 'TOKEN', 'abc');
      expect((await stat(f())).mode & 0o777).toBe(0o600);
    },
  );

  it('rejects an invalid key', async () => {
    await expect(setEnvVar(f(), 'bad key', 'x')).rejects.toThrow(/key/i);
  });

  it('does not put the value in thrown error messages', async () => {
    await expect(setEnvVar(f(), 'bad key', 'SECRETVALUE')).rejects.not.toThrow(/SECRETVALUE/);
  });
});
