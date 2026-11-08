import { describe, expect, it } from 'vitest';
import { stringifyLike } from '../src/core/json-text.js';

describe('stringifyLike', () => {
  it('keeps CRLF, indent and trailing newline', () => {
    expect(stringifyLike({ a: { b: 1 } }, '{\r\n    "a": 0\r\n}\r\n')).toBe(
      '{\r\n    "a": {\r\n        "b": 1\r\n    }\r\n}\r\n',
    );
  });
  it('keeps LF and no trailing newline; defaults to 2 spaces', () => {
    expect(stringifyLike({ a: 1 }, '{}')).toBe('{\n  "a": 1\n}');
    expect(stringifyLike({ a: 1 }, '{}\n')).toBe('{\n  "a": 1\n}\n');
  });
  it('CRLF without trailing newline adds none', () => {
    expect(stringifyLike({ a: 1 }, '{\r\n  "a": 0\r\n}')).toBe('{\r\n  "a": 1\r\n}');
  });
});
