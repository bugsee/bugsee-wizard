import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildOptions,
  createOutput,
  createStderrLogger,
  exitCodeFor,
  formatJsonResult,
  MissingInputError,
  readEnvFlags,
  type WizardRunResult,
} from '../../src/engine/noninteractive.js';

afterEach(() => vi.restoreAllMocks());

describe('readEnvFlags', () => {
  it('defaults all false/undefined', () => {
    expect(readEnvFlags({})).toEqual({
      nonInteractive: false,
      json: false,
      telemetry: false,
      ignoreGitChanges: false,
      yes: false,
      package: undefined,
    });
  });
  it.each(['1', 'true', 'yes', 'TRUE', 'Yes'])('truthy %s', (v) => {
    expect(readEnvFlags({ BUGSEE_WIZARD_JSON: v }).json).toBe(true);
  });
  it.each(['0', 'false', 'no', '', 'maybe'])('falsy %s', (v) => {
    expect(readEnvFlags({ BUGSEE_WIZARD_JSON: v }).json).toBe(false);
  });
  it('maps each variable to its own field', () => {
    expect(
      readEnvFlags({
        BUGSEE_WIZARD_NON_INTERACTIVE: '1',
        BUGSEE_WIZARD_TELEMETRY: 'true',
        BUGSEE_WIZARD_IGNORE_GIT_CHANGES: 'yes',
        BUGSEE_WIZARD_YES: '1',
        BUGSEE_WIZARD_PACKAGE: 'apps/web',
      }),
    ).toEqual({
      nonInteractive: true,
      json: false,
      telemetry: true,
      ignoreGitChanges: true,
      yes: true,
      package: 'apps/web',
    });
  });
  it('empty package env is undefined', () => {
    expect(readEnvFlags({ BUGSEE_WIZARD_PACKAGE: '' }).package).toBeUndefined();
  });
});

describe('buildOptions', () => {
  const base = { cwd: '/p', debug: false, dryRun: false };
  it('defaults to false', () => {
    expect(buildOptions(base, {})).toEqual({
      cwd: '/p',
      debug: false,
      dryRun: false,
      nonInteractive: false,
      json: false,
      ignoreGitChanges: false,
      yes: false,
    });
  });
  it('env used when flag absent', () => {
    const o = buildOptions(base, {
      BUGSEE_WIZARD_NON_INTERACTIVE: '1',
      BUGSEE_WIZARD_JSON: '1',
      BUGSEE_WIZARD_YES: '1',
      BUGSEE_WIZARD_IGNORE_GIT_CHANGES: 'true',
      BUGSEE_WIZARD_PACKAGE: 'envpkg',
      BUGSEE_APP_TOKEN: 'envtok',
    });
    expect(o).toMatchObject({
      nonInteractive: true,
      json: true,
      yes: true,
      ignoreGitChanges: true,
      package: 'envpkg',
    });
    expect(o.token).toBeUndefined();
  });
  it('explicit flag beats env (string options)', () => {
    const o = buildOptions(
      { ...base, package: 'flagpkg', token: 'flagtok' },
      { BUGSEE_WIZARD_PACKAGE: 'envpkg' },
    );
    expect(o.package).toBe('flagpkg');
    expect(o.token).toBe('flagtok');
  });
  it('explicit flag beats env (booleans: flag true stays true)', () => {
    const o = buildOptions({ ...base, json: true, yes: true }, { BUGSEE_WIZARD_JSON: '0' });
    expect(o.json).toBe(true);
    expect(o.yes).toBe(true);
  });
  it('explicit false flag beats truthy env', () => {
    const o = buildOptions({ ...base, json: false }, { BUGSEE_WIZARD_JSON: '1' });
    expect(o.json).toBe(false);
  });
  it('flag beats env for yes and ignoreGitChanges in both directions', () => {
    const on = { BUGSEE_WIZARD_YES: '1', BUGSEE_WIZARD_IGNORE_GIT_CHANGES: '1' };
    const off = buildOptions({ ...base, yes: false, ignoreGitChanges: false }, on);
    expect(off).toMatchObject({ yes: false, ignoreGitChanges: false });
    const set = buildOptions({ ...base, yes: true, ignoreGitChanges: true }, {});
    expect(set).toMatchObject({ yes: true, ignoreGitChanges: true });
  });
  it('token comes from the flag only; env token is left to selectTokenSource', () => {
    expect(buildOptions({ ...base, token: 't' }, { BUGSEE_APP_TOKEN: 'e' }).token).toBe('t');
  });
  it('omits package/token keys when absent (exactOptionalPropertyTypes)', () => {
    const o = buildOptions(base, {});
    expect('package' in o).toBe(false);
    expect('token' in o).toBe(false);
  });
});

describe('MissingInputError', () => {
  it('carries the field', () => {
    const e = new MissingInputError('token');
    expect(e).toBeInstanceOf(Error);
    expect(e.field).toBe('token');
    expect(e.name).toBe('MissingInputError');
    expect(e.message).toContain('token');
  });
});

describe('exitCodeFor', () => {
  const r = (o: Partial<WizardRunResult>): WizardRunResult => ({
    ok: true,
    incomplete: false,
    steps: [],
    ...o,
  });
  it('0 ok', () => expect(exitCodeFor(r({}), true)).toBe(0));
  it('1 failed', () => expect(exitCodeFor(r({ ok: false }), true)).toBe(1));
  it('2 missing-input', () =>
    expect(exitCodeFor(r({ ok: false, error: 'missing-input', field: 'token' }), true)).toBe(2));
  it('3 incomplete in non-interactive', () =>
    expect(exitCodeFor(r({ incomplete: true }), true)).toBe(3));
  it('incomplete interactive is 0', () =>
    expect(exitCodeFor(r({ incomplete: true }), false)).toBe(0));
  it('failed beats incomplete', () =>
    expect(exitCodeFor(r({ ok: false, incomplete: true }), true)).toBe(1));
});

describe('formatJsonResult', () => {
  it('prints exactly one JSON object line on stdout', () => {
    const w = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    formatJsonResult({ ok: true, incomplete: false, steps: [{ id: 'a', outcome: 'applied' }] });
    expect(w).toHaveBeenCalledTimes(1);
    const text = String(w.mock.calls[0]?.[0]);
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual({
      ok: true,
      incomplete: false,
      steps: [{ id: 'a', outcome: 'applied' }],
    });
  });
  it('includes error and field for missing input', () => {
    const w = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    formatJsonResult({
      ok: false,
      incomplete: false,
      steps: [],
      error: 'missing-input',
      field: 'token',
    });
    expect(JSON.parse(String(w.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      incomplete: false,
      steps: [],
      error: 'missing-input',
      field: 'token',
    });
  });
});

describe('stderr logger and createOutput', () => {
  it('stderr logger writes every level to stderr, never stdout', () => {
    const e = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const o = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const l = createStderrLogger({ debug: true });
    l.info('i');
    l.warn('w');
    l.error('e');
    l.success('s');
    l.step('st');
    l.debug('d');
    expect(e).toHaveBeenCalledTimes(6);
    expect(o).not.toHaveBeenCalled();
    expect(String(e.mock.calls[5]?.[0])).toContain('d');
  });
  it('stderr logger suppresses debug unless enabled', () => {
    const e = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    createStderrLogger({ debug: false }).debug('hidden');
    expect(e).not.toHaveBeenCalled();
  });
  it('createOutput({json:true}).log goes to stderr; result prints JSON on stdout', () => {
    const e = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const o = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const out = createOutput({ json: true, debug: false });
    out.log.info('hello');
    expect(e).toHaveBeenCalledTimes(1);
    out.result({ ok: true, incomplete: false, steps: [] });
    expect(o).toHaveBeenCalledTimes(1);
  });
  it('createOutput({json:false}) uses the clack logger and result prints nothing', () => {
    const e = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const o = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const out = createOutput({ json: false, debug: false });
    out.result({ ok: true, incomplete: false, steps: [] });
    expect(o).not.toHaveBeenCalled();
    expect(e).not.toHaveBeenCalled();
  });
  it("a token passed to the logger is the caller's business; the logger adds nothing secret", () => {
    const e = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    createStderrLogger({ debug: true }).info('no secrets here');
    expect(String(e.mock.calls[0]?.[0])).not.toContain('tok_');
  });
});
