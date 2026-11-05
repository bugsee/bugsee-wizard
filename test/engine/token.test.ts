import { beforeEach, describe, expect, it, vi } from 'vitest';

const prompts = vi.hoisted(() => ({
  password: vi.fn(),
  isCancel: vi.fn((v: unknown) => typeof v === 'symbol'),
}));
vi.mock('@clack/prompts', () => prompts);

import { MissingInputError } from '../../src/engine/noninteractive.js';
import {
  CancelledError,
  MAX_TOKEN_LENGTH,
  normalizeToken,
  selectTokenSource,
} from '../../src/engine/token.js';

const SECRET = 'tok_SUPER_secret_123';

describe('normalizeToken', () => {
  it('returns a clean token unchanged', () => {
    expect(normalizeToken(SECRET)).toBe(SECRET);
  });
  it('trims whitespace, newlines and CR', () => {
    expect(normalizeToken(`  \t${SECRET}\r\n`)).toBe(SECRET);
  });
  it('strips one pair of double or single quotes', () => {
    expect(normalizeToken(`"${SECRET}"`)).toBe(SECRET);
    expect(normalizeToken(`'${SECRET}'`)).toBe(SECRET);
  });
  it('strips quotes after trimming, and trims inside the quotes', () => {
    expect(normalizeToken(` "  ${SECRET} " \n`)).toBe(SECRET);
  });
  it('strips only ONE pair', () => {
    expect(normalizeToken(`""${SECRET}""`)).toBe(`"${SECRET}"`);
  });
  it('does not strip mismatched or lone quotes', () => {
    expect(normalizeToken(`"${SECRET}'`)).toBe(`"${SECRET}'`);
    expect(normalizeToken(`"abc`)).toBe(`"abc`);
  });
  it('a lone quote character is a (weird) token, not an empty one', () => {
    expect(normalizeToken('"')).toBe('"');
  });
  it('rejects empty values without leaking them', () => {
    for (const raw of ['', '   ', '\r\n', '""', "' '"]) {
      expect(() => normalizeToken(raw)).toThrow(Error);
    }
  });
  it('rejects inner whitespace; message lacks the value', () => {
    const bad = 'abc def_SECRETPART';
    try {
      normalizeToken(bad);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('abc');
      expect((e as Error).message).not.toContain('SECRETPART');
    }
    expect(() => normalizeToken('a\tb')).toThrow();
    expect(() => normalizeToken('a\nb')).toThrow();
  });
  it('accepts any non-empty token (no format check)', () => {
    expect(normalizeToken('x')).toBe('x');
    expect(normalizeToken('!@#$%^&*()')).toBe('!@#$%^&*()');
  });
  it('enforces the 512 max length without leaking', () => {
    expect(MAX_TOKEN_LENGTH).toBe(512);
    expect(normalizeToken('a'.repeat(512))).toHaveLength(512);
    const long = `ZZ${'a'.repeat(511)}`;
    try {
      normalizeToken(long);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('ZZ');
    }
  });
});

describe('selectTokenSource', () => {
  beforeEach(() => {
    prompts.password.mockReset();
  });

  it('flag wins over env and is normalized', async () => {
    const s = selectTokenSource({
      flag: `"${SECRET}"`,
      env: { BUGSEE_APP_TOKEN: 'envtok' },
      nonInteractive: false,
    });
    expect(s.kind).toBe('flag');
    expect(await s.get()).toBe(SECRET);
    expect(prompts.password).not.toHaveBeenCalled();
  });
  it('uses BUGSEE_APP_TOKEN when no flag', async () => {
    const s = selectTokenSource({
      env: { BUGSEE_APP_TOKEN: ` ${SECRET}\n` },
      nonInteractive: true,
    });
    expect(s.kind).toBe('env');
    expect(await s.get()).toBe(SECRET);
  });
  it('ignores BUGSEE_WIZARD_TOKEN and empty values', async () => {
    const s = selectTokenSource({
      flag: '',
      env: { BUGSEE_WIZARD_TOKEN: 'nope', BUGSEE_APP_TOKEN: '' },
      nonInteractive: true,
    });
    expect(s.kind).toBe('paste');
    await expect(s.get()).rejects.toBeInstanceOf(MissingInputError);
  });
  it('non-interactive with no input: MissingInputError(token), never prompts', async () => {
    const s = selectTokenSource({ env: {}, nonInteractive: true });
    expect(s.kind).toBe('paste');
    const err = await s.get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MissingInputError);
    expect((err as MissingInputError).field).toBe('token');
    expect(prompts.password).not.toHaveBeenCalled();
  });
  it('interactive: masked password prompt, normalized result', async () => {
    prompts.password.mockResolvedValue(`'${SECRET}'`);
    const s = selectTokenSource({ env: {}, nonInteractive: false });
    expect(s.kind).toBe('paste');
    expect(await s.get()).toBe(SECRET);
    expect(prompts.password).toHaveBeenCalledTimes(1);
  });
  it('interactive prompt validates via normalizeToken without echoing the value', async () => {
    prompts.password.mockResolvedValue(SECRET);
    await selectTokenSource({ env: {}, nonInteractive: false }).get();
    const arg = prompts.password.mock.calls[0]?.[0] as {
      validate: (v: string | undefined) => string | undefined;
    };
    expect(arg.validate('')).toBeTypeOf('string');
    expect(arg.validate('a b')).toBeTypeOf('string');
    expect(arg.validate('a b') ?? '').not.toContain('a b');
    expect(arg.validate(SECRET)).toBeUndefined();
  });
  it('cancel throws CancelledError', async () => {
    prompts.password.mockResolvedValue(Symbol('cancel'));
    await expect(
      selectTokenSource({ env: {}, nonInteractive: false }).get(),
    ).rejects.toBeInstanceOf(CancelledError);
  });
  it('an invalid flag token throws without the value in the message', async () => {
    const s = selectTokenSource({ flag: 'bad SECRETVALUE', env: {}, nonInteractive: true });
    const err = await s.get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain('SECRETVALUE');
  });
  it('never writes the token to console or stdout/stderr', async () => {
    const spies = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(process.stdout, 'write'),
      vi.spyOn(process.stderr, 'write'),
    ];
    await selectTokenSource({ flag: SECRET, env: {}, nonInteractive: true }).get();
    await selectTokenSource({ env: { BUGSEE_APP_TOKEN: SECRET }, nonInteractive: true }).get();
    for (const s of spies) {
      expect(JSON.stringify(s.mock.calls)).not.toContain(SECRET);
    }
    vi.restoreAllMocks();
  });
});
