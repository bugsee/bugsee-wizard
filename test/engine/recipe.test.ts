import { describe, expect, it } from 'vitest';
import { parseRecipe, RecipeError } from '../../src/engine/recipe.js';

function base(): Record<string, unknown> {
  return {
    schema: 1,
    id: 'javascript-vite',
    kind: 'buildtool',
    platform: 'javascript-vite',
    engine: { min: '1.0.0' },
    sdk: { range: '>=1.0.0' },
    detect: [{ dependency: 'vite' }, { file: 'vite.config.ts' }],
    ops: [
      { op: 'install-package', packages: ['@bugsee/vite-plugin'], dev: true, tag: 'beta' },
      {
        op: 'add-bundler-plugin',
        target: 'vite',
        importFrom: '@bugsee/vite-plugin',
        importName: 'bugsee',
        callArgs: '',
        ensureSourcemap: true,
      },
      {
        op: 'set-json-key',
        file: 'tsconfig.json',
        path: ['compilerOptions', 'sourceMap'],
        value: true,
      },
      {
        op: 'add-package-script',
        name: 'bugsee:upload',
        command: 'bugsee-cli upload',
        chainInto: 'build',
      },
      { op: 'ensure-gitignore', line: '.env.bugsee-build-plugin' },
      { op: 'write-env-var', file: '.env.bugsee-build-plugin', key: 'BUGSEE_TOKEN', from: 'token' },
      { op: 'write-file', path: 'config/bugsee.txt', template: 'hello' },
    ],
    verify: ['npm run build'],
  };
}

function violations(json: unknown): string[] {
  try {
    parseRecipe(json);
  } catch (e) {
    expect(e).toBeInstanceOf(RecipeError);
    return [...(e as RecipeError).violations];
  }
  throw new Error('expected parseRecipe to throw');
}

function withOp(op: Record<string, unknown>): Record<string, unknown> {
  return { ...base(), ops: [op] };
}

describe('parseRecipe', () => {
  it('accepts a complete valid recipe and returns it typed', () => {
    const json = base();
    expect(parseRecipe(json)).toEqual(json);
  });

  it('accepts the minimum recipe (no verify, empty lists)', () => {
    const r = parseRecipe({ ...base(), detect: [], ops: [], verify: undefined });
    expect(r.ops).toEqual([]);
    expect('verify' in r).toBe(false);
  });

  describe('notes (human-readable, optional)', () => {
    it('is kept verbatim when present', () => {
      const r = parseRecipe({ ...base(), notes: 'Uses the CLI route until JS issue #184.' });
      expect(r.notes).toBe('Uses the CLI route until JS issue #184.');
    });

    it('is absent from the parsed recipe when omitted', () => {
      expect('notes' in parseRecipe(base())).toBe(false);
    });

    it('must be a non-empty string', () => {
      expect(violations({ ...base(), notes: 7 })).toEqual(['recipe.notes: must be a string']);
      expect(violations({ ...base(), notes: '' })).toEqual(['recipe.notes: must not be empty']);
      expect(violations({ ...base(), notes: ['a'] })).toEqual(['recipe.notes: must be a string']);
    });
  });

  it('rejects a non-object root', () => {
    expect(violations(null)).toEqual(['recipe: must be an object']);
    expect(violations([])).toEqual(['recipe: must be an object']);
  });

  it('lists EVERY violation with its path, not just the first', () => {
    const v = violations({
      schema: 2,
      id: '',
      kind: 'library',
      platform: 7,
      engine: {},
      sdk: {},
      detect: 'x',
      ops: [{ op: 'rm-rf' }, { op: 'write-file', path: '/etc/passwd', template: 1 }],
    });
    expect(v).toEqual(
      expect.arrayContaining([
        expect.stringContaining('recipe.schema'),
        expect.stringContaining('recipe.id: must not be empty'),
        expect.stringContaining('recipe.kind'),
        expect.stringContaining('recipe.platform: must be a string'),
        expect.stringContaining('recipe.engine.min: is required'),
        expect.stringContaining('recipe.sdk.range: is required'),
        expect.stringContaining('recipe.detect: must be an array'),
        expect.stringContaining('recipe.ops[0].op: unknown operation "rm-rf"'),
        expect.stringContaining('recipe.ops[1].path: must be relative'),
        expect.stringContaining('recipe.ops[1].template: must be a string'),
      ]),
    );
    expect(v).toHaveLength(10);
  });

  it('the error message contains every violation', () => {
    try {
      parseRecipe({ ...base(), schema: 2, kind: 'x' });
    } catch (e) {
      const m = (e as Error).message;
      expect(m).toContain('recipe.schema');
      expect(m).toContain('recipe.kind');
      expect(m).toContain('2 problem(s)');
    }
  });

  it('rejects a missing engine / engine.min / non-semver min / missing sdk', () => {
    const { engine: _e, sdk: _s, ...rest } = base();
    expect(violations(rest)).toEqual(['recipe.engine: is required', 'recipe.sdk: is required']);
    expect(violations({ ...base(), engine: {} })).toEqual(['recipe.engine.min: is required']);
    expect(violations({ ...base(), engine: { min: 'latest' } })).toEqual([
      'recipe.engine.min: must be a semantic version',
    ]);
  });

  it('rejects unknown extra keys at every level (typos)', () => {
    expect(violations({ ...base(), idd: 'x' })).toEqual(['recipe.idd: unknown key']);
    expect(violations({ ...base(), engine: { min: '1.0.0', max: '2' } })).toEqual([
      'recipe.engine.max: unknown key',
    ]);
    expect(violations(withOp({ op: 'ensure-gitignore', line: 'a', lines: 'b' }))).toEqual([
      'recipe.ops[0].lines: unknown key',
    ]);
  });

  it('rejects bad detect rules', () => {
    expect(
      violations({ ...base(), detect: [1, {}, { dependency: 'a', file: 'b' }, { dependency: '' }] })
        .length,
    ).toBe(4);
  });

  it('detect[].file must be a safe relative path (same rule as the other file fields)', () => {
    for (const bad of [
      '/etc/passwd',
      '../x',
      'a/../../x',
      'C:\\x',
      'C:x',
      '\\srv\\x',
      'a\0b',
      '.',
    ]) {
      expect(violations({ ...base(), detect: [{ file: bad }] }), bad).toHaveLength(1);
    }
    expect(violations({ ...base(), detect: [{ file: '../x' }] })[0]).toContain(
      'recipe.detect[0].file',
    );
    expect(() => parseRecipe({ ...base(), detect: [{ file: 'a/b.config.ts' }] })).not.toThrow();
  });

  it('rejects a non-array ops / non-object op / missing ops', () => {
    expect(violations({ ...base(), ops: 5 })).toEqual(['recipe.ops: must be an array']);
    expect(violations({ ...base(), ops: [5] })).toEqual(['recipe.ops[0]: must be an object']);
    const { ops: _o, ...rest } = base();
    expect(violations(rest)).toEqual(['recipe.ops: is required']);
  });

  it('rejects a bad verify', () => {
    expect(violations({ ...base(), verify: [1] })).toEqual([
      'recipe.verify[0]: must be a non-empty string',
    ]);
  });

  describe('path-typed fields stay inside the package directory', () => {
    const cases: Array<[string, string]> = [
      ['write-file', 'path'],
      ['set-json-key', 'file'],
      ['write-env-var', 'file'],
    ];
    for (const [op, field] of cases) {
      const make = (value: string): Record<string, unknown> => ({
        op,
        [field]: value,
        ...(op === 'write-file' ? { template: '' } : {}),
        ...(op === 'set-json-key' ? { path: ['a'], value: 1 } : {}),
        ...(op === 'write-env-var' ? { key: 'K', from: 'token' } : {}),
      });
      it(`${op}.${field}: rejects absolute, drive, UNC, .., NUL and dot-only paths`, () => {
        for (const bad of [
          '/etc/x',
          '\\x',
          'C:\\x',
          'C:x',
          '../x',
          'a/../../x',
          'a\\..\\x',
          '..',
          'a\0b',
          '.',
          './',
          '',
        ]) {
          expect(violations(withOp(make(bad))), JSON.stringify(bad)).toHaveLength(1);
        }
      });
      it(`${op}.${field}: accepts nested relative paths`, () => {
        expect(() => parseRecipe(withOp(make('a/b/c.txt')))).not.toThrow();
        expect(() => parseRecipe(withOp(make('./a..b/c')))).not.toThrow();
      });
    }
  });

  it('install-package validation', () => {
    const op = (x: Record<string, unknown>): Record<string, unknown> => ({
      op: 'install-package',
      packages: ['a'],
      ...x,
    });
    expect(violations(withOp(op({ packages: [] })))).toEqual([
      'recipe.ops[0].packages: must not be empty',
    ]);
    expect(violations(withOp(op({ packages: ['--registry=evil'] })))).toEqual([
      'recipe.ops[0].packages[0]: is not a valid package name',
    ]);
    expect(violations(withOp(op({ packages: ['a b'] })))).toHaveLength(1);
    expect(violations(withOp(op({ packages: [''] })))).toHaveLength(1);
    expect(violations(withOp(op({ packages: 'a' })))).toEqual([
      'recipe.ops[0].packages: must be an array of strings',
    ]);
    const { packages: _p, ...noPkgs } = op({});
    expect(violations(withOp(noPkgs))).toEqual(['recipe.ops[0].packages: is required']);
    expect(violations(withOp(op({ tag: '--x' })))).toEqual([
      'recipe.ops[0].tag: is not a valid version or dist-tag',
    ]);
    expect(violations(withOp(op({ tag: '' })))).toHaveLength(1);
    for (const bad of [
      '^1.0.0',
      '~1.0.0',
      '>=1',
      '<2',
      '*',
      '1^2',
      '1~2',
      'a<b',
      'a>b',
      'a*',
      'a=b',
      '1 2',
      'a&b',
      'a|b',
      'a;b',
      '%x%',
      'a"b',
    ]) {
      expect(violations(withOp(op({ tag: bad }))), bad).toEqual([
        'recipe.ops[0].tag: is not a valid version or dist-tag',
      ]);
    }
    for (const ok of ['beta', 'latest', '1.2.3', '1.2.3-beta.1', 'next_2']) {
      expect(() => parseRecipe(withOp(op({ tag: ok }))), ok).not.toThrow();
    }
    expect(violations(withOp(op({ dev: 'yes' })))).toEqual([
      'recipe.ops[0].dev: must be a boolean',
    ]);
    expect(() =>
      parseRecipe(withOp(op({ packages: ['@scope/pkg', 'plain'], tag: '1.2.3-beta.1' }))),
    ).not.toThrow();
  });

  it('add-bundler-plugin validation', () => {
    const op = (x: Record<string, unknown>): Record<string, unknown> => ({
      op: 'add-bundler-plugin',
      target: 'rspack',
      importFrom: 'p',
      importName: 'bugsee',
      callArgs: '{}',
      ...x,
    });
    expect(() => parseRecipe(withOp(op({})))).not.toThrow();
    expect(violations(withOp(op({ target: 'parcel' })))).toEqual([
      'recipe.ops[0].target: must be one of vite, webpack, rollup, rspack',
    ]);
    expect(violations(withOp(op({ importFrom: '' })))).toEqual([
      'recipe.ops[0].importFrom: must not be empty',
    ]);
    expect(violations(withOp(op({ importName: 'a b' })))).toEqual([
      'recipe.ops[0].importName: must be a valid identifier',
    ]);
    expect(violations(withOp(op({ callArgs: 1 })))).toEqual([
      'recipe.ops[0].callArgs: must be a string',
    ]);
    expect(violations(withOp(op({ ensureSourcemap: 'y' })))).toEqual([
      'recipe.ops[0].ensureSourcemap: must be a boolean',
    ]);
  });

  it('set-json-key validation', () => {
    expect(violations(withOp({ op: 'set-json-key', file: 'a.json', path: [] }))).toEqual([
      'recipe.ops[0].path: must not be empty',
      'recipe.ops[0].value: is required',
    ]);
    expect(violations(withOp({ op: 'set-json-key', file: 'a.json', path: [1], value: 1 }))).toEqual(
      ['recipe.ops[0].path[0]: must be a non-empty string'],
    );
    expect(() =>
      parseRecipe(withOp({ op: 'set-json-key', file: 'a.json', path: ['a'], value: null })),
    ).not.toThrow();
  });

  it('add-package-script validation', () => {
    expect(
      violations(withOp({ op: 'add-package-script', name: 'a', command: 'x', chainInto: 'a' })),
    ).toEqual(['recipe.ops[0].chainInto: must differ from name']);
    expect(violations(withOp({ op: 'add-package-script', name: '', command: '' }))).toHaveLength(2);
  });

  it('ensure-gitignore: empty, blank and multi-line are rejected', () => {
    for (const line of ['', '   ', 'a\nb', 'a\rb']) {
      expect(
        violations(withOp({ op: 'ensure-gitignore', line })),
        JSON.stringify(line),
      ).toHaveLength(1);
    }
    expect(violations(withOp({ op: 'ensure-gitignore', line: 'a\nb' }))).toEqual([
      'recipe.ops[0].line: must not contain a newline',
    ]);
  });

  it("write-env-var: from must be 'token' and key an env name", () => {
    const op = (x: Record<string, unknown>): Record<string, unknown> => ({
      op: 'write-env-var',
      file: '.e',
      key: 'K',
      from: 'token',
      ...x,
    });
    expect(violations(withOp(op({ from: 'env' })))).toEqual([
      "recipe.ops[0].from: must be 'token'",
    ]);
    expect(violations(withOp(op({ from: undefined })))).toEqual([
      "recipe.ops[0].from: must be 'token'",
    ]);
    expect(violations(withOp(op({ key: 'A=B' })))).toEqual([
      'recipe.ops[0].key: is not a valid environment variable name',
    ]);
  });

  it('write-file: templates may not contain the token placeholder; empty content is fine', () => {
    expect(
      violations(withOp({ op: 'write-file', path: 'a', template: 'x {{token}}' })),
    ).toHaveLength(1);
    expect(() => parseRecipe(withOp({ op: 'write-file', path: 'a', template: '' }))).not.toThrow();
  });
});
