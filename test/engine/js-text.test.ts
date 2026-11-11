import { describe, expect, it } from 'vitest';
import { stripHtmlComments, stripJsComments } from '../../src/engine/js-text.js';

describe('stripJsComments', () => {
  it('removes line and block comments, keeping the code and the line structure', () => {
    expect(stripJsComments('a(); // x\nb(); /* y\n z */ c();\n')).toBe('a(); \nb();   c();\n');
  });

  it('keeps comment markers inside strings and templates', () => {
    const src = 'const u = \'http://x\'; const v = "/* no */"; const w = `// no ${1}`;\n';
    expect(stripJsComments(src)).toBe(src);
  });

  it('an unterminated block comment hides the rest, like the language says', () => {
    expect(stripJsComments('a();\n/* never closed\nb();')).toBe('a();\n ');
  });

  it('a regular expression literal containing /* is not a comment (the code after it is kept)', () => {
    const src =
      "const trim = (s) => s.replace(/\\/*$/, '');\nconst b = await import('@bugsee/bugsee');\n";
    expect(stripJsComments(src)).toContain("import('@bugsee/bugsee')");
    const more = "x = /[/*]/.test(y);\nrequire('@bugsee/node');\n";
    expect(stripJsComments(more)).toContain("require('@bugsee/node')");
  });

  it('a division is not a regular expression', () => {
    expect(stripJsComments('const r = a / b; // note\nimport("@bugsee/x");')).toContain(
      'import("@bugsee/x")',
    );
    expect(stripJsComments('f(a / 2) /* c */ + b / 3;')).toBe('f(a / 2)   + b / 3;');
  });

  it('a quote inside a regular expression character class does not start a string', () => {
    expect(stripJsComments("x = /[/'\"]/; // note 'quote\nrequire('@bugsee/node')")).toBe(
      "x = /[/'\"]/; \nrequire('@bugsee/node')",
    );
  });

  it('an apostrophe in JSX or markup text is not a string: a later commented-out import is stripped', () => {
    expect(stripJsComments("const a = <p>it's</p>;\n// require('@bugsee/bugsee')\n")).not.toContain(
      '@bugsee',
    );
    expect(stripJsComments('<h1>Don\'t</h1>\n/* import "@bugsee/bugsee" */\nx();')).not.toContain(
      '@bugsee',
    );
  });

  it('the same on one line: a comment after the apostrophe or the keyword regex is stripped', () => {
    expect(stripJsComments("const a = <p>it's</p>; // todo")).not.toContain('todo');
    expect(
      stripJsComments(
        "const q = (s) => { return /'/.test(s); }; // import x from '@bugsee/bugsee'",
      ),
    ).not.toContain('@bugsee');
  });

  it('a regular expression after a keyword (return, typeof, case ...) is a pattern', () => {
    for (const kw of [
      'return',
      'typeof',
      'case',
      'yield',
      'await',
      'void',
      'delete',
      'else',
      'throw',
    ]) {
      const src = `function f(s) { ${kw} /'/.test(s); }\n// import x from '@bugsee/bugsee'\n`;
      expect(stripJsComments(src), kw).not.toContain('@bugsee');
    }
  });

  it('a name that merely ends like a keyword is a value, so / is a division', () => {
    expect(stripJsComments("const x = myreturn / 2; // c 'q\nimport('@bugsee/x');")).toContain(
      "import('@bugsee/x')",
    );
  });

  it('a template literal may span lines, a quoted string may not', () => {
    expect(stripJsComments('const t = `a\n// not a comment`;\n')).toBe(
      'const t = `a\n// not a comment`;\n',
    );
  });

  it('a regular expression right after an arrow is a pattern (/* inside it is not a comment)', () => {
    const src = "const t = (s) => /a\\/*b/.test(s);\nconst b = await import('@bugsee/bugsee');\n";
    expect(stripJsComments(src)).toContain("import('@bugsee/bugsee')");
  });

  it('a closing tag followed by a comment on the same line is stripped', () => {
    expect(stripJsComments("const a = <div>x</div>; // import '@bugsee/bugsee'\n")).not.toContain(
      '@bugsee',
    );
  });

  describe('markup files (.html, .vue, .svelte, .astro)', () => {
    it('a lone backtick in text does not run to the end of the file', () => {
      const src = "<p>press the ` key</p>\n// import '@bugsee/bugsee'\n";
      expect(stripJsComments(src, { markup: true })).not.toContain('@bugsee');
    });
    it('a template literal on one line is still a string in markup', () => {
      const src = 'const t = `// not a comment`;\n';
      expect(stripJsComments(src, { markup: true })).toBe(src);
    });
  });
});

describe('stripHtmlComments', () => {
  it('reads left to right: an unterminated comment runs to the end, leftovers never form a new comment', () => {
    expect(stripHtmlComments('a<!-- x -->b')).toBe('ab');
    expect(stripHtmlComments('a<!-- never closed')).toBe('a');
    expect(stripHtmlComments('<!<!-- x -->-- y')).toBe('<!-- y');
  });
});
