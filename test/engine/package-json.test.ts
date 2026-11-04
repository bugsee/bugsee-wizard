import { readdir, readFile, writeFile } from 'node:fs/promises';
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

interface Fx {
  text: string;
  I: string;
  eol: string;
}

/** A document full of spellings JSON.stringify would normalize. */
function mk(opts: { I: string; eol?: string; bom?: boolean; trailing?: boolean }): Fx {
  const { I } = opts;
  const eol = opts.eol ?? '\n';
  const lines = [
    '{',
    `${I}"files": ["dist"],`,
    `${I}"num": 1.0,`,
    `${I}"exp": 1e3,`,
    `${I}"uni": "é\\/\\u00e9",`,
    `${I}"scripts": {`,
    `${I}${I}"x": "1",`,
    `${I}${I}"y": 2`,
    `${I}},`,
    `${I}"compact": {"a": 1, "b": [1, 2]},`,
    `${I}"name": "x"`,
    '}',
  ];
  const text = (opts.bom ? '﻿' : '') + lines.join(eol) + (opts.trailing === false ? '' : eol);
  return { text, I, eol };
}

const fixtures: Record<string, Fx> = {
  twoSpaces: mk({ I: '  ' }),
  fourSpaces: mk({ I: '    ' }),
  tabs: mk({ I: '\t' }),
  crlf: mk({ I: '  ', eol: '\r\n' }),
  crlfTabs: mk({ I: '\t', eol: '\r\n' }),
  bom: mk({ I: '  ', bom: true }),
  noTrailingNewline: mk({ I: '  ', trailing: false }),
  everything: mk({ I: '\t', eol: '\r\n', bom: true, trailing: false }),
};

async function setup(text: string) {
  const p = join(dir, 'package.json');
  await writeFile(p, text);
  return { p, h: await readPackageJson(p) };
}
const read = (p: string) => readFile(p, 'utf8');

describe('readPackageJson targeted edits', () => {
  for (const [name, fx] of Object.entries(fixtures)) {
    describe(name, () => {
      it('is byte-identical when nothing changes', async () => {
        const { p, h } = await setup(fx.text);
        await h.write(h.data);
        expect(await read(p)).toBe(fx.text);
      });

      it('changing a top-level key changes only that value', async () => {
        const { p, h } = await setup(fx.text);
        await h.write({ ...h.data, name: 'changed' });
        expect(await read(p)).toBe(fx.text.replace('"name": "x"', '"name": "changed"'));
      });

      it('changing a nested key (scripts.x) changes only that value', async () => {
        const { p, h } = await setup(fx.text);
        await h.write({ ...h.data, scripts: { x: '2', y: 2 } });
        expect(await read(p)).toBe(fx.text.replace('"x": "1"', '"x": "2"'));
      });

      it('replacing a compact array leaves compact formatting and all else untouched', async () => {
        const { p, h } = await setup(fx.text);
        await h.write({ ...h.data, files: ['dist', 'lib'] });
        expect(await read(p)).toBe(fx.text.replace('["dist"]', '["dist","lib"]'));
      });

      it('adding a top-level key changes only the insertion', async () => {
        const { p, h } = await setup(fx.text);
        await h.write({ ...h.data, extra: true });
        expect(await read(p)).toBe(
          fx.text.replace('"name": "x"', `"name": "x",${fx.eol}${fx.I}"extra": true`),
        );
      });

      it('adding a nested key changes only the insertion', async () => {
        const { p, h } = await setup(fx.text);
        await h.write({ ...h.data, scripts: { x: '1', y: 2, z: '3' } });
        const ii = fx.I + fx.I;
        expect(await read(p)).toBe(fx.text.replace('"y": 2', `"y": 2,${fx.eol}${ii}"z": "3"`));
      });

      it('adding an object value to a new key is pretty-printed with the file style', async () => {
        const { p, h } = await setup(fx.text);
        await h.write({ ...h.data, extra: { a: 1 } });
        const inserted = `"name": "x",${fx.eol}${fx.I}"extra": {${fx.eol}${fx.I}${fx.I}"a": 1${fx.eol}${fx.I}}`;
        expect(await read(p)).toBe(fx.text.replace('"name": "x"', inserted));
      });

      it('leaves no temp files', async () => {
        const { h } = await setup(fx.text);
        await h.write({ ...h.data, name: 'y' });
        expect(await readdir(dir)).toEqual(['package.json']);
      });
    });
  }

  it('preserves mixed indentation outside the edit', async () => {
    const text = '{\n\t"a": 1,\n  "b": {"c": 2},\n\t"name": "x"\n}\n';
    const { p, h } = await setup(text);
    await h.write({ ...h.data, name: 'y' });
    expect(await read(p)).toBe(text.replace('"x"', '"y"'));
  });

  it('keeps odd key order and appends new keys last', async () => {
    const text = '{\n  "zeta": 1,\n  "name": "x",\n  "alpha": {\n    "b": 2,\n    "a": 1\n  }\n}\n';
    const { p, h } = await setup(text);
    await h.write({ ...h.data, extra: true });
    expect(await read(p)).toBe(text.replace('  }\n}', '  },\n  "extra": true\n}'));
  });

  it('inserts into a single-line document keeping it single-line', async () => {
    const { p, h } = await setup('{"name":"x"}');
    await h.write({ ...h.data, a: 1 });
    expect(await read(p)).toBe('{"name":"x", "a": 1}');
  });

  it('inserts into an empty object', async () => {
    const text = '{\n  "scripts": {},\n  "name": "x"\n}\n';
    const { p, h } = await setup(text);
    await h.write({ ...h.data, scripts: { a: 'b' } });
    expect(await read(p)).toBe('{\n  "scripts": {\n    "a": "b"\n  },\n  "name": "x"\n}\n');
  });

  it('defaults to a 2-space unit when the file gives no indentation hint', async () => {
    const { p, h } = await setup('{"scripts":{},"name":"x"}');
    await h.write({ ...h.data, scripts: { a: 'b' } });
    expect(await read(p)).toBe('{"scripts":{\n  "a": "b"\n},"name":"x"}');
  });

  it('replaces a multi-line value pretty-printed with the file style', async () => {
    const text = '{\n  "files": [\n    "a"\n  ],\n  "name": "x"\n}\n';
    const { p, h } = await setup(text);
    await h.write({ ...h.data, files: ['a', 'b'] });
    expect(await read(p)).toBe('{\n  "files": [\n    "a",\n    "b"\n  ],\n  "name": "x"\n}\n');
  });

  it('removes a key, leaving the rest valid', async () => {
    const { p, h } = await setup('{\n  "a": 1,\n  "b": 2\n}\n');
    const { b, ...rest } = h.data;
    expect(b).toBe(2);
    await h.write(rest);
    expect(JSON.parse(await read(p))).toEqual({ a: 1 });
  });

  it('treats undefined values as absent', async () => {
    const text = '{\n  "a": 1\n}\n';
    const { p, h } = await setup(text);
    await h.write({ ...h.data, b: undefined });
    expect(await read(p)).toBe(text);
  });

  it('throws and leaves the file untouched when the edited output would not equal the intent', async () => {
    // The file drifted after it was read: applying our edit would leave a:999, but the
    // caller intends a:1. Validation must catch the mismatch instead of writing.
    const { p, h } = await setup('{\n  "a": 1,\n  "name": "x"\n}\n');
    const drifted = '{\n  "a": 999,\n  "name": "x"\n}\n';
    await writeFile(p, drifted);
    await expect(h.write({ ...h.data, name: 'y' })).rejects.toThrow(/validation/);
    expect(await read(p)).toBe(drifted);
    expect(await readdir(dir)).toEqual(['package.json']);
  });

  it('exposes parsed data', async () => {
    const { h } = await setup('{\n\t"name": "x",\n\t"version": "1.0.0"\n}\n');
    expect(h.data).toEqual({ name: 'x', version: '1.0.0' });
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
});
