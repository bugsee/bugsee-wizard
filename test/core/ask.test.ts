import { beforeEach, describe, expect, it, vi } from 'vitest';

const clack = vi.hoisted(() => ({
  confirm: vi.fn(),
  select: vi.fn(),
  isCancel: (v: unknown) => v === Symbol.for('cancel'),
  log: { info: vi.fn() },
}));
vi.mock('@clack/prompts', () => clack);

import { confirm, select } from '../../src/core/ask.js';

beforeEach(() => vi.clearAllMocks());

describe('confirm', () => {
  it('without --yes it asks and returns the answer, cancel included', async () => {
    clack.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(Symbol.for('cancel'));
    expect(await confirm(false, { message: 'Q?', initialValue: false })).toBe(true);
    expect(clack.confirm).toHaveBeenCalledWith({ message: 'Q?', initialValue: false });
    expect(await confirm(undefined, { message: 'Q?', initialValue: false })).toBe(
      Symbol.for('cancel'),
    );
  });

  it('with --yes it takes the prompt default without asking, and says so', async () => {
    expect(await confirm(true, { message: 'NDK?', initialValue: false })).toBe(false);
    expect(await confirm(true, { message: 'pod install?', initialValue: true })).toBe(true);
    expect(clack.confirm).not.toHaveBeenCalled();
    expect(clack.log.info).toHaveBeenCalledWith(expect.stringContaining('NDK?'));
    expect(clack.log.info).toHaveBeenCalledWith(expect.stringMatching(/NDK\?.*\bno\b/i));
    expect(clack.log.info).toHaveBeenCalledWith(expect.stringMatching(/pod install\?.*\byes\b/i));
  });

  it('assume: a gate on the action the user invoked is answered yes whatever its default', async () => {
    expect(await confirm(true, { message: 'Remove?', initialValue: false, assume: true })).toBe(
      true,
    );
    expect(clack.confirm).not.toHaveBeenCalled();
    // and without --yes the assumption is ignored
    clack.confirm.mockResolvedValueOnce(false);
    expect(await confirm(false, { message: 'Remove?', initialValue: false, assume: true })).toBe(
      false,
    );
  });
});

describe('select', () => {
  const options = [
    { value: 'a', label: 'Option A' },
    { value: 'b', label: 'Option B' },
  ];

  it('without --yes it asks', async () => {
    clack.select.mockResolvedValueOnce('b');
    expect(await select(false, { message: 'Pick', options, initialValue: 'a' })).toBe('b');
    expect(clack.select).toHaveBeenCalled();
  });

  it('with --yes and a default it takes the default without asking, naming its label', async () => {
    expect(await select(true, { message: 'Pick', options, initialValue: 'b' })).toBe('b');
    expect(clack.select).not.toHaveBeenCalled();
    expect(clack.log.info).toHaveBeenCalledWith(expect.stringMatching(/Pick.*Option B/));
  });

  it('with --yes but no default it still asks: there is nothing to assume', async () => {
    clack.select.mockResolvedValueOnce('a');
    expect(await select(true, { message: 'Pick', options })).toBe('a');
    expect(clack.select).toHaveBeenCalled();
    expect(clack.log.info).not.toHaveBeenCalled();
  });
});
