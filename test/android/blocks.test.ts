import { describe, expect, it } from 'vitest';

import { findBlock, findMatchingBrace } from '../../src/recipes/android/blocks.js';

describe('findMatchingBrace', () => {
  it('returns the matching close index for nested braces', () => {
    const s = 'a { b { c } d } e';
    expect(findMatchingBrace(s, 2)).toBe(14);
  });

  it('returns null when there is no matching close', () => {
    const s = '{ unclosed';
    expect(findMatchingBrace(s, 0)).toBeNull();
  });

  it('returns null when the open index is not a brace', () => {
    expect(findMatchingBrace('x {}', 0)).toBeNull();
  });
});

describe('findBlock', () => {
  it('locates a top-level Gradle block by name', () => {
    const s = 'pluginManagement {\n    repositories {\n    }\n}\n';
    const block = findBlock(s, 'pluginManagement');
    expect(block).not.toBeNull();
    expect(block?.openBrace).toBe(s.indexOf('{'));
    expect(block?.closeBrace).toBe(s.lastIndexOf('}'));
  });

  it('returns null when the block is absent', () => {
    expect(findBlock('rootProject.name = "x"', 'pluginManagement')).toBeNull();
  });

  it('does not match a block whose name is a substring of an identifier', () => {
    const s = `myPluginManagement {}\nrootProject.name = "x"`;
    expect(findBlock(s, 'pluginManagement')).toBeNull();
  });

  it('returns the first matching block', () => {
    const s = 'repositories {\n    google()\n}\nrepositories {\n    mavenCentral()\n}\n';
    const block = findBlock(s, 'repositories');
    if (!block) throw new Error('expected a block');
    const body = s.slice(block.bodyStart, block.bodyEnd);
    expect(body).toContain('google()');
    expect(body).not.toContain('mavenCentral()');
  });
});
