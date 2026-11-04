import semver from 'semver';

import type { Logger } from '../core/logger.js';
import { WIZARD_VERSION } from '../engine/telemetry.js';
import { SDK_FALLBACK_VERSION } from './versions.js';

/** The umbrella package's registry document; only `dist-tags` is read from it. */
export const REGISTRY_URL = 'https://registry.npmjs.org/@bugsee%2Fbugsee';
const TIMEOUT_MS = 5000;
const ATTEMPTS = 2;
const MAX_BYTES = 8 * 1024 * 1024;

export interface SdkVersionQuery {
  /** `--sdk-version` / `BUGSEE_WIZARD_SDK_VERSION` (already validated): skips the network. */
  override?: string;
  fetchImpl?: typeof fetch;
  tag: string;
  log?: Logger;
}

async function readCapped(res: Response): Promise<string> {
  if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) {
    throw new Error('registry response too large');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  if (res.body !== null) {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > MAX_BYTES) throw new Error('registry response too large');
      chunks.push(Buffer.from(chunk));
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

function tagFrom(doc: unknown, tag: string): string {
  const tags =
    typeof doc === 'object' && doc !== null ? (doc as Record<string, unknown>)['dist-tags'] : null;
  const v =
    typeof tags === 'object' && tags !== null ? (tags as Record<string, unknown>)[tag] : undefined;
  if (typeof v !== 'string' || semver.valid(v) === null) {
    throw new Error(`the registry has no valid "${tag}" dist-tag`);
  }
  return v;
}

async function fetchTag(fetchImpl: typeof fetch, tag: string): Promise<string> {
  const res = await fetchImpl(REGISTRY_URL, {
    // the registry answers directly; never follow a redirect anywhere else
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      'user-agent': `bugsee-wizard/${WIZARD_VERSION}`,
      // the abbreviated document keeps the body small
      accept: 'application/vnd.npm.install-v1+json, application/json',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return tagFrom(JSON.parse(await readCapped(res)), tag);
}

/**
 * The SDK version recipes are resolved for: the override when given, else the registry's
 * `dist-tags[tag]`, else SDK_FALLBACK_VERSION (offline, blocked, or a bad answer). Never throws.
 */
export async function resolveSdkVersion(q: SdkVersionQuery): Promise<string> {
  if (q.override !== undefined) return q.override;
  const fetchImpl = q.fetchImpl ?? fetch;
  let last = '';
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      return await fetchTag(fetchImpl, q.tag);
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
  }
  q.log?.debug(
    `Could not read the "${q.tag}" SDK version from npm (${last}); using ${SDK_FALLBACK_VERSION}.`,
  );
  return SDK_FALLBACK_VERSION;
}
