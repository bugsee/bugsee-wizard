import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBaseProgram } from '../../src/cli-program.js';
import {
  buildOptions,
  CANCELLED_MESSAGE,
  MissingInputError,
  outcomeForError,
  readStdinToken,
  reportError,
  resolveOptions,
} from '../../src/engine/noninteractive.js';
import { CancelledError } from '../../src/engine/token.js';

afterEach(() => vi.restoreAllMocks());
const base = { cwd: '/p', debug: false, dryRun: false };

const BOOLS = [
  ['nonInteractive', 'BUGSEE_WIZARD_NON_INTERACTIVE'],
  ['json', 'BUGSEE_WIZARD_JSON'],
  ['ignoreGitChanges', 'BUGSEE_WIZARD_IGNORE_GIT_CHANGES'],
  ['yes', 'BUGSEE_WIZARD_YES'],
] as const;

describe('buildOptions tri-state booleans', () => {
  it.each(BOOLS)('%s: flag false beats env true', (key, envKey) => {
    expect(buildOptions({ ...base, [key]: false }, { [envKey]: '1' })[key]).toBe(false);
  });
  it.each(BOOLS)('%s: flag true beats env false', (key, envKey) => {
    expect(buildOptions({ ...base, [key]: true }, { [envKey]: '0' })[key]).toBe(true);
  });
  it.each(BOOLS)('%s: absent flag uses env; absent both is false', (key, envKey) => {
    expect(buildOptions(base, { [envKey]: 'yes' })[key]).toBe(true);
    expect(buildOptions(base, {})[key]).toBe(false);
  });
});

describe('empty string options are absent', () => {
  it('empty/whitespace --package falls back to env', () => {
    expect(
      buildOptions({ ...base, package: '' }, { BUGSEE_WIZARD_PACKAGE: 'envpkg' }).package,
    ).toBe('envpkg');
    expect(
      buildOptions({ ...base, package: '  ' }, { BUGSEE_WIZARD_PACKAGE: 'envpkg' }).package,
    ).toBe('envpkg');
  });
  it('empty --token is omitted', () => {
    expect('token' in buildOptions({ ...base, token: '' }, {})).toBe(false);
    expect('token' in buildOptions({ ...base, token: '  ' }, {})).toBe(false);
  });
});

describe('--token - (stdin)', () => {
  const SECRET = 'tok_STDIN_secret';
  it('resolveOptions reads stdin when token is "-"', async () => {
    const readStdin = vi.fn().mockResolvedValue(`${SECRET}\n`);
    const o = await resolveOptions({ ...base, token: '-' }, {}, { readStdin, isTTY: false });
    expect(o.token).toBe(SECRET);
    expect(readStdin).toHaveBeenCalledTimes(1);
  });
  it('does not read stdin for a normal token or no token', async () => {
    const readStdin = vi.fn();
    expect(
      (await resolveOptions({ ...base, token: 'abc' }, {}, { readStdin, isTTY: false })).token,
    ).toBe('abc');
    expect('token' in (await resolveOptions(base, {}, { readStdin, isTTY: false }))).toBe(false);
    expect(readStdin).not.toHaveBeenCalled();
  });
  it('TTY stdin without non-interactive is MissingInputError(token), no read', async () => {
    const readStdin = vi.fn();
    const err = await resolveOptions({ ...base, token: '-' }, {}, { readStdin, isTTY: true }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(MissingInputError);
    expect(err.field).toBe('token');
    expect(readStdin).not.toHaveBeenCalled();
  });
  it('TTY stdin with non-interactive still reads (caller asked for it)', async () => {
    const readStdin = vi.fn().mockResolvedValue(SECRET);
    const o = await resolveOptions(
      { ...base, token: '-', nonInteractive: true },
      {},
      { readStdin, isTTY: true },
    );
    expect(o.token).toBe(SECRET);
  });
  it('empty stdin is MissingInputError', async () => {
    const readStdin = vi.fn().mockResolvedValue('  \n');
    await expect(
      resolveOptions({ ...base, token: '-' }, {}, { readStdin, isTTY: false }),
    ).rejects.toBeInstanceOf(MissingInputError);
  });
  it('takes only the first line', async () => {
    const readStdin = vi.fn().mockResolvedValue(`${SECRET}\nsecond\n`);
    expect(
      (await resolveOptions({ ...base, token: '-' }, {}, { readStdin, isTTY: false })).token,
    ).toBe(SECRET);
  });
  it('the value never reaches errors, console, stdout or stderr', async () => {
    const spies = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'error'),
      vi.spyOn(process.stdout, 'write'),
      vi.spyOn(process.stderr, 'write'),
    ];
    const readStdin = vi.fn().mockResolvedValue(`${SECRET} extra\n`);
    await resolveOptions({ ...base, token: '-' }, {}, { readStdin, isTTY: false });
    const err = await resolveOptions(
      { ...base, token: '-' },
      {},
      { readStdin: async () => '', isTTY: false },
    ).catch((e) => e);
    expect(String(err.message)).not.toContain(SECRET);
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(SECRET);
  });
  it('readStdinToken returns at the first newline without waiting for EOF', async () => {
    async function* hang(): AsyncGenerator<string> {
      yield 'tok\nmore';
      await new Promise(() => undefined);
    }
    expect(await readStdinToken(hang())).toBe('tok');
  });
  it('readStdinToken reads one line from a stream', async () => {
    const { Readable } = await import('node:stream');
    expect(await readStdinToken(Readable.from([`${SECRET}\nrest`]))).toBe(
      `${SECRET}\n`.trimEnd() + '',
    );
  });
});

describe('outcomeForError (cancel mapping)', () => {
  it('CancelledError exits 0 with a plain message', () => {
    expect(outcomeForError(new CancelledError())).toEqual({
      code: 0,
      message: CANCELLED_MESSAGE,
      level: 'plain',
    });
    expect(CANCELLED_MESSAGE).toBe('Cancelled.');
  });
  it('other errors exit 1 as errors', () => {
    expect(outcomeForError(new Error('boom'))).toEqual({
      code: 1,
      message: 'boom',
      level: 'error',
    });
    expect(outcomeForError('x')).toEqual({ code: 1, message: 'x', level: 'error' });
  });
  it('MissingInputError exits 2', () => {
    expect(outcomeForError(new MissingInputError('token')).code).toBe(2);
  });
});

describe('program definition', () => {
  const help = createBaseProgram().helpInformation().replace(/\s+/g, ' ');
  it('lists the negations', () => {
    for (const f of [
      '--no-non-interactive',
      '--no-json',
      '--no-telemetry',
      '--no-ignore-git-changes',
      '--no-yes',
    ]) {
      expect(help).toContain(f);
    }
  });
  it('token help warns about ps and names the safe paths', () => {
    expect(help).toContain('visible to other users in the process list');
    expect(help).toContain('BUGSEE_APP_TOKEN');
    expect(help).toContain('--token -');
  });
  it('booleans are undefined when absent, false with a negation, true with the flag', () => {
    const parse = (args: string[]) => {
      const p = createBaseProgram().exitOverride();
      p.parse(args, { from: 'user' });
      return p.opts();
    };
    expect(parse([]).json).toBeUndefined();
    expect(parse(['--no-json']).json).toBe(false);
    expect(parse(['--json']).json).toBe(true);
    for (const k of ['nonInteractive', 'telemetry', 'ignoreGitChanges', 'yes'] as const) {
      expect(parse([])[k]).toBeUndefined();
    }
    expect(parse(['--no-yes']).yes).toBe(false);
    expect(parse(['--no-telemetry']).telemetry).toBe(false);
    expect(parse(['--no-ignore-git-changes']).ignoreGitChanges).toBe(false);
    expect(parse(['--no-non-interactive']).nonInteractive).toBe(false);
  });
  it('--sdk-version carries a string through to buildOptions and names its env var', () => {
    const p = createBaseProgram().exitOverride();
    p.parse(['--sdk-version', '0.1.0-beta.7'], { from: 'user' });
    expect(buildOptions(p.opts(), {}).sdkVersion).toBe('0.1.0-beta.7');
    expect(help).toContain('BUGSEE_WIZARD_SDK_VERSION');
  });
});

describe('reportError (top-level CLI errors)', () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    const logged: string[] = [];
    return {
      out,
      err,
      logged,
      io: {
        stdout: (s: string) => out.push(s),
        stderr: (s: string) => err.push(s),
        error: (m: string) => logged.push(m),
      },
    };
  };

  it('--json: MissingInputError is one JSON object on stdout, exit 2, never the value', () => {
    const c = io();
    expect(reportError(new MissingInputError('token'), { json: true }, c.io)).toBe(2);
    expect(c.out).toHaveLength(1);
    expect(JSON.parse(c.out.join(''))).toEqual({
      ok: false,
      incomplete: false,
      steps: [],
      error: 'missing-input',
      field: 'token',
      message: 'missing required input: token',
    });
    expect(c.logged).toEqual([]);
  });

  it('--json: any other error is one JSON object, exit 1', () => {
    const c = io();
    expect(reportError(new Error('boom'), { json: true }, c.io)).toBe(1);
    expect(JSON.parse(c.out.join(''))).toEqual({
      ok: false,
      incomplete: false,
      steps: [],
      error: 'error',
      message: 'boom',
    });
  });

  it('cancel: exit 0, a plain message on stderr, nothing on stdout (json or not)', () => {
    for (const json of [true, false]) {
      const c = io();
      expect(reportError(new CancelledError(), { json }, c.io)).toBe(0);
      expect(c.out).toEqual([]);
      expect(c.err.join('')).toBe('Cancelled.\n');
    }
  });

  it('without --json: errors go to the error logger, stdout untouched', () => {
    const c = io();
    expect(reportError(new MissingInputError('package'), { json: false }, c.io)).toBe(2);
    expect(c.logged).toEqual(['missing required input: package']);
    expect(c.out).toEqual([]);
  });
});
