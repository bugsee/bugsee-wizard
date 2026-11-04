import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addBundlerPlugin,
  findConfigFile,
  hasBugseeMarker,
  type PluginTarget,
  setJsonCKey,
} from '../../src/engine/config-ast.js';
import { makeTmp } from './helpers.js';

const fixturesDir = fileURLToPath(new URL('../fixtures/configs/', import.meta.url));
const fx = (rel: string): string => readFileSync(join(fixturesDir, rel), 'utf8');

const spec = {
  importFrom: '@bugsee/vite-plugin',
  importName: 'bugsee',
  callArgs: "{ appToken: 'T' }",
};
const MARK = '// bugsee-wizard';

function apply(rel: string, target: PluginTarget): ReturnType<typeof addBundlerPlugin> {
  return addBundlerPlugin(fx(rel), target, spec);
}

describe('findConfigFile', () => {
  let tmp: Awaited<ReturnType<typeof makeTmp>>;
  beforeEach(async () => {
    tmp = await makeTmp();
  });
  afterEach(async () => {
    await tmp.cleanup();
  });

  it('returns undefined when nothing exists', async () => {
    expect(await findConfigFile(tmp.dir, 'vite.config')).toBeUndefined();
  });

  it('finds each extension', async () => {
    for (const ext of ['ts', 'mts', 'js', 'mjs', 'cjs', 'cts']) {
      const dir = join(tmp.dir, ext);
      await mkdir(dir);
      await writeFile(join(dir, `vite.config.${ext}`), '');
      expect(await findConfigFile(dir, 'vite.config')).toBe(join(dir, `vite.config.${ext}`));
    }
  });

  it('prefers .ts over .mts over .js over .mjs over .cjs over .cts', async () => {
    const order = ['cts', 'cjs', 'mjs', 'js', 'mts', 'ts'];
    for (const ext of order) {
      await writeFile(join(tmp.dir, `a.config.${ext}`), '');
      expect(await findConfigFile(tmp.dir, 'a.config')).toBe(join(tmp.dir, `a.config.${ext}`));
    }
  });
});

describe('hasBugseeMarker', () => {
  it('detects line and block comments', () => {
    expect(hasBugseeMarker("import x from 'y'; // bugsee-wizard\n")).toBe(true);
    expect(hasBugseeMarker('/* bugsee-wizard */\nfoo()')).toBe(true);
  });
  it('ignores the text inside strings, templates and plain code', () => {
    expect(hasBugseeMarker("const a = '// bugsee-wizard';")).toBe(false);
    expect(hasBugseeMarker('const a = "x // bugsee-wizard";')).toBe(false);
    expect(hasBugseeMarker('const a = `// bugsee-wizard`;')).toBe(false);
    expect(hasBugseeMarker("const a = 'it\\'s'; // other\n")).toBe(false);
    expect(hasBugseeMarker('const bugsee-wizard = 1')).toBe(false);
    expect(hasBugseeMarker('')).toBe(false);
  });
  it('requires the marker as a whole word', () => {
    expect(hasBugseeMarker('// bugsee-wizard-foo')).toBe(false);
    expect(hasBugseeMarker('// my-bugsee-wizard')).toBe(false);
    expect(hasBugseeMarker('/* bugsee-wizardry */')).toBe(false);
    expect(hasBugseeMarker('// see bugsee-wizard.')).toBe(true);
  });
  it('detects a marker after a string containing comment-like text', () => {
    expect(hasBugseeMarker("const u = 'http://x'; // bugsee-wizard")).toBe(true);
  });
  it('handles an unterminated block comment', () => {
    expect(hasBugseeMarker('/* bugsee-wizard')).toBe(true);
  });
});

describe('addBundlerPlugin: supported shapes', () => {
  it('vite: export default object with plugins array (ts)', () => {
    expect(apply('vite/default-object.ts', 'vite')).toEqual({
      code: `import react from '@vitejs/plugin-react';
import { bugsee } from '@bugsee/vite-plugin'; ${MARK}

export default {
  plugins: [react(), bugsee({ appToken: 'T' })],
  server: { port: 3000 },
};
`,
    });
  });

  it('vite: defineConfig({}) without plugins creates the array', () => {
    expect(apply('vite/define-config.ts', 'vite')).toEqual({
      code: `import { defineConfig } from 'vite';
import { bugsee } from '@bugsee/vite-plugin'; ${MARK}

export default defineConfig({
  server: { port: 3000 },
  plugins: [bugsee({ appToken: 'T' })],
});
`,
    });
  });

  it('vite: identifier export resolves the declaration', () => {
    expect(apply('vite/identifier-export.ts', 'vite')).toEqual({
      code: `import { defineConfig } from 'vite';
import { bugsee } from '@bugsee/vite-plugin'; ${MARK}

const config = defineConfig({
  plugins: [bugsee({ appToken: 'T' })],
});

export default config;
`,
    });
  });

  it('vite: commonjs module.exports uses require', () => {
    expect(apply('vite/default-object.cjs', 'vite')).toEqual({
      code: `const react = require('@vitejs/plugin-react');
const { bugsee } = require('@bugsee/vite-plugin'); ${MARK}

module.exports = {
  plugins: [react(), bugsee({ appToken: 'T' })],
};
`,
    });
  });

  it('webpack: CJS module.exports object without plugins', () => {
    expect(apply('webpack/cjs-object.cjs', 'webpack')).toEqual({
      code: `const path = require('path');
const { bugsee } = require('@bugsee/vite-plugin'); ${MARK}

module.exports = {
  entry: './src/index.js',
  output: { path: path.resolve(__dirname, 'dist') },
  plugins: [bugsee({ appToken: 'T' })],
};
`,
    });
  });

  it('webpack: const config = {...}; module.exports = config', () => {
    expect(apply('webpack/cjs-identifier.cjs', 'webpack')).toEqual({
      code: `const { bugsee } = require('@bugsee/vite-plugin'); ${MARK}
const config = {
  entry: './src/index.js',
  plugins: [bugsee({ appToken: 'T' })],
};

module.exports = config;
`,
    });
  });

  it('webpack: ESM export default object', () => {
    expect(apply('webpack/esm-object.js', 'webpack')).toEqual({
      code: `import HtmlWebpackPlugin from 'html-webpack-plugin';
import { bugsee } from '@bugsee/vite-plugin'; ${MARK}

export default {
  entry: './src/index.js',
  plugins: [new HtmlWebpackPlugin(), bugsee({ appToken: 'T' })],
};
`,
    });
  });

  it('rollup: mjs and defineConfig forms', () => {
    expect(apply('rollup/default-object.mjs', 'rollup')).toEqual({
      code: `import resolve from '@rollup/plugin-node-resolve';
import { bugsee } from '@bugsee/vite-plugin'; ${MARK}

export default {
  input: 'src/main.js',
  output: { file: 'bundle.js', format: 'es' },
  plugins: [resolve(), bugsee({ appToken: 'T' })],
};
`,
    });
    expect(apply('rollup/default-object.ts', 'rollup')).toEqual({
      code: `import { defineConfig } from 'rollup';
import { bugsee } from '@bugsee/vite-plugin'; ${MARK}

export default defineConfig({
  input: 'src/main.ts',
  output: { file: 'bundle.js', format: 'es' },
  plugins: [bugsee({ appToken: 'T' })],
});
`,
    });
  });

  it('rspack: defineConfig with empty plugins and CJS object', () => {
    expect(apply('rspack/define-config.ts', 'rspack')).toEqual({
      code: `import { defineConfig } from '@rspack/cli';
import { bugsee } from '@bugsee/vite-plugin'; ${MARK}

export default defineConfig({
  entry: { main: './src/index.ts' },
  plugins: [bugsee({ appToken: 'T' })],
});
`,
    });
    expect(apply('rspack/cjs-object.cjs', 'rspack')).toEqual({
      code: `const { bugsee } = require('@bugsee/vite-plugin'); ${MARK}
module.exports = {
  entry: { main: './src/index.js' },
  plugins: [bugsee({ appToken: 'T' })],
};
`,
    });
  });

  it('multi-line plugins arrays get one entry per line (with and without trailing comma)', () => {
    const head = "import a from 'a';\n";
    const imp = `import { bugsee } from '@bugsee/vite-plugin'; ${MARK}\n`;
    expect(
      addBundlerPlugin(`${head}export default {\n  plugins: [\n    a()\n  ],\n};\n`, 'vite', spec),
    ).toEqual({
      code: `${head}${imp}export default {\n  plugins: [\n    a(),\n    bugsee({ appToken: 'T' })\n  ],\n};\n`,
    });
    expect(
      addBundlerPlugin(`${head}export default {\n  plugins: [\n    a(),\n  ],\n};\n`, 'vite', spec),
    ).toEqual({
      code: `${head}${imp}export default {\n  plugins: [\n    a(),\n    bugsee({ appToken: 'T' }),\n  ],\n};\n`,
    });
  });

  it('adds the property after a last property without trailing comma, and fills an empty object', () => {
    expect(addBundlerPlugin('export default {\n  a: 1\n};\n', 'vite', spec)).toEqual({
      code: `import { bugsee } from '@bugsee/vite-plugin'; ${MARK}\nexport default {\n  a: 1,\n  plugins: [bugsee({ appToken: 'T' })]\n};\n`,
    });
    expect(addBundlerPlugin('export default {};\n', 'vite', spec)).toEqual({
      code: `import { bugsee } from '@bugsee/vite-plugin'; ${MARK}\nexport default { plugins: [bugsee({ appToken: 'T' })] };\n`,
    });
  });

  it('empty-array and single-line trailing comma arrays', () => {
    expect(addBundlerPlugin('export default { plugins: [] };\n', 'vite', spec)).toEqual({
      code: `import { bugsee } from '@bugsee/vite-plugin'; ${MARK}\nexport default { plugins: [bugsee({ appToken: 'T' })] };\n`,
    });
    expect(addBundlerPlugin('export default { plugins: [a(),] };\n', 'vite', spec)).toEqual({
      code: `import { bugsee } from '@bugsee/vite-plugin'; ${MARK}\nexport default { plugins: [a(), bugsee({ appToken: 'T' }),] };\n`,
    });
  });

  it('preserves CRLF line endings', () => {
    const src = "import a from 'a';\r\nexport default {\r\n  a: 1,\r\n};\r\n";
    const r = addBundlerPlugin(src, 'vite', spec);
    expect(r).toEqual({
      code: `import a from 'a';\r\nimport { bugsee } from '@bugsee/vite-plugin'; ${MARK}\r\nexport default {\r\n  a: 1,\r\n  plugins: [bugsee({ appToken: 'T' })],\r\n};\r\n`,
    });
  });

  it('inserts after a leading "use strict" directive in a CJS file without requires', () => {
    expect(
      addBundlerPlugin("'use strict';\nmodule.exports = { plugins: [] };\n", 'webpack', spec),
    ).toEqual({
      code: `'use strict';\nconst { bugsee } = require('@bugsee/vite-plugin'); ${MARK}\nmodule.exports = { plugins: [bugsee({ appToken: 'T' })] };\n`,
    });
  });

  it('unwraps "as"/"satisfies" annotations', () => {
    expect(addBundlerPlugin('export default { a: 1, } satisfies Cfg;\n', 'vite', spec)).toEqual({
      code: `import { bugsee } from '@bugsee/vite-plugin'; ${MARK}\nexport default { a: 1, plugins: [bugsee({ appToken: 'T' })], } satisfies Cfg;\n`,
    });
    expect(
      addBundlerPlugin('const c = { a: 1 } as Cfg;\nexport default c;\n', 'vite', spec),
    ).toEqual({
      code: `import { bugsee } from '@bugsee/vite-plugin'; ${MARK}\nconst c = { a: 1, plugins: [bugsee({ appToken: 'T' })] } as Cfg;\nexport default c;\n`,
    });
  });
});

describe('addBundlerPlugin: idempotence and no-ops', () => {
  const cases: Array<[string, PluginTarget]> = [
    ['vite/default-object.ts', 'vite'],
    ['vite/define-config.ts', 'vite'],
    ['vite/identifier-export.ts', 'vite'],
    ['vite/default-object.cjs', 'vite'],
    ['webpack/cjs-object.cjs', 'webpack'],
    ['webpack/cjs-identifier.cjs', 'webpack'],
    ['webpack/esm-object.js', 'webpack'],
    ['rollup/default-object.mjs', 'rollup'],
    ['rspack/define-config.ts', 'rspack'],
    ['rspack/cjs-object.cjs', 'rspack'],
  ];
  it.each(cases)('%s: a second application is a no-op', (rel, target) => {
    const first = apply(rel, target);
    if ('manual' in first) throw new Error('expected code');
    expect(first.code).not.toBe(fx(rel));
    expect(addBundlerPlugin(first.code, target, spec)).toEqual({ code: first.code });
    expect(first.code.split('@bugsee/vite-plugin').length - 1).toBe(1);
  });

  it('is a no-op when the import AND the plugin call exist without the marker', () => {
    const src =
      "import { bugsee } from '@bugsee/vite-plugin';\nexport default { plugins: [bugsee({ a: 1 })] };\n";
    expect(addBundlerPlugin(src, 'vite', spec)).toEqual({ code: src });
    const cjs =
      "const { bugsee } = require('@bugsee/vite-plugin');\nmodule.exports = { plugins: [bugsee()] };\n";
    expect(addBundlerPlugin(cjs, 'vite', spec)).toEqual({ code: cjs });
  });

  it('an unrelated import of the same package does not count as configured', () => {
    expect(
      addBundlerPlugin(
        'import { other } from "@bugsee/vite-plugin";\nexport default { plugins: [] };\n',
        'vite',
        spec,
      ),
    ).toEqual({
      code: `import { other } from "@bugsee/vite-plugin";\nimport { bugsee } from '@bugsee/vite-plugin'; ${MARK}\nexport default { plugins: [bugsee({ appToken: 'T' })] };\n`,
    });
    expect(
      addBundlerPlugin(
        "const { other } = require('@bugsee/vite-plugin');\nmodule.exports = { plugins: [] };\n",
        'vite',
        spec,
      ),
    ).toEqual({
      code: `const { other } = require('@bugsee/vite-plugin');\nconst { bugsee } = require('@bugsee/vite-plugin'); ${MARK}\nmodule.exports = { plugins: [bugsee({ appToken: 'T' })] };\n`,
    });
  });

  it('import bound but plugin call missing: only the call is added', () => {
    expect(
      addBundlerPlugin(
        "import { bugsee } from '@bugsee/vite-plugin';\nexport default { plugins: [] };\n",
        'vite',
        spec,
      ),
    ).toEqual({
      code: "import { bugsee } from '@bugsee/vite-plugin';\nexport default { plugins: [bugsee({ appToken: 'T' })] };\n",
    });
  });

  it('call present but import missing: only the import is added', () => {
    expect(addBundlerPlugin('export default { plugins: [bugsee()] };\n', 'vite', spec)).toEqual({
      code: `import { bugsee } from '@bugsee/vite-plugin'; ${MARK}\nexport default { plugins: [bugsee()] };\n`,
    });
  });

  it('a comment or string mentioning the package does not count', () => {
    const src =
      "// import { bugsee } from '@bugsee/vite-plugin'\nconst s = \"from '@bugsee/vite-plugin'\";\nexport default { plugins: [] };\n";
    const r = addBundlerPlugin(src, 'vite', spec);
    expect(r).toEqual({
      code: `import { bugsee } from '@bugsee/vite-plugin'; ${MARK}\n// import { bugsee } from '@bugsee/vite-plugin'\nconst s = "from '@bugsee/vite-plugin'";\nexport default { plugins: [bugsee({ appToken: 'T' })] };\n`,
    });
  });

  it('is a no-op when only the marker exists', () => {
    const src = 'export default {}; // bugsee-wizard\n';
    expect(addBundlerPlugin(src, 'vite', spec)).toEqual({ code: src });
  });

  it('a marker inside a string does not count', () => {
    const r = addBundlerPlugin("const s = '// bugsee-wizard';\nexport default {};\n", 'vite', spec);
    expect('code' in r && r.code.includes('bugsee({')).toBe(true);
  });
});

describe('addBundlerPlugin: unsupported shapes return { manual } and never change code', () => {
  const cases: Array<[string, PluginTarget]> = [
    ['vite/function-form.ts', 'vite'],
    ['vite/async-function.ts', 'vite'],
    ['vite/arrow-export.ts', 'vite'],
    ['vite/merge-config.ts', 'vite'],
    ['webpack/array.cjs', 'webpack'],
    ['webpack/function-form.cjs', 'webpack'],
  ];
  it.each(cases)('%s', (rel, target) => {
    const r = apply(rel, target);
    expect('code' in r).toBe(false);
    if (!('manual' in r)) throw new Error('expected manual');
    expect(r.manual).toContain("'@bugsee/vite-plugin'");
    expect(r.manual).toContain("bugsee({ appToken: 'T' })");
    expect(r.manual).toContain('plugins');
  });

  it('manual snippet uses require() for CommonJS files', () => {
    const r = apply('webpack/array.cjs', 'webpack');
    expect(r).toEqual({
      manual: `const { bugsee } = require('@bugsee/vite-plugin'); ${MARK}\n\n// Add to the "plugins" array of your webpack config:\nbugsee({ appToken: 'T' })`,
    });
  });

  it('manual snippet for ESM names the target and ends with the plugin call', () => {
    const r = apply('vite/function-form.ts', 'vite');
    expect(r).toEqual({
      manual: `import { bugsee } from '@bugsee/vite-plugin'; ${MARK}\n\n// Add to the "plugins" array of your vite config:\nbugsee({ appToken: 'T' })`,
    });
  });

  it.each([
    ['conditional export', 'export default cond ? { a: 1 } : { b: 2 };\n'],
    ['spread-only object', 'export default { ...base };\n'],
    ['call to unknown function', 'export default base2();\n'],
    ['identifier to a function', 'const c = () => ({});\nexport default c;\n'],
    ['identifier never declared', 'export default config;\n'],
    ['identifier declared in a cycle', 'const a = b;\nconst b = a;\nexport default a;\n'],
    ['no default export at all', 'export const x = 1;\n'],
    ['no exports, empty file', ''],
    ['module.exports of a non-object', 'module.exports = require("./x");\n'],
    ['plugins that is not an array', 'export default { plugins: getPlugins() };\n'],
    ['plugins referencing an identifier', 'const list = [];\nexport default { plugins: list };\n'],
    ['computed module[exports]', 'module[exports] = { a: 1 };\n'],
    ['plugins shorthand property', 'const plugins = [];\nexport default { plugins };\n'],
    ['unknown wrapper call', 'export default somethingElse({ a: 1 });\n'],
    ['wrapper call with two args', 'export default defineConfig({ a: 1 }, 2);\n'],
    ['class export', 'export default class {}\n'],
    ['unparseable source', 'export default {{{\n'],
  ])('%s', (_name, src) => {
    const r = addBundlerPlugin(src, 'vite', spec);
    expect(r).toHaveProperty('manual');
    expect(r).not.toHaveProperty('code');
  });
});

describe('addBundlerPlugin: details', () => {
  it('a computed [plugins] key is not the plugins property', () => {
    expect(addBundlerPlugin('export default { [plugins]: 1 };\n', 'vite', spec)).toEqual({
      code: `import { bugsee } from '@bugsee/vite-plugin'; ${MARK}\nexport default { [plugins]: 1, plugins: [bugsee({ appToken: 'T' })] };\n`,
    });
  });

  it('the manual snippet follows the file style: require for CJS, import for ESM', () => {
    const esmWithRequire = "import x from 'x';\nconst r = require('r');\nexport const y = 1;\n";
    expect(addBundlerPlugin(esmWithRequire, 'vite', spec)).toHaveProperty(
      'manual',
      expect.stringContaining('import { bugsee }'),
    );
    expect(addBundlerPlugin("const r = require('r');\n", 'vite', spec)).toHaveProperty(
      'manual',
      expect.stringContaining('= require('),
    );
    expect(addBundlerPlugin('export default {{{\n', 'vite', spec)).toHaveProperty(
      'manual',
      expect.stringContaining('import { bugsee }'),
    );
  });
});

describe('addBundlerPlugin: aliased bindings', () => {
  it('an import that merely aliases another export to the same local name is not ours', () => {
    const src =
      "import { other as bugsee } from '@bugsee/vite-plugin';\nexport default { plugins: [bugsee()] };\n";
    // not our binding, so the wizard must not claim success; a duplicate declaration cannot re-parse
    expect(addBundlerPlugin(src, 'vite', spec)).toHaveProperty('manual');
  });
});

describe('addBundlerPlugin: BOM, shebang, trailing comments', () => {
  it('keeps a BOM (also with CRLF)', () => {
    expect(
      addBundlerPlugin(
        '\uFEFFimport a from "a";\nexport default { plugins: [a()] };',
        'vite',
        spec,
      ),
    ).toEqual({
      code: `\uFEFFimport a from "a";\nimport { bugsee } from '@bugsee/vite-plugin'; ${MARK}\nexport default { plugins: [a(), bugsee({ appToken: 'T' })] };`,
    });
    expect(
      addBundlerPlugin(
        '\uFEFFimport a from "a";\r\nexport default { plugins: [a()] };\r\n',
        'vite',
        spec,
      ),
    ).toEqual({
      code: `\uFEFFimport a from "a";\r\nimport { bugsee } from '@bugsee/vite-plugin'; ${MARK}\r\nexport default { plugins: [a(), bugsee({ appToken: 'T' })] };\r\n`,
    });
  });

  it('never inserts above a shebang line', () => {
    expect(
      addBundlerPlugin('#!/usr/bin/env node\nexport default { plugins: [] }', 'vite', spec),
    ).toEqual({
      code: `#!/usr/bin/env node\nimport { bugsee } from '@bugsee/vite-plugin'; ${MARK}\nexport default { plugins: [bugsee({ appToken: 'T' })] }`,
    });
    expect(
      addBundlerPlugin(
        '\uFEFF#!/usr/bin/env node\r\nmodule.exports = { plugins: [] };\r\n',
        'webpack',
        spec,
      ),
    ).toEqual({
      code: `\uFEFF#!/usr/bin/env node\r\nconst { bugsee } = require('@bugsee/vite-plugin'); ${MARK}\r\nmodule.exports = { plugins: [bugsee({ appToken: 'T' })] };\r\n`,
    });
  });

  it('a shebang-only file is left to the manual path', () => {
    expect(addBundlerPlugin('#!/usr/bin/env node', 'vite', spec)).toHaveProperty('manual');
  });

  it('keeps a trailing comment on the import line and puts the new import on its own line', () => {
    expect(
      addBundlerPlugin(
        'import a from "a"; // keep\nexport default { plugins: [a()] };\n',
        'vite',
        spec,
      ),
    ).toEqual({
      code: `import a from "a"; // keep\nimport { bugsee } from '@bugsee/vite-plugin'; ${MARK}\nexport default { plugins: [a(), bugsee({ appToken: 'T' })] };\n`,
    });
    expect(
      addBundlerPlugin(
        'import a from "a"; /* k */\nexport default { plugins: [a()] };\n',
        'vite',
        spec,
      ),
    ).toEqual({
      code: `import a from "a"; /* k */\nimport { bugsee } from '@bugsee/vite-plugin'; ${MARK}\nexport default { plugins: [a(), bugsee({ appToken: 'T' })] };\n`,
    });
    expect(
      addBundlerPlugin("'use strict'; // d\nmodule.exports = { plugins: [] };\n", 'webpack', spec),
    ).toEqual({
      code: `'use strict'; // d\nconst { bugsee } = require('@bugsee/vite-plugin'); ${MARK}\nmodule.exports = { plugins: [bugsee({ appToken: 'T' })] };\n`,
    });
  });

  it('does not split an import from following code on the same line', () => {
    expect(
      addBundlerPlugin('import a from "a"; export default { plugins: [] };\n', 'vite', spec),
    ).toEqual({
      code: `import a from "a";\nimport { bugsee } from '@bugsee/vite-plugin'; ${MARK} export default { plugins: [bugsee({ appToken: 'T' })] };\n`,
    });
  });

  it('appends after the last element line, leaving its trailing comment alone', () => {
    const imp = `import { bugsee } from '@bugsee/vite-plugin'; ${MARK}\n`;
    expect(
      addBundlerPlugin('export default {\n  plugins: [\n    a(), // x\n  ],\n};\n', 'vite', spec),
    ).toEqual({
      code: `${imp}export default {\n  plugins: [\n    a(), // x\n    bugsee({ appToken: 'T' }),\n  ],\n};\n`,
    });
    expect(
      addBundlerPlugin('export default {\n  plugins: [\n    a() // x\n  ],\n};\n', 'vite', spec),
    ).toEqual({
      code: `${imp}export default {\n  plugins: [\n    a(), // x\n    bugsee({ appToken: 'T' })\n  ],\n};\n`,
    });
    expect(addBundlerPlugin('export default {\n  a: 1, // x\n};\n', 'vite', spec)).toEqual({
      code: `${imp}export default {\n  a: 1, // x\n  plugins: [bugsee({ appToken: 'T' })],\n};\n`,
    });
    expect(addBundlerPlugin('export default {\n  a: 1 /* x */\n};\n', 'vite', spec)).toEqual({
      code: `${imp}export default {\n  a: 1, /* x */\n  plugins: [bugsee({ appToken: 'T' })]\n};\n`,
    });
  });
});

describe('setJsonCKey', () => {
  const tsconfig = (): string => fx('tsconfig/with-comments.json');

  it('sets an existing nested key while preserving comments and layout', () => {
    expect(setJsonCKey(tsconfig(), ['compilerOptions', 'strict'], false)).toBe(
      tsconfig().replace('"strict": true', '"strict": false'),
    );
  });

  it('adds a key to an existing object with detected indentation', () => {
    expect(setJsonCKey(tsconfig(), ['compilerOptions', 'sourceMap'], true)).toBe(
      tsconfig().replace('"strict": true', '"strict": true,\n    "sourceMap": true'),
    );
  });

  it('creates missing intermediate objects', () => {
    const out = setJsonCKey('{\n  "a": 1\n}\n', ['x', 'y', 'z'], 5);
    expect(out).toBe('{\n  "a": 1,\n  "x": {\n    "y": {\n      "z": 5\n    }\n  }\n}\n');
  });

  it('returns the text unchanged when the value is already deep-equal', () => {
    const src = tsconfig();
    expect(setJsonCKey(src, ['compilerOptions', 'target'], 'ES2022')).toBe(src);
    expect(setJsonCKey('{"a":{"b":[1,{"c":2}]}}', ['a', 'b'], [1, { c: 2 }])).toBe(
      '{"a":{"b":[1,{"c":2}]}}',
    );
  });

  it('detects tab indentation and CRLF', () => {
    expect(setJsonCKey('{\r\n\t"a": 1\r\n}\r\n', ['b'], 2)).toBe(
      '{\r\n\t"a": 1,\r\n\t"b": 2\r\n}\r\n',
    );
  });

  it('falls back to two spaces and LF for a single-line document', () => {
    expect(setJsonCKey('{}', ['a', 'b'], 1)).toBe('{\n  "a": {\n    "b": 1\n  }\n}');
  });

  it('sets array and object values', () => {
    expect(setJsonCKey('{\n  "a": 1\n}\n', ['list'], ['x'])).toBe(
      '{\n  "a": 1,\n  "list": [\n    "x"\n  ]\n}\n',
    );
  });

  it('result still parses as JSON-C (comments retained)', () => {
    const out = setJsonCKey(tsconfig(), ['compilerOptions', 'sourceMap'], true);
    expect(out).toContain('// top comment');
    expect(out).toContain('/* compiler block */');
    expect(out).toContain('// keep');
    expect(out).toContain('// trailing');
  });
});
