import { describe, expect, it, vi } from 'vitest';

import { buildOptions } from '../../src/engine/noninteractive.js';
import { REGISTRY_URL, resolveSdkVersion } from '../../src/web/sdk-version.js';
import { SDK_FALLBACK_VERSION, SDK_TAG } from '../../src/web/versions.js';

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

const fetchReturning = (...responses: Array<Response | Error>) => {
  const fn = vi.fn<typeof fetch>();
  for (const r of responses) {
    if (r instanceof Error) fn.mockRejectedValueOnce(r);
    else fn.mockResolvedValueOnce(r);
  }
  return fn;
};

const logSink = () => {
  const lines: string[] = [];
  const sink = (m: string): void => {
    lines.push(m);
  };
  return {
    lines,
    log: { info: sink, warn: sink, error: sink, success: sink, step: sink, debug: sink },
  };
};

describe('versions table', () => {
  it('installs the beta dist-tag and keeps one fallback version', () => {
    expect(SDK_TAG).toBe('beta');
    expect(SDK_FALLBACK_VERSION).toBe('0.1.0-beta.5');
  });
});

describe('resolveSdkVersion', () => {
  it('reads dist-tags[tag] from the npm registry document', async () => {
    const fetchImpl = fetchReturning(
      json({ 'dist-tags': { beta: '0.1.0-beta.9', latest: '0.0.1' } }),
    );
    await expect(resolveSdkVersion({ tag: 'beta', fetchImpl })).resolves.toBe('0.1.0-beta.9');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(REGISTRY_URL);
    expect(REGISTRY_URL).toBe('https://registry.npmjs.org/@bugsee%2Fbugsee');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses the requested tag, not a hard-coded one', async () => {
    const fetchImpl = fetchReturning(
      json({ 'dist-tags': { beta: '0.1.0-beta.9', latest: '1.2.3' } }),
    );
    await expect(resolveSdkVersion({ tag: 'latest', fetchImpl })).resolves.toBe('1.2.3');
  });

  it('an override skips the network entirely', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(resolveSdkVersion({ tag: 'beta', override: '2.0.0', fetchImpl })).resolves.toBe(
      '2.0.0',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('retries once after a network error', async () => {
    const fetchImpl = fetchReturning(
      new TypeError('fetch failed'),
      json({ 'dist-tags': { beta: '0.1.0-beta.7' } }),
    );
    await expect(resolveSdkVersion({ tag: 'beta', fetchImpl })).resolves.toBe('0.1.0-beta.7');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('falls back (with a debug log) when the registry is unreachable twice', async () => {
    const fetchImpl = fetchReturning(new TypeError('offline'), new TypeError('offline'));
    const { lines, log } = logSink();
    await expect(resolveSdkVersion({ tag: 'beta', fetchImpl, log })).resolves.toBe(
      SDK_FALLBACK_VERSION,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(lines.join('\n')).toContain(SDK_FALLBACK_VERSION);
  });

  it('never makes more than two attempts', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('offline'));
    await resolveSdkVersion({ tag: 'beta', fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    // the body would be usable: only the status says it must not be trusted
    ['a non-2xx status', () => json({ 'dist-tags': { beta: '9.9.9' } }, { status: 503 })],
    ['a missing tag', () => json({ 'dist-tags': { latest: '1.0.0' } })],
    ['a non-semver tag value', () => json({ 'dist-tags': { beta: 'not a version' } })],
    ['no dist-tags object', () => json({ name: '@bugsee/bugsee' })],
    ['invalid JSON', () => new Response('{nope', { status: 200 })],
  ])('falls back on %s', async (_name, make) => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => make());
    await expect(resolveSdkVersion({ tag: 'beta', fetchImpl })).resolves.toBe(SDK_FALLBACK_VERSION);
  });

  it('falls back when the body is larger than the cap (declared length)', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response('{"dist-tags":{"beta":"9.9.9"}}', {
          status: 200,
          headers: { 'content-length': String(64 * 1024 * 1024) },
        }),
    );
    await expect(resolveSdkVersion({ tag: 'beta', fetchImpl })).resolves.toBe(SDK_FALLBACK_VERSION);
  });

  it('falls back when the streamed body exceeds the cap', async () => {
    const big = `{"dist-tags":{"beta":"9.9.9"},"pad":"${'x'.repeat(9 * 1024 * 1024)}"}`;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(big));
    await expect(resolveSdkVersion({ tag: 'beta', fetchImpl })).resolves.toBe(SDK_FALLBACK_VERSION);
  });
});

describe('--sdk-version / BUGSEE_WIZARD_SDK_VERSION', () => {
  const base = { cwd: '/p', debug: false, dryRun: false };
  it('absent by default', () => {
    expect('sdkVersion' in buildOptions(base, {})).toBe(false);
  });
  it('env is used when the flag is absent', () => {
    expect(buildOptions(base, { BUGSEE_WIZARD_SDK_VERSION: '0.2.0' }).sdkVersion).toBe('0.2.0');
  });
  it('the flag wins over the env var', () => {
    const o = buildOptions(
      { ...base, sdkVersion: '0.3.0' },
      { BUGSEE_WIZARD_SDK_VERSION: '0.2.0' },
    );
    expect(o.sdkVersion).toBe('0.3.0');
  });
  it('passes the normalized version on (a leading v and surrounding whitespace dropped)', () => {
    expect(buildOptions({ ...base, sdkVersion: 'v1.2.3' }, {}).sdkVersion).toBe('1.2.3');
    expect(buildOptions(base, { BUGSEE_WIZARD_SDK_VERSION: ' 1.2.3-beta.1 ' }).sdkVersion).toBe(
      '1.2.3-beta.1',
    );
  });
  it('rejects a value that is not a semantic version (flag or env)', () => {
    expect(() => buildOptions({ ...base, sdkVersion: 'beta' }, {})).toThrow(/sdk version/i);
    expect(() => buildOptions(base, { BUGSEE_WIZARD_SDK_VERSION: '^1.0.0' })).toThrow(
      /sdk version/i,
    );
  });
});
