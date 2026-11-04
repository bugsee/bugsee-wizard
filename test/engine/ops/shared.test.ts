import { describe, expect, it } from 'vitest';
import { resolveInside } from '../../../src/engine/ops/shared.js';

describe('resolveInside', () => {
  it('resolves nested relative paths under the directory', () => {
    expect(resolveInside('/p', 'a/b.txt')).toBe('/p/a/b.txt');
    expect(resolveInside('/p', 'a/../b.txt')).toBe('/p/b.txt');
  });

  it('accepts names that merely start with two dots', () => {
    expect(resolveInside('/p', '..hidden')).toBe('/p/..hidden');
  });

  it('refuses the directory itself, its parent, escapes and absolute paths', () => {
    for (const bad of ['', '.', '..', '../x', 'a/../../x', '/etc/passwd']) {
      expect(() => resolveInside('/p', bad), bad).toThrow(/escapes the package directory/);
    }
  });
});
