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

  it('casts process.env to string in TypeScript only', () => {
    const t = { tokenExpr: 'process.env.BUGSEE_APP_TOKEN' };
    expect(code(addSdkInit('run();\n', spec({ ...t, fileName: 'server.ts' })))).toContain(
      'launch(process.env.BUGSEE_APP_TOKEN as string);',
    );
    expect(code(addSdkInit('run();\n', spec({ ...t, fileName: 'server.js' })))).toContain(
      'launch(process.env.BUGSEE_APP_TOKEN);',
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
      "const { launch } = require('@bugsee/bugsee'); // bugsee-wizard\nlaunch(process.env.BUGSEE_APP_TOKEN as string); // bugsee-wizard",
    );
  });
});
