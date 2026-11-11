import { parseModule } from 'magicast';
import { describe, expect, it } from 'vitest';
import {
  addSdkInit,
  hasSdkIntegration,
  type SdkInitSpec,
  sdkInitSnippet,
} from '../../src/engine/sdk-init-ast.js';

const base: SdkInitSpec = {
  importFrom: '@bugsee/bugsee',
  token: 'tok_ABC.123',
  fileName: 'main.js',
  runtime: 'browser',
};
const spec = (over: Partial<SdkInitSpec> = {}): SdkInitSpec => ({ ...base, ...over });
const code = (r: ReturnType<typeof addSdkInit>): string => {
  if (!('code' in r)) throw new Error(`expected code, got manual: ${r.manual}`);
  return r.code;
};
const reparses = (src: string): boolean => {
  try {
    parseModule(src);
    return true;
  } catch {
    return false;
  }
};

describe('hasSdkIntegration', () => {
  it('is true for the wizard marker in a comment', () => {
    expect(hasSdkIntegration('launch(); // bugsee-wizard\n')).toBe(true);
  });
  it('ignores the marker inside a string', () => {
    expect(hasSdkIntegration("const s = '// bugsee-wizard';\n")).toBe(false);
  });
  it.each([
    ["import { launch } from '@bugsee/bugsee';\n"],
    ["import '@bugsee/browser';\n"],
    ["const { launch } = require('@bugsee/node');\n"],
    ["import { launch } from '@bugsee/bun'\n"],
  ])('is true when a @bugsee package is already imported: %s', (src) => {
    expect(hasSdkIntegration(src)).toBe(true);
  });
  it('is false for other imports and for build tooling packages', () => {
    expect(hasSdkIntegration("import x from 'react';\n")).toBe(false);
    expect(hasSdkIntegration("import { p } from '@bugsee/vite-plugin';\n")).toBe(false);
  });
  it('is false for unparseable code without a marker', () => {
    expect(hasSdkIntegration('import {{{\n')).toBe(false);
  });
});

describe('addSdkInit (ESM)', () => {
  it('adds the import after the last import and the call right below it', () => {
    const src = "import a from 'a';\nimport b from 'b';\n\nrender(a, b);\n";
    const out = code(addSdkInit(src, spec()));
    expect(out).toBe(
      [
        "import a from 'a';",
        "import b from 'b';",
        "import { launch } from '@bugsee/bugsee'; // bugsee-wizard",
        "launch('tok_ABC.123'); // bugsee-wizard",
        '',
        'render(a, b);',
        '',
      ].join('\n'),
    );
    expect(reparses(out)).toBe(true);
  });

  it('handles a multi-line import and a trailing comment on the last import line', () => {
    const src = "import {\n  a,\n  b,\n} from 'x'; // keep\nrun();\n";
    const out = code(addSdkInit(src, spec()));
    expect(out).toBe(
      [
        'import {',
        '  a,',
        '  b,',
        "} from 'x'; // keep",
        "import { launch } from '@bugsee/bugsee'; // bugsee-wizard",
        "launch('tok_ABC.123'); // bugsee-wizard",
        'run();',
        '',
      ].join('\n'),
    );
  });

  it('with no imports, goes before the first statement and after leading comments', () => {
    const src = '// the app\n\nconsole.log(1);\n';
    const out = code(addSdkInit(src, spec()));
    expect(out).toBe(
      [
        '// the app',
        '',
        "import { launch } from '@bugsee/bugsee'; // bugsee-wizard",
        "launch('tok_ABC.123'); // bugsee-wizard",
        'console.log(1);',
        '',
      ].join('\n'),
    );
  });

  it('with no imports and a "use strict" directive, goes after the directive', () => {
    const src = "'use strict';\nconsole.log(1);\n";
    const out = code(addSdkInit(src, spec({ fileName: 'main.mjs' })));
    expect(out.split('\n').slice(0, 4)).toEqual([
      "'use strict';",
      "import { launch } from '@bugsee/bugsee'; // bugsee-wizard",
      "launch('tok_ABC.123'); // bugsee-wizard",
      'console.log(1);',
    ]);
  });

  it('an empty file gets just the two lines', () => {
    expect(code(addSdkInit('', spec()))).toBe(
      "import { launch } from '@bugsee/bugsee'; // bugsee-wizard\nlaunch('tok_ABC.123'); // bugsee-wizard\n",
    );
  });

  it('a comments-only file gets the lines appended', () => {
    const out = code(addSdkInit('// todo\n', spec()));
    expect(out).toBe(
      "// todo\nimport { launch } from '@bugsee/bugsee'; // bugsee-wizard\nlaunch('tok_ABC.123'); // bugsee-wizard\n",
    );
  });

  it('keeps a shebang line first, and a BOM', () => {
    const out = code(addSdkInit('﻿#!/usr/bin/env node\nimport a from "a";\n', spec()));
    expect(out.startsWith('﻿#!/usr/bin/env node\nimport a from "a";\n')).toBe(true);
    expect(out).toContain("launch('tok_ABC.123'); // bugsee-wizard");
  });

  it('preserves CRLF line endings throughout', () => {
    const out = code(addSdkInit("import a from 'a';\r\nrun(a);\r\n", spec()));
    expect(out).toBe(
      [
        "import a from 'a';",
        "import { launch } from '@bugsee/bugsee'; // bugsee-wizard",
        "launch('tok_ABC.123'); // bugsee-wizard",
        'run(a);',
        '',
      ].join('\r\n'),
    );
  });

  it('works on TSX', () => {
    const src =
      "import { createRoot } from 'react-dom/client';\nimport App from './App';\n\ncreateRoot(document.body).render(<App />);\n";
    const out = code(addSdkInit(src, spec({ fileName: 'main.tsx' })));
    expect(out).toContain("launch('tok_ABC.123'); // bugsee-wizard");
    expect(out).toContain('render(<App />)');
    expect(reparses(out)).toBe(true);
  });

  it('leaves the rest of the file byte-for-byte alone', () => {
    const src = "import a from 'a';\n\n\tweird   (  a );\n";
    const out = code(addSdkInit(src, spec()));
    expect(out).toContain('\n\tweird   (  a );\n');
  });
});

describe('addSdkInit (token expression)', () => {
  it('uses the expression instead of a literal token', () => {
    const out = code(
      addSdkInit(
        "import a from 'a';\n",
        spec({ tokenExpr: 'import.meta.env.VITE_BUGSEE_APP_TOKEN' }),
      ),
    );
    expect(out).toContain('launch(import.meta.env.VITE_BUGSEE_APP_TOKEN); // bugsee-wizard');
    expect(out).not.toContain('tok_ABC');
  });

  it('guards an environment token: a missing variable must not make launch() throw (no cast needed)', () => {
    const t = { tokenExpr: 'process.env.BUGSEE_APP_TOKEN' };
    for (const fileName of ['server.ts', 'server.js']) {
      expect(code(addSdkInit('run();\n', spec({ ...t, fileName })))).toContain(
        'if (process.env.BUGSEE_APP_TOKEN) launch(process.env.BUGSEE_APP_TOKEN); // bugsee-wizard',
      );
    }
    expect(code(addSdkInit('run();\n', spec({ ...t, fileName: 'server.ts' })))).not.toContain(
      ' as string',
    );
  });

  it('adds a vite/client reference to TypeScript when the project has no Vite env types', () => {
    const t = {
      tokenExpr: 'import.meta.env.VITE_BUGSEE_APP_TOKEN',
      fileName: 'main.ts',
      viteClientTypes: false,
    };
    const out = code(addSdkInit("import a from 'a';\n", spec(t)));
    expect(out.startsWith('/// <reference types="vite/client" /> // bugsee-wizard\n')).toBe(false);
    expect(out.startsWith('/// <reference types="vite/client" />\n')).toBe(true);
    expect(
      code(addSdkInit("import a from 'a';\n", spec({ ...t, viteClientTypes: true }))),
    ).not.toContain('vite/client');
    expect(
      code(addSdkInit("import a from 'a';\n", spec({ ...t, fileName: 'main.js' }))),
    ).not.toContain('vite/client');
  });

  it('puts the vite/client reference after a shebang/BOM-free first line and keeps the marker detectable', () => {
    const out = code(
      addSdkInit(
        "import a from 'a';\n",
        spec({
          tokenExpr: 'import.meta.env.X',
          fileName: 'main.ts',
          viteClientTypes: false,
        }),
      ),
    );
    expect(hasSdkIntegration(out)).toBe(true);
  });

  it('escapes quotes and backslashes of a literal token', () => {
    const out = code(addSdkInit('run();\n', spec({ token: "a'b\\c" })));
    expect(out).toContain("launch('a\\'b\\\\c');");
    expect(reparses(out)).toBe(true);
  });
});

describe('addSdkInit (CommonJS)', () => {
  it('uses require after the last require and detects CJS from the extension', () => {
    const src =
      "const http = require('http');\nconst fs = require('fs');\n\nhttp.createServer();\n";
    const out = code(addSdkInit(src, spec({ fileName: 'server.cjs', runtime: 'node' })));
    expect(out).toBe(
      [
        "const http = require('http');",
        "const fs = require('fs');",
        "const { launch } = require('@bugsee/bugsee'); // bugsee-wizard",
        "launch('tok_ABC.123'); // bugsee-wizard",
        '',
        'http.createServer();',
        '',
      ].join('\n'),
    );
    expect(reparses(out)).toBe(true);
  });

  it('detects CJS in a .js file with require() and no ESM syntax, even when package type is unset', () => {
    const out = code(
      addSdkInit("const a = require('a');\n", spec({ fileName: 'index.js', runtime: 'node' })),
    );
    expect(out).toContain("const { launch } = require('@bugsee/bugsee'); // bugsee-wizard");
  });

  it('a .js file with ESM syntax is ESM regardless of the package type', () => {
    const out = code(
      addSdkInit("import a from 'a';\n", spec({ fileName: 'index.js', packageType: 'commonjs' })),
    );
    expect(out).toContain("import { launch } from '@bugsee/bugsee'; // bugsee-wizard");
  });

  it('with no syntax to go on, the package type decides for .js', () => {
    expect(
      code(
        addSdkInit('run();\n', spec({ fileName: 'a.js', packageType: 'module', runtime: 'node' })),
      ),
    ).toContain('import { launch }');
    expect(
      code(
        addSdkInit(
          'run();\n',
          spec({ fileName: 'a.js', packageType: 'commonjs', runtime: 'node' }),
        ),
      ),
    ).toContain('require(');
    expect(code(addSdkInit('run();\n', spec({ fileName: 'a.js', runtime: 'node' })))).toContain(
      'require(',
    );
  });

  it('.ts files use import syntax (the compiler decides the output) except .cts', () => {
    expect(code(addSdkInit('run();\n', spec({ fileName: 'a.ts' })))).toContain('import { launch }');
    expect(code(addSdkInit('run();\n', spec({ fileName: 'a.cts', runtime: 'node' })))).toContain(
      'require(',
    );
    expect(code(addSdkInit('run();\n', spec({ fileName: 'a.mts' })))).toContain(
      'import { launch }',
    );
  });

  it('browser entries are always ESM', () => {
    expect(
      code(addSdkInit("const a = require('a');\n", spec({ fileName: 'a.js', runtime: 'browser' }))),
    ).toContain('import { launch }');
  });

  it('CJS with a directive and no requires goes after the directive', () => {
    const out = code(
      addSdkInit("'use strict';\nrun();\n", spec({ fileName: 'a.cjs', runtime: 'node' })),
    );
    expect(out.split('\n').slice(0, 3)).toEqual([
      "'use strict';",
      "const { launch } = require('@bugsee/bugsee'); // bugsee-wizard",
      "launch('tok_ABC.123'); // bugsee-wizard",
    ]);
  });
});

describe('addSdkInit (idempotency and conflicts)', () => {
  it('returns the source untouched when the marker is present', () => {
    const src = "import { launch } from '@bugsee/bugsee'; // bugsee-wizard\nlaunch('x');\n";
    expect(code(addSdkInit(src, spec()))).toBe(src);
  });

  it('returns the source untouched when a @bugsee package is already imported by hand', () => {
    const src = "import { launch } from '@bugsee/bugsee';\nlaunch('mine');\n";
    expect(code(addSdkInit(src, spec()))).toBe(src);
  });

  it('applying twice changes nothing the second time', () => {
    const once = code(addSdkInit("import a from 'a';\n", spec()));
    expect(code(addSdkInit(once, spec()))).toBe(once);
  });

  it('aliases the import when `launch` is already bound by something else', () => {
    const src = "import { launch } from 'other';\nlaunch();\n";
    const out = code(addSdkInit(src, spec()));
    expect(out).toContain(
      "import { launch as bugseeLaunch } from '@bugsee/bugsee'; // bugsee-wizard",
    );
    expect(out).toContain("bugseeLaunch('tok_ABC.123'); // bugsee-wizard");
  });

  it('aliases for a local declaration and for CommonJS destructuring', () => {
    const out = code(addSdkInit('function launch() {}\nlaunch();\n', spec({ fileName: 'a.mjs' })));
    expect(out).toContain('launch as bugseeLaunch');
    const cjs = code(
      addSdkInit(
        "const { launch } = require('other');\n",
        spec({ fileName: 'a.cjs', runtime: 'node' }),
      ),
    );
    expect(cjs).toContain(
      "const { launch: bugseeLaunch } = require('@bugsee/bugsee'); // bugsee-wizard",
    );
  });

  it('gives a manual snippet when both names are taken', () => {
    const src = "import { launch, bugseeLaunch } from 'other';\n";
    const res = addSdkInit(src, spec());
    expect('manual' in res).toBe(true);
  });

  it('counts class, array and rest bindings as taken names', () => {
    const src = 'class launch {}\nconst [bugseeLaunch] = [];\n';
    expect('manual' in addSdkInit(src, spec({ fileName: 'a.mjs' }))).toBe(true);
    const rest = 'const { ...launch } = o;\nlet bugseeLaunch = 1;\n';
    expect('manual' in addSdkInit(rest, spec({ fileName: 'a.mjs' }))).toBe(true);
  });
});

describe('addSdkInit (honest failure)', () => {
  it('an unparseable file yields a manual snippet and no code', () => {
    const res = addSdkInit('import {{{ nope\n', spec());
    expect('manual' in res).toBe(true);
    if ('manual' in res) expect(res.manual).toContain("from '@bugsee/bugsee'");
  });

  it('the manual snippet never contains the real token', () => {
    const res = addSdkInit('import {{{ nope\n', spec({ token: 'tok_REAL_SECRET' }));
    expect('manual' in res && res.manual.includes('tok_REAL_SECRET')).toBe(false);
    expect(sdkInitSnippet(spec({ token: 'tok_REAL_SECRET' }), false)).not.toContain(
      'tok_REAL_SECRET',
    );
  });
});

describe('sdkInitSnippet', () => {
  it('shows ESM and CJS forms with a placeholder or the expression', () => {
    expect(sdkInitSnippet(spec(), false)).toBe(
      "import { launch } from '@bugsee/bugsee'; // bugsee-wizard\nlaunch('<your Bugsee app token>'); // bugsee-wizard",
    );
    expect(
      sdkInitSnippet(spec({ tokenExpr: 'process.env.BUGSEE_APP_TOKEN', fileName: 'a.ts' }), true),
    ).toBe(
      "const { launch } = require('@bugsee/bugsee'); // bugsee-wizard\nif (process.env.BUGSEE_APP_TOKEN) launch(process.env.BUGSEE_APP_TOKEN); // bugsee-wizard",
    );
  });
});

describe('addSdkInit (review follow-ups)', () => {
  it.each([
    ['export default function launch() {}\n'],
    ['export default class launch {}\n'],
    ['export function launch() {}\n'],
    ['type launch = string;\n'],
    ['interface launch { a: 1 }\n'],
    ['enum launch { A }\n'],
    ['export type launch = number;\n'],
  ])('treats %s as taking the name `launch`', (src) => {
    const out = code(addSdkInit(src, spec({ fileName: 'a.ts' })));
    expect(out).toContain('launch as bugseeLaunch');
  });

  it('a plain top-level assignment is not CommonJS evidence in an ESM package', () => {
    const src = "globalThis.started = Date.now();\nconsole.log('hi');\n";
    const out = code(
      addSdkInit(src, spec({ fileName: 'index.js', packageType: 'module', runtime: 'node' })),
    );
    expect(out).toContain("import { launch } from '@bugsee/bugsee'");
    expect(out).not.toContain('require(');
  });

  it.each([['module.exports = {};\n'], ['exports.a = 1;\n'], ['module.exports.a = 1;\n']])(
    'but %s is',
    (src) => {
      const out = code(
        addSdkInit(src, spec({ fileName: 'index.js', packageType: 'module', runtime: 'node' })),
      );
      expect(out).toContain("require('@bugsee/bugsee')");
    },
  );

  it('with a process.env token, goes after the statement that loads the env file (ESM)', () => {
    const src =
      "import dotenv from 'dotenv';\nimport express from 'express';\ndotenv.config();\nexpress();\n";
    const out = code(
      addSdkInit(src, spec({ tokenExpr: 'process.env.BUGSEE_APP_TOKEN', runtime: 'node' })),
    );
    expect(out.split('\n')).toEqual([
      "import dotenv from 'dotenv';",
      "import express from 'express';",
      'dotenv.config();',
      "import { launch } from '@bugsee/bugsee'; // bugsee-wizard",
      'if (process.env.BUGSEE_APP_TOKEN) launch(process.env.BUGSEE_APP_TOKEN); // bugsee-wizard',
      'express();',
      '',
    ]);
  });

  it('with a process.env token, goes after a CommonJS dotenv call too', () => {
    const src = "const express = require('express');\nrequire('dotenv').config();\nexpress();\n";
    const out = code(
      addSdkInit(
        src,
        spec({ tokenExpr: 'process.env.BUGSEE_APP_TOKEN', runtime: 'node', fileName: 'a.cjs' }),
      ),
    );
    expect(out.split('\n').slice(0, 4)).toEqual([
      "const express = require('express');",
      "require('dotenv').config();",
      "const { launch } = require('@bugsee/bugsee'); // bugsee-wizard",
      'if (process.env.BUGSEE_APP_TOKEN) launch(process.env.BUGSEE_APP_TOKEN); // bugsee-wizard',
    ]);
  });

  it('dotenv is ignored for other token sources', () => {
    const src = "import dotenv from 'dotenv';\ndotenv.config();\nrun();\n";
    const out = code(addSdkInit(src, spec({ tokenExpr: 'import.meta.env.X' })));
    expect(out.split('\n')[1]).toBe("import { launch } from '@bugsee/bugsee'; // bugsee-wizard");
  });
});

describe('addSdkInit (same-line code, env loading, integration checks)', () => {
  const G =
    'if (process.env.BUGSEE_APP_TOKEN) launch(process.env.BUGSEE_APP_TOKEN); // bugsee-wizard';
  const node = { tokenExpr: 'process.env.BUGSEE_APP_TOKEN', runtime: 'node' as const };

  /** The statements of a program, as source text, for comparing programs. */
  const statements = (src: string): string[] =>
    (parseModule(src).$ast as { body: { start: number; end: number }[] }).body.map((n) =>
      src.slice(n.start, n.end),
    );

  it.each([
    ["import a from 'a'; foo();\n", spec(), 'foo();'],
    [
      "const a = require('a'); a.start();\n",
      spec({ fileName: 'a.cjs', runtime: 'node' }),
      'a.start();',
    ],
    ["import {\n  x,\n} from 'x'; /* keep */ const y = 1;\n", spec(), 'const y = 1;'],
    ["import a from 'a';    foo();\nbar();\n", spec(), 'foo();'],
  ])('code after the anchor on the same line keeps running: %j', (src, sp, kept) => {
    const out = code(addSdkInit(src, sp));
    const before = statements(src);
    const after = statements(out);
    // the program minus the two inserted statements is the original program
    const inserted = (s: string): boolean => s.includes('@bugsee/bugsee') || /^launch\(/.test(s);
    expect(after.filter((s) => !inserted(s))).toEqual(before);
    expect(after).toContain(kept);
    expect(out).not.toMatch(/\/\/ bugsee-wizard[^\n]*(?:foo|a\.start|const y)/);
    expect(after.some((s) => /launch\(/.test(s))).toBe(true);
  });

  it('a trailing comment on the anchor line still stays with its statement', () => {
    const out = code(addSdkInit("import a from 'a'; // keep\nrun();\n", spec()));
    expect(out.split('\n').slice(0, 3)).toEqual([
      "import a from 'a'; // keep",
      "import { launch } from '@bugsee/bugsee'; // bugsee-wizard",
      "launch('tok_ABC.123'); // bugsee-wizard",
    ]);
  });

  it.each([
    [
      "import { config } from 'dotenv';\nimport express from 'express';\nconfig();\nexpress();\n",
      'config();',
    ],
    ["import { config as loadEnv } from 'dotenv';\nloadEnv();\nrun();\n", 'loadEnv();'],
    [
      "import * as d from 'dotenv';\nd.config({ path: '.env' });\nrun();\n",
      "d.config({ path: '.env' });",
    ],
    ["import 'dotenv/config';\nimport x from 'x';\nrun();\n", "import x from 'x';"],
    ["import x from 'x';\nprocess.loadEnvFile();\nrun();\n", 'process.loadEnvFile();'],
  ])('ESM env loading is recognised structurally: %j', (src, loader) => {
    const out = code(addSdkInit(src, spec({ ...node })));
    const lines = out.split('\n');
    const at = lines.indexOf(loader);
    expect(at).toBeGreaterThan(-1);
    expect(lines[at + 2]).toBe(G);
  });

  it.each([
    [
      "const express = require('express');\nrequire('dotenv').config();\nrun();\n",
      "require('dotenv').config();",
    ],
    [
      "const dotenv = require('dotenv');\nconst x = require('x');\ndotenv.config();\nrun();\n",
      'dotenv.config();',
    ],
    ["const { config } = require('dotenv');\nconfig();\nrun();\n", 'config();'],
    ["const x = require('x');\nrequire('dotenv/config');\nrun();\n", "require('dotenv/config');"],
  ])('CommonJS env loading is recognised: %j', (src, loader) => {
    const out = code(addSdkInit(src, spec({ ...node, fileName: 'a.cjs' })));
    const lines = out.split('\n');
    const at = lines.indexOf(loader);
    expect(at).toBeGreaterThan(-1);
    expect(lines[at + 1]).toContain("require('@bugsee/bugsee')");
  });

  it('a mention of dotenv that does not load anything does not move the init', () => {
    const src = "import a from 'a';\nconsole.log('dotenv is optional');\nrun();\n";
    const out = code(addSdkInit(src, spec({ ...node })));
    expect(out.split('\n')[1]).toContain("import { launch } from '@bugsee/bugsee'");
  });

  it('never repeats the vite/client reference', () => {
    const src = '/// <reference types="vite/client" />\nimport a from "a";\n';
    const out = code(
      addSdkInit(
        src,
        spec({ tokenExpr: 'import.meta.env.X', fileName: 'main.ts', viteClientTypes: false }),
      ),
    );
    expect(out.match(/vite\/client/g)).toHaveLength(1);
  });

  it.each([
    ["import type { X } from '@bugsee/bugsee';\nrun();\n", false],
    ["import { type X } from 'other';\n", false],
    ["const m = await import('@bugsee/bugsee');\n", true],
    ["async function f() { return import('@bugsee/browser'); }\n", true],
    ["function f() { const { launch } = require('@bugsee/node'); }\n", true],
    ["import '@bugsee/react';\n", true],
    ["import { p } from '@bugsee/vite-plugin';\n", false],
    ["import w from '@bugsee/wizard';\n", false],
    ["import n from '@bugsee/react-native';\n", false],
  ])('integration check %j -> %s', (src, expected) => {
    expect(hasSdkIntegration(src)).toBe(expected);
  });

  it('escapes the JavaScript line separators in a literal token', () => {
    const ls = String.fromCharCode(0x2028);
    const ps = String.fromCharCode(0x2029);
    const out = code(addSdkInit('run();\n', spec({ token: `a${ls}b${ps}c` })));
    expect(out).toContain("launch('a\\u2028b\\u2029c');");
    expect(out.includes(ls) || out.includes(ps)).toBe(false);
  });
});
