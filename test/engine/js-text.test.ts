import { describe, expect, it } from 'vitest';
import { stripJsComments } from '../../src/engine/js-text.js';

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
});
