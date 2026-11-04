import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecipeError } from '../../src/engine/recipe.js';
import {
  compareRevisions,
  defaultSnapshotDir,
  type IndexEntry,
  RecipeStoreError,
  resolveRecipe,
  snapshotDirFor,
} from '../../src/engine/recipe-store.js';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

function recipeBody(range: string, marker: string): string {
  return JSON.stringify({
    schema: 1,
    id: marker,
    kind: 'runtime',
    platform: 'js',
    engine: { min: '1.0.0' },
    sdk: { range },
    detect: [{ dependency: 'x' }],
    ops: [{ op: 'ensure-gitignore', line: '.env' }],
  });
}

interface Served {
  files: Map<string, { status?: number; body?: string; headers?: Record<string, string> }>;
  hits: string[];
  headers: IncomingMessage['headers'][];
}

let server: Server;
let base: string;
let served: Served;
let tmp: string;

function entry(over: Partial<IndexEntry> & { body: string }): IndexEntry {
  const { body, ...rest } = over;
  return {
    range: '>=1.0.0',
    revision: 'r1',
    url: 'x.json',
    sha256: sha(body),
    engineMin: '1.0.0',
    ...rest,
  };
}

function serve(entries: IndexEntry[], bodies: Record<string, string>): void {
  served.files.set('/js/index.json', {
    body: JSON.stringify({ schema: 1, platform: 'js', entries }),
  });
  for (const [k, v] of Object.entries(bodies)) served.files.set(`/js/${k}`, { body: v });
}

beforeEach(async () => {
  served = { files: new Map(), hits: [], headers: [] };
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    served.hits.push(req.url ?? '');
    served.headers.push(req.headers);
    const f = served.files.get(req.url ?? '');
    if (!f) {
      res.statusCode = 404;
      res.end('nope');
      return;
    }
    res.statusCode = f.status ?? 200;
    for (const [k, v] of Object.entries(f.headers ?? {})) res.setHeader(k, v);
    res.end(f.body ?? '');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  tmp = await mkdtemp(join(tmpdir(), 'recipe-store-'));
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(tmp, { recursive: true, force: true });
});

const q = (over: Record<string, unknown> = {}) => ({
  platform: 'js',
  sdkVersion: '1.2.0',
  engine: '2.0.0',
  baseUrl: base,
  snapshotDir: join(tmp, 'snap'),
  ...over,
});

async function writeSnapshot(entries: IndexEntry[], bodies: Record<string, string>): Promise<void> {
  const dir = join(tmp, 'snap', 'js');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.json'), JSON.stringify({ schema: 1, platform: 'js', entries }));
  for (const [k, v] of Object.entries(bodies)) await writeFile(join(dir, k), v);
}

describe('compareRevisions', () => {
  it('orders r<N> numerically', () => {
    expect(compareRevisions('r10', 'r9')).toBeGreaterThan(0);
    expect(compareRevisions('r2', 'r10')).toBeLessThan(0);
    expect(compareRevisions('r3', 'r3')).toBe(0);
  });
  it('orders semver revisions and puts r<N> below them', () => {
    expect(compareRevisions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareRevisions('1.0.0', 'r99')).toBeGreaterThan(0);
    expect(compareRevisions('r99', '1.0.0')).toBeLessThan(0);
  });
});

describe('resolveRecipe: remote', () => {
  it('picks the newest revision covering the SDK with a supported engine', async () => {
    const b1 = recipeBody('>=1.0.0', 'one');
    const b2 = recipeBody('>=1.0.0', 'two');
    const b10 = recipeBody('>=1.0.0', 'ten');
    const b11 = recipeBody('>=1.0.0', 'needs-newer-engine');
    const b3 = recipeBody('>=3.0.0', 'other-range');
    serve(
      [
        entry({ body: b1, revision: 'r1', url: 'a.json' }),
        entry({ body: b10, revision: 'r10', url: 'c.json' }),
        entry({ body: b2, revision: 'r2', url: 'b.json' }),
        entry({ body: b11, revision: 'r11', url: 'd.json', engineMin: '9.0.0' }),
        entry({ body: b3, revision: 'r12', url: 'e.json', range: '>=3.0.0' }),
      ],
      { 'a.json': b1, 'b.json': b2, 'c.json': b10, 'd.json': b11, 'e.json': b3 },
    );
    const r = await resolveRecipe(q());
    expect(r.revision).toBe('r10');
    expect(r.recipe.id).toBe('ten');
    expect(r.source).toBe('remote');
    expect(r.warning).toBeUndefined();
  });

  it('matches prerelease SDK versions', async () => {
    const b = recipeBody('>=1.0.0-0', 'pre');
    serve([entry({ body: b, range: '>=1.0.0-0 <2.0.0' })], { 'x.json': b });
    const r = await resolveRecipe(q({ sdkVersion: '1.2.0-beta.3' }));
    expect(r.recipe.id).toBe('pre');
    expect(r.warning).toBeUndefined();
  });

  it('accepts engineMin equal to the engine', async () => {
    const b = recipeBody('>=1.0.0', 'eq');
    serve([entry({ body: b, engineMin: '2.0.0' })], { 'x.json': b });
    expect((await resolveRecipe(q())).recipe.id).toBe('eq');
  });

  it('errors with an upgrade hint when every covering entry needs a newer engine', async () => {
    const b = recipeBody('>=1.0.0', 'new');
    serve([entry({ body: b, engineMin: '9.0.0' })], { 'x.json': b });
    await expect(resolveRecipe(q())).rejects.toThrow(/npx @bugsee\/wizard@latest/);
    await expect(resolveRecipe(q())).rejects.toBeInstanceOf(RecipeStoreError);
  });

  it('resolves an absolute localhost url and relative subpaths', async () => {
    const b = recipeBody('>=1.0.0', 'abs');
    serve([entry({ body: b, url: `${base}/js/1.2.0/r1.json` })], { '1.2.0/r1.json': b });
    expect((await resolveRecipe(q())).recipe.id).toBe('abs');
  });

  it('refuses a non-https remote url when the base is not local', async () => {
    const b = recipeBody('>=1.0.0', 'x');
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('index.json'))
        return new Response(
          JSON.stringify({
            schema: 1,
            platform: 'js',
            entries: [entry({ body: b, url: 'http://evil.example/x.json' })],
          }),
        );
      throw new Error('must not fetch');
    }) as typeof fetch;
    await expect(
      resolveRecipe(q({ baseUrl: 'https://store.example/recipes', fetchImpl })),
    ).rejects.toThrow(/non-https/);
  });

  it('refuses a local http recipe url pointing off-host when base is local', async () => {
    const b = recipeBody('>=1.0.0', 'x');
    serve([entry({ body: b, url: 'http://evil.example/x.json' })], {});
    await expect(resolveRecipe(q())).rejects.toThrow(/non-https/);
  });

  it('rejects a non-https, non-local base URL', async () => {
    await expect(resolveRecipe(q({ baseUrl: 'http://store.example' }))).rejects.toThrow(
      /must be https/,
    );
  });

  it('rejects bad platform ids and SDK versions', async () => {
    await expect(resolveRecipe(q({ platform: '../etc' }))).rejects.toThrow(/Invalid platform/);
    await expect(resolveRecipe(q({ sdkVersion: 'latest' }))).rejects.toThrow(/Invalid SDK version/);
  });

  it('sends only a user-agent and accept header, no identifying data', async () => {
    const b = recipeBody('>=1.0.0', 'ua');
    serve([entry({ body: b })], { 'x.json': b });
    await resolveRecipe(q());
    const h = served.headers[0] as Record<string, string>;
    expect(h['user-agent']).toMatch(/^bugsee-wizard\/\d/);
    expect(Object.keys(h).sort()).toEqual(
      [
        'accept',
        'accept-encoding',
        'accept-language',
        'connection',
        'host',
        'sec-fetch-mode',
        'user-agent',
      ].filter((k) => k in h),
    );
    expect(JSON.stringify(h)).not.toContain(process.cwd());
  });

  it('wraps an invalid recipe in RecipeStoreError with the RecipeError cause', async () => {
    const b = JSON.stringify({ schema: 1 });
    serve([entry({ body: b })], { 'x.json': b });
    const err = await resolveRecipe(q()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecipeStoreError);
    expect((err as RecipeStoreError).cause).toBeInstanceOf(RecipeError);
  });

  it('errors on a malformed index entry', async () => {
    served.files.set('/js/index.json', {
      body: JSON.stringify({
        schema: 1,
        platform: 'js',
        entries: [{ range: '>=1', revision: 'r1' }],
      }),
    });
    await expect(resolveRecipe(q())).rejects.toThrow(/entries\[0\]\.url/);
  });

  it.each([
    ['schema', { schema: 2, platform: 'js', entries: [] }, /unsupported schema/],
    ['platform', { schema: 1, platform: 'other', entries: [] }, /platform mismatch/],
    ['entries', { schema: 1, platform: 'js', entries: 'x' }, /entries must be an array/],
    ['shape', 5, /not an object/],
  ])('rejects an index with a bad %s', async (_n, body, re) => {
    served.files.set('/js/index.json', { body: JSON.stringify(body) });
    await expect(resolveRecipe(q())).rejects.toThrow(re);
  });

  it.each([
    ['range', { range: 'not a range!!' }, /range is not/],
    ['engineMin', { engineMin: 'abc' }, /engineMin is not/],
    ['revision', { revision: 'latest' }, /revision is not/],
    ['sha256', { sha256: 'abc' }, /sha256 is not/],
  ])('rejects an entry with a bad %s', async (_n, over, re) => {
    const b = recipeBody('>=1.0.0', 'x');
    serve([{ ...entry({ body: b }), ...over }], { 'x.json': b });
    await expect(resolveRecipe(q())).rejects.toThrow(re);
  });
});

describe('resolveRecipe: nearest older', () => {
  it('uses the nearest older covering entry with a warning', async () => {
    const b1 = recipeBody('>=1.0.0 <1.5.0', 'v1');
    const b2 = recipeBody('>=1.5.0 <2.0.0', 'v15');
    const b3 = recipeBody('>=3.0.0', 'v3');
    serve(
      [
        entry({ body: b1, range: '>=1.0.0 <1.5.0', revision: 'r1', url: 'a.json' }),
        entry({ body: b2, range: '>=1.5.0 <2.0.0', revision: 'r1', url: 'b.json' }),
        entry({ body: b3, range: '>=3.0.0', revision: 'r1', url: 'c.json' }),
      ],
      { 'a.json': b1, 'b.json': b2, 'c.json': b3 },
    );
    const r = await resolveRecipe(q({ sdkVersion: '2.4.0' }));
    expect(r.recipe.id).toBe('v15');
    expect(r.source).toBe('remote');
    expect(r.warning).toMatch(/nearest older/);
  });

  it('prefers the newest revision among same-minimum entries', async () => {
    const ba = recipeBody('>=1.0.0 <2.0.0', 'old');
    const bb = recipeBody('>=1.0.0 <2.0.0', 'new');
    serve(
      [
        entry({ body: ba, range: '>=1.0.0 <2.0.0', revision: 'r1', url: 'a.json' }),
        entry({ body: bb, range: '>=1.0.0 <2.0.0', revision: 'r2', url: 'b.json' }),
      ],
      { 'a.json': ba, 'b.json': bb },
    );
    expect((await resolveRecipe(q({ sdkVersion: '2.4.0' }))).recipe.id).toBe('new');
  });

  it('errors when nothing is older than the SDK version', async () => {
    const b = recipeBody('>=5.0.0', 'x');
    serve([entry({ body: b, range: '>=5.0.0' })], { 'x.json': b });
    await expect(resolveRecipe(q())).rejects.toThrow(/No recipe for js covers/);
  });

  it('errors with an upgrade hint when older entries all need a newer engine', async () => {
    const b = recipeBody('>=1.0.0 <1.1.0', 'x');
    serve([entry({ body: b, range: '>=1.0.0 <1.1.0', engineMin: '9.0.0' })], { 'x.json': b });
    await expect(resolveRecipe(q())).rejects.toThrow(/npx @bugsee\/wizard@latest/);
  });
});

describe('resolveRecipe: integrity', () => {
  it('rejects a tampered body and throws mentioning integrity when no snapshot', async () => {
    const good = recipeBody('>=1.0.0', 'good');
    serve([entry({ body: good })], { 'x.json': recipeBody('>=1.0.0', 'evil') });
    const err = await resolveRecipe(q()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecipeStoreError);
    expect((err as Error).message).toMatch(/integrity/i);
  });

  it('falls back to a covering snapshot after an integrity failure, never using the bad body', async () => {
    const good = recipeBody('>=1.0.0', 'snap');
    serve([entry({ body: good })], { 'x.json': recipeBody('>=1.0.0', 'evil') });
    await writeSnapshot([entry({ body: good })], { 'x.json': good });
    const r = await resolveRecipe(q());
    expect(r.source).toBe('snapshot');
    expect(r.recipe.id).toBe('snap');
    expect(r.warning).toMatch(/verification failed/);
    expect(r.warning).not.toMatch(/unreachable/);
  });

  it('rejects a tampered snapshot file too', async () => {
    const good = recipeBody('>=1.0.0', 'snap');
    await writeSnapshot([entry({ body: good })], { 'x.json': recipeBody('>=1.0.0', 'evil') });
    await expect(resolveRecipe(q({ baseUrl: 'http://127.0.0.1:1' }))).rejects.toThrow(/sha256/);
  });
});

describe('resolveRecipe: offline and network behaviour', () => {
  it('uses the snapshot when the host is unreachable', async () => {
    const b = recipeBody('>=1.0.0', 'snap');
    await writeSnapshot([entry({ body: b, revision: 'r4' })], { 'x.json': b });
    const r = await resolveRecipe(q({ baseUrl: 'http://127.0.0.1:1' }));
    expect(r).toMatchObject({ source: 'snapshot', revision: 'r4' });
    expect(r.recipe.id).toBe('snap');
    expect(r.warning).toMatch(/offline/i);
  });

  it('keeps the nearest-older warning when served from the snapshot', async () => {
    const b = recipeBody('>=1.0.0 <2.0.0', 'snap');
    await writeSnapshot([entry({ body: b, range: '>=1.0.0 <2.0.0' })], { 'x.json': b });
    const r = await resolveRecipe(q({ baseUrl: 'http://127.0.0.1:1', sdkVersion: '2.5.0' }));
    expect(r.warning).toMatch(/offline[\s\S]*nearest older/i);
  });

  it('throws explaining offline + no snapshot when the platform has no snapshot', async () => {
    const err = await resolveRecipe(q({ baseUrl: 'http://127.0.0.1:1' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecipeStoreError);
    expect((err as Error).message).toMatch(/offline/i);
    expect((err as Error).message).toMatch(/no snapshot/i);
  });

  it('throws when the snapshot does not cover the version', async () => {
    const b = recipeBody('>=5.0.0', 'x');
    await writeSnapshot([entry({ body: b, range: '>=5.0.0' })], { 'x.json': b });
    await expect(resolveRecipe(q({ baseUrl: 'http://127.0.0.1:1' }))).rejects.toThrow(/offline/i);
  });

  it('rejects unsafe or missing snapshot files', async () => {
    const b = recipeBody('>=1.0.0', 'x');
    for (const url of ['../x.json', '..', 'a/b.json']) {
      await writeSnapshot([entry({ body: b, url })], {});
      await expect(resolveRecipe(q({ baseUrl: 'http://127.0.0.1:1' }))).rejects.toThrow(/unsafe/);
    }
    await writeSnapshot([entry({ body: b, url: 'missing.json' })], {});
    await expect(resolveRecipe(q({ baseUrl: 'http://127.0.0.1:1' }))).rejects.toThrow(/missing/);
  });

  it('wraps a corrupt snapshot index', async () => {
    const dir = join(tmp, 'snap', 'js');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'index.json'), '{not json');
    await expect(resolveRecipe(q({ baseUrl: 'http://127.0.0.1:1' }))).rejects.toThrow(/offline/i);
  });

  it('does not retry a 4xx (single request, then snapshot)', async () => {
    const b = recipeBody('>=1.0.0', 'snap');
    await writeSnapshot([entry({ body: b })], { 'x.json': b });
    // 404 for the index -> offline-ish fallback, but only one request
    const r = await resolveRecipe(q());
    expect(r.source).toBe('snapshot');
    expect(served.hits).toEqual(['/js/index.json']);
  });

  it('retries once on a 5xx and recovers', async () => {
    const b = recipeBody('>=1.0.0', 'ok');
    serve([entry({ body: b })], { 'x.json': b });
    const real = fetch;
    let n = 0;
    const fetchImpl = ((u: string, init?: RequestInit) =>
      n++ === 0
        ? Promise.resolve(new Response('x', { status: 503 }))
        : real(u, init)) as typeof fetch;
    const r = await resolveRecipe(q({ fetchImpl }));
    expect(r.source).toBe('remote');
    expect(n).toBe(3);
  });

  it('falls back after two 5xx responses (one retry only)', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      return new Response('x', { status: 500 });
    }) as typeof fetch;
    await expect(resolveRecipe(q({ fetchImpl }))).rejects.toThrow(/offline/i);
    expect(n).toBe(2);
  });

  it('retries once on a network error', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(resolveRecipe(q({ fetchImpl }))).rejects.toThrow(/offline/i);
    expect(n).toBe(2);
  });

  it('passes redirect:error and an abort signal', async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response('x', { status: 404 });
    }) as typeof fetch;
    await resolveRecipe(q({ fetchImpl })).catch(() => undefined);
    expect(seen[0]?.redirect).toBe('error');
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses redirects (falls back to offline handling)', async () => {
    served.files.set('/js/index.json', {
      status: 302,
      headers: { location: 'http://evil.example/' },
    });
    await expect(resolveRecipe(q())).rejects.toThrow(/offline/i);
  });

  it('rejects an oversized response by content-length and by streamed size', async () => {
    const big = 'a'.repeat(1024 * 1024 + 1);
    served.files.set('/js/index.json', { body: big });
    await expect(resolveRecipe(q())).rejects.toThrow(/offline/i);
    const fetchImpl = (async () =>
      new Response(big, { headers: { 'content-length': '5' } })) as typeof fetch;
    await expect(resolveRecipe(q({ fetchImpl }))).rejects.toThrow(/too large/);
    const declared = (async () =>
      new Response('x', {
        headers: { 'content-length': String(2 * 1024 * 1024) },
      })) as typeof fetch;
    await expect(resolveRecipe(q({ fetchImpl: declared }))).rejects.toThrow(/too large/);
    const lie = (async () => new Response(new Blob([big]).stream())) as typeof fetch;
    await expect(resolveRecipe(q({ fetchImpl: lie }))).rejects.toThrow(/too large/);
  });

  it('treats a non-JSON index as offline', async () => {
    served.files.set('/js/index.json', { body: '<html>' });
    await expect(resolveRecipe(q())).rejects.toThrow(/offline/i);
  });

  it('handles a response with no body', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: null,
    })) as unknown as typeof fetch;
    await expect(resolveRecipe(q({ fetchImpl }))).rejects.toThrow(/offline/i);
  });
});

describe('snapshotDirFor', () => {
  it('uses ../../snapshot/ for the source layout', () => {
    expect(snapshotDirFor('file:///repo/src/engine/recipe-store.ts')).toBe('/repo/snapshot/');
  });
  it('uses ../snapshot/ for the dist layout', () => {
    expect(snapshotDirFor('file:///repo/dist/cli.js')).toBe('/repo/snapshot/');
  });
  it('is not fooled by an install path containing a src directory', () => {
    expect(snapshotDirFor('file:///home/me/src/app/node_modules/@bugsee/wizard/dist/cli.js')).toBe(
      '/home/me/src/app/node_modules/@bugsee/wizard/snapshot/',
    );
    expect(snapshotDirFor('file:///usr/src/wizard/dist/index.js')).toBe(
      '/usr/src/wizard/snapshot/',
    );
  });
  it('requires both engine and its src parent for the source layout', () => {
    expect(snapshotDirFor('file:///a/engine/cli.js')).toBe('/a/snapshot/');
    expect(snapshotDirFor('file:///a/src/other/cli.js')).toBe('/a/src/snapshot/');
    expect(snapshotDirFor('file:///a/lib/engine/cli.js')).toBe('/a/lib/snapshot/');
  });
  it('treats src/engine only as the source layout, not src/other', () => {
    expect(snapshotDirFor('file:///a/src/x/dist/cli.js')).toBe('/a/src/x/snapshot/');
  });
});

describe('resolveRecipe: review fixes', () => {
  it.each([
    ['a different host', 'https://evil.example/x.json'],
    ['a protocol-relative host', '//evil.example/x.json'],
    ['userinfo', 'USERINFO'],
  ])('rejects an index url with %s', async (_n, url) => {
    const b = recipeBody('>=1.0.0', 'x');
    const u = url === 'USERINFO' ? `http://user:pw@${base.slice('http://'.length)}/js/x.json` : url;
    serve([entry({ body: b, url: u })], { 'x.json': b });
    await expect(resolveRecipe(q())).rejects.toThrow(/origin|credentials|non-https/);
  });

  it('rejects a cross-origin https url on an https base', async () => {
    const b = recipeBody('>=1.0.0', 'x');
    const fetchImpl = (async (url: string | URL | Request) => {
      if (String(url).endsWith('index.json'))
        return new Response(
          JSON.stringify({
            schema: 1,
            platform: 'js',
            entries: [entry({ body: b, url: 'https://evil.example/x.json' })],
          }),
        );
      throw new Error('must not fetch');
    }) as typeof fetch;
    await expect(
      resolveRecipe(q({ baseUrl: 'https://store.example/recipes', fetchImpl })),
    ).rejects.toThrow(/different origin/);
  });

  it('rejects userinfo on a same-host url', async () => {
    const b = recipeBody('>=1.0.0', 'x');
    const host = base.slice('http://'.length);
    serve([entry({ body: b, url: `http://u:p@${host}/js/x.json` })], { 'x.json': b });
    await expect(resolveRecipe(q())).rejects.toThrow(/credentials/);
  });

  it('rejects a password-only userinfo url', async () => {
    const b = recipeBody('>=1.0.0', 'x');
    const host = base.slice('http://'.length);
    serve([entry({ body: b, url: `http://:p@${host}/js/x.json` })], { 'x.json': b });
    await expect(resolveRecipe(q())).rejects.toThrow(/credentials/);
  });

  it('says the remote index was not found on a 404, distinct from a network failure', async () => {
    const b = recipeBody('>=1.0.0', 'snap');
    await writeSnapshot([entry({ body: b })], { 'x.json': b });
    const r = await resolveRecipe(q());
    expect(r.source).toBe('snapshot');
    expect(r.warning).toMatch(/not found/i);
    expect(r.warning).not.toMatch(/unreachable/i);
    const net = await resolveRecipe(q({ baseUrl: 'http://127.0.0.1:1' }));
    expect(net.warning).toMatch(/unreachable/i);
    expect(net.warning).not.toMatch(/not found/i);
  });

  it('throws a RecipeStoreError for an invalid engine version', async () => {
    const err = await resolveRecipe(q({ engine: 'banana' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecipeStoreError);
    expect((err as Error).message).toMatch(/Invalid wizard engine version/);
    expect(served.hits).toEqual([]);
  });
});

describe('defaultSnapshotDir', () => {
  it('points at the repo snapshot directory from source', () => {
    expect(defaultSnapshotDir()).toBe(`${join(process.cwd(), 'snapshot')}/`);
  });
});
