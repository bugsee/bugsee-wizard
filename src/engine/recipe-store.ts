import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import { parseRecipe, type Recipe } from './recipe.js';

/**
 * Recipe store client (spec §6.1).
 *
 * Remote layout (immutable recipe bodies + one mutable index per platform):
 *   <baseUrl>/<platform>/index.json
 *   <baseUrl>/<platform>/<sdk-version>/<revision>.json
 *
 * Index format (`schema: 1`):
 *   { "schema": 1, "platform": "<id>",
 *     "entries": [{ "range": "<semver range>", "revision": "r<N>",
 *                   "url": "<relative to the index URL, or absolute https>",
 *                   "sha256": "<hex of the exact recipe body bytes>",
 *                   "engineMin": "<semver of the oldest wizard that can run it>" }] }
 *
 * Revision order: `r<N>` compares numerically (`r10 > r9`); semver-like
 * revisions compare with semver; when the two styles are mixed the `r<N>` form
 * is considered older. Integrity (v1) = HTTPS + the index sha256. Recipes are
 * data only. Nothing identifying (cwd, tokens, machine info) is ever sent.
 */

export const DEFAULT_BASE_URL = 'https://download.bugsee.com/sdk/wizard-recipes';
const TIMEOUT_MS = 5000;
const MAX_BYTES = 1024 * 1024;
const WIZARD_VERSION = '0.0.0';
const UPGRADE_HINT =
  'Run `npx @bugsee/wizard@latest` to get a wizard that supports this SDK version.';
const PLATFORM_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REVISION_RE = /^r(\d+)$/;

export interface IndexEntry {
  range: string;
  revision: string;
  url: string;
  sha256: string;
  engineMin: string;
}

export interface RecipeQuery {
  platform: string;
  sdkVersion: string;
  engine: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Directory holding `<platform>/index.json` fallbacks. Defaults to the packaged `snapshot/`. */
  snapshotDir?: string;
}

export interface ResolvedRecipe {
  recipe: Recipe;
  revision: string;
  source: 'remote' | 'snapshot';
  warning?: string;
}

export class RecipeStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RecipeStoreError';
  }
}

/** Failure that is a reason to try the offline snapshot (vs. an authoritative answer). */
class Fallback extends Error {
  constructor(
    message: string,
    readonly kind: 'offline' | 'integrity' | 'notfound',
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * Snapshot directory for a module URL, decided by the module's OWN location:
 * `<root>/src/engine/<file>.ts` (source/tests) -> `<root>/snapshot/`;
 * anything else (`<root>/dist/<file>.js`) -> `<root>/snapshot/` one level up.
 * Never inspects the rest of the install path (it may contain a `src` dir).
 */
export function snapshotDirFor(moduleUrl: string): string {
  const parts = new URL(moduleUrl).pathname.split('/');
  const dir = parts[parts.length - 2];
  const parent = parts[parts.length - 3];
  const isSource = dir === 'engine' && parent === 'src';
  return fileURLToPath(new URL(isSource ? '../../snapshot/' : '../snapshot/', moduleUrl));
}

export function defaultSnapshotDir(): string {
  return snapshotDirFor(import.meta.url);
}

export function compareRevisions(a: string, b: string): number {
  const ra = REVISION_RE.exec(a);
  const rb = REVISION_RE.exec(b);
  if (ra && rb) return Number(ra[1]) - Number(rb[1]);
  if (ra) return -1;
  if (rb) return 1;
  return semver.compare(a, b);
}

function isLocal(url: URL): boolean {
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
}

function parseIndex(json: unknown, platform: string): IndexEntry[] {
  const bad = (why: string): never => {
    throw new RecipeStoreError(`Invalid recipe index for "${platform}": ${why}`);
  };
  if (typeof json !== 'object' || json === null) return bad('not an object');
  const o = json as Record<string, unknown>;
  if (o.schema !== 1) bad('unsupported schema');
  if (o.platform !== platform) bad('platform mismatch');
  if (!Array.isArray(o.entries)) return bad('entries must be an array');
  return o.entries.map((raw: unknown, i: number): IndexEntry => {
    const e = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const s = (k: string): string => {
      const v = e[k];
      if (typeof v !== 'string' || v === '') return bad(`entries[${i}].${k} must be a string`);
      return v as string;
    };
    const entry = {
      range: s('range'),
      revision: s('revision'),
      url: s('url'),
      sha256: s('sha256').toLowerCase(),
      engineMin: s('engineMin'),
    };
    if (semver.validRange(entry.range) === null) bad(`entries[${i}].range is not a semver range`);
    if (semver.valid(entry.engineMin) === null) bad(`entries[${i}].engineMin is not a version`);
    if (!REVISION_RE.test(entry.revision) && semver.valid(entry.revision) === null)
      bad(`entries[${i}].revision is not r<N> or semver`);
    if (!/^[0-9a-f]{64}$/.test(entry.sha256)) bad(`entries[${i}].sha256 is not a sha256 hex`);
    return entry;
  });
}

function newest(entries: IndexEntry[]): IndexEntry {
  return entries.reduce((a, b) => (compareRevisions(b.revision, a.revision) > 0 ? b : a));
}

interface Selection {
  entry: IndexEntry;
  warning?: string;
}

function select(entries: IndexEntry[], q: RecipeQuery): Selection {
  const sdk = q.sdkVersion;
  const engineOk = (e: IndexEntry): boolean => semver.lte(e.engineMin, q.engine);
  const tooOld = (): never => {
    throw new RecipeStoreError(
      `Every recipe for ${q.platform} ${sdk} needs a newer wizard than ${q.engine}. ${UPGRADE_HINT}`,
    );
  };

  const covering = entries.filter((e) =>
    semver.satisfies(sdk, e.range, { includePrerelease: true }),
  );
  if (covering.length > 0) {
    const ok = covering.filter(engineOk);
    return ok.length > 0 ? { entry: newest(ok) } : tooOld();
  }

  const older = entries.filter((e) => {
    const min = semver.minVersion(e.range);
    return min !== null && semver.lt(min, sdk);
  });
  if (older.length === 0) {
    throw new RecipeStoreError(`No recipe for ${q.platform} covers SDK version ${sdk}.`);
  }
  const ok = older.filter(engineOk);
  if (ok.length === 0) return tooOld();
  const minOf = (e: IndexEntry): semver.SemVer => semver.minVersion(e.range) as semver.SemVer;
  const top = ok.reduce((a, b) => (semver.gt(minOf(b), minOf(a)) ? b : a));
  const best = newest(ok.filter((e) => semver.eq(minOf(e), minOf(top))));
  return {
    entry: best,
    warning: `No ${q.platform} recipe covers SDK ${sdk}; using ${best.revision} (SDK ${best.range}), the nearest older one.`,
  };
}

async function readCapped(res: Response): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) throw new Fallback('response too large', 'offline');
  const chunks: Buffer[] = [];
  let total = 0;
  if (res.body === null) return Buffer.alloc(0);
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > MAX_BYTES) throw new Fallback('response too large', 'offline');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function httpGet(url: string, fetchImpl: typeof fetch): Promise<Buffer> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchImpl(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'user-agent': `bugsee-wizard/${WIZARD_VERSION}`, accept: 'application/json' },
      });
      if (res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (res.status === 404) throw new Fallback(`${url} was not found (HTTP 404)`, 'notfound');
      if (!res.ok) throw new Fallback(`HTTP ${res.status} from ${url}`, 'offline');
      return await readCapped(res);
    } catch (err) {
      if (err instanceof Fallback) throw err;
      lastErr = err;
    }
  }
  throw new Fallback(`Could not reach ${url}`, 'offline', { cause: lastErr });
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function verifyAndParse(body: Buffer, entry: IndexEntry): Recipe {
  if (sha256(body) !== entry.sha256) {
    throw new Fallback(
      `Integrity check failed for recipe ${entry.revision}: sha256 does not match the index`,
      'integrity',
    );
  }
  try {
    return parseRecipe(JSON.parse(body.toString('utf8')));
  } catch (cause) {
    throw new RecipeStoreError(`Recipe ${entry.revision} is invalid`, { cause });
  }
}

async function fromRemote(
  q: RecipeQuery,
  base: URL,
  fetchImpl: typeof fetch,
): Promise<ResolvedRecipe> {
  const indexUrl = new URL(`${q.platform}/index.json`, `${base.href.replace(/\/+$/, '')}/`);
  const indexBody = await httpGet(indexUrl.href, fetchImpl);
  let indexJson: unknown;
  try {
    indexJson = JSON.parse(indexBody.toString('utf8'));
  } catch (cause) {
    throw new Fallback('Recipe index is not valid JSON', 'offline', { cause });
  }
  const { entry, warning } = select(parseIndex(indexJson, q.platform), q);
  const url = new URL(entry.url, indexUrl);
  const allowed =
    url.protocol === 'https:' || (url.protocol === 'http:' && isLocal(base) && isLocal(url));
  if (!allowed) throw new RecipeStoreError(`Refusing non-https recipe URL: ${url.href}`);
  if (url.username !== '' || url.password !== '') {
    throw new RecipeStoreError('Refusing a recipe URL that embeds credentials');
  }
  if (url.origin !== base.origin) {
    throw new RecipeStoreError(`Refusing a recipe URL on a different origin: ${url.origin}`);
  }
  const recipe = verifyAndParse(await httpGet(url.href, fetchImpl), entry);
  return { recipe, revision: entry.revision, source: 'remote', ...(warning ? { warning } : {}) };
}

async function fromSnapshot(q: RecipeQuery, why: string): Promise<ResolvedRecipe> {
  const dir = join(q.snapshotDir ?? defaultSnapshotDir(), q.platform);
  const fail = (detail: string, cause?: unknown): never => {
    throw new RecipeStoreError(
      `${why}, and the bundled snapshot cannot help: ${detail}`,
      cause === undefined ? undefined : { cause },
    );
  };
  let indexText: string;
  try {
    indexText = await readFile(join(dir, 'index.json'), 'utf8');
  } catch (cause) {
    return fail(`no snapshot for platform "${q.platform}"`, cause);
  }
  let selection: Selection;
  try {
    selection = select(parseIndex(JSON.parse(indexText), q.platform), q);
  } catch (cause) {
    return fail(cause instanceof Error ? cause.message : String(cause), cause);
  }
  const { entry, warning } = selection;
  // Snapshot entries must be bare filenames inside snapshot/<platform>/.
  if (entry.url.includes('/') || entry.url.includes('\\') || entry.url.includes('..')) {
    return fail(`snapshot entry ${entry.revision} has an unsafe file name`);
  }
  let body: Buffer;
  try {
    body = await readFile(join(dir, entry.url));
  } catch (cause) {
    return fail(`snapshot file ${entry.url} is missing`, cause);
  }
  let recipe: Recipe;
  try {
    recipe = verifyAndParse(body, entry);
  } catch (cause) {
    return fail(cause instanceof Error ? cause.message : String(cause), cause);
  }
  const note = `Using the bundled offline recipe ${entry.revision} (${why}).`;
  return {
    recipe,
    revision: entry.revision,
    source: 'snapshot',
    warning: warning ? `${note} ${warning}` : note,
  };
}

export async function resolveRecipe(q: RecipeQuery): Promise<ResolvedRecipe> {
  if (!PLATFORM_RE.test(q.platform))
    throw new RecipeStoreError(`Invalid platform id "${q.platform}"`);
  if (semver.valid(q.sdkVersion) === null)
    throw new RecipeStoreError(`Invalid SDK version "${q.sdkVersion}"`);
  if (semver.valid(q.engine) === null)
    throw new RecipeStoreError(`Invalid wizard engine version "${q.engine}"`);
  const base = new URL(q.baseUrl ?? DEFAULT_BASE_URL);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && isLocal(base))) {
    throw new RecipeStoreError(`Recipe store must be https: ${base.href}`);
  }
  try {
    return await fromRemote(q, base, q.fetchImpl ?? fetch);
  } catch (err) {
    if (!(err instanceof Fallback)) throw err;
    const why =
      err.kind === 'integrity'
        ? `Recipe integrity verification failed (${err.message})`
        : err.kind === 'notfound'
          ? `The remote recipe index was not found (${err.message})`
          : `The recipe store is unreachable/offline (${err.message})`;
    return fromSnapshot(q, why);
  }
}
