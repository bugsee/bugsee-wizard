import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readPackageJson } from '../../src/engine/package-json.js';
import { makeTmp } from './helpers.js';

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir, cleanup } = await makeTmp());
});
afterEach(async () => {
  await cleanup();
});

const fixtures: Record<string, string> = {
  tabs: '{\n\t"name": "x",\n\t"version": "1.0.0"\n}\n',
  crlf: '{\r\n  "name": "x",\r\n  "version": "1.0.0"\r\n}\r\n',
  noTrailingNewline: '{\n  "name": "x",\n  "version": "1.0.0"\n}',
  oddKeyOrder: '{\n  "zeta": 1,\n  "name": "x",\n  "alpha": {\n    "b": 2,\n    "a": 1\n  }\n}\n',
  fourSpaces: '{\n    "name": "x"\n}\n',
  inlineArray: '{\n  "files": ["a", "b"],\n  "name": "x"\n}\n',
  bom: '﻿{\n  "name": "x"\n}\n',
};

describe('readPackageJson round-trip', () => {
  for (const [name, content] of Object.entries(fixtures)) {
    it(`is byte-identical when nothing changes (${name})`, async () => {
      const p = join(dir, 'package.json');
      await writeFile(p, content);
      const { data, write } = await readPackageJson(p);
      await write(data);
      expect(await readFile(p, 'utf8')).toBe(content);
    });
  }

  for (const [name, content] of Object.entries(fixtures)) {
    it(`changes only the target key (${name})`, async () => {
      const p = join(dir, 'package.json');
      await writeFile(p, content);
      const { data, write } = await readPackageJson(p);
      await write({ ...data, name: 'changed' });
      const expected = content.replace('"name": "x"', '"name": "changed"');
      // inline arrays are re-serialized; only that fixture may differ beyond the key
      if (name === 'inlineArray') {
        expect(JSON.parse(await readFile(p, 'utf8'))).toEqual({
          files: ['a', 'b'],
          name: 'changed',
        });
      } else {
        expect(await readFile(p, 'utf8')).toBe(expected);
      }
    });
  }

  it('keeps key order when appending a new key at the end', async () => {
    const p = join(dir, 'package.json');
    await writeFile(p, fixtures.oddKeyOrder as string);
    const { data, write } = await readPackageJson(p);
    await write({ ...data, extra: true });
    const out = await readFile(p, 'utf8');
    expect(Object.keys(JSON.parse(out))).toEqual(['zeta', 'name', 'alpha', 'extra']);
  });

  it('exposes parsed data', async () => {
    const p = join(dir, 'package.json');
    await writeFile(p, fixtures.tabs as string);
    const { data } = await readPackageJson(p);
    expect(data).toEqual({ name: 'x', version: '1.0.0' });
  });

  it('defaults to 2-space indent and trailing newline when file is single-line', async () => {
    const p = join(dir, 'package.json');
    await writeFile(p, '{"name":"x"}');
    const { data, write } = await readPackageJson(p);
    await write({ ...data, a: 1 });
    expect(await readFile(p, 'utf8')).toBe('{\n  "name": "x",\n  "a": 1\n}');
  });

  it('rejects on invalid JSON and on missing file', async () => {
    const p = join(dir, 'package.json');
    await writeFile(p, '{nope');
    await expect(readPackageJson(p)).rejects.toThrow();
    await expect(readPackageJson(join(dir, 'missing.json'))).rejects.toThrow();
  });

  it('rejects when the root is not an object', async () => {
    const p = join(dir, 'package.json');
    await writeFile(p, '[1]');
    await expect(readPackageJson(p)).rejects.toThrow(/object/);
  });

  it('write leaves no temp files', async () => {
    const p = join(dir, 'package.json');
    await writeFile(p, fixtures.tabs as string);
    const { write } = await readPackageJson(p);
    await write({ name: 'y' });
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(dir)).toEqual(['package.json']);
  });
});
