import * as clack from '@clack/prompts';

import { MissingInputError } from './noninteractive.js';

export const MAX_TOKEN_LENGTH = 512;

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

/**
 * Where the app token comes from. `kind` is a closed union today; a browser
 * sign-in source can be added later as another kind plugged into
 * `selectTokenSource` without changing callers.
 */
export interface TokenSource {
  readonly kind: 'paste' | 'env' | 'flag';
  get(): Promise<string>;
}

/** Messages here deliberately never include the value. */
export function normalizeToken(raw: string): string {
  let t = raw.trim();
  const first = t[0];
  if (t.length >= 2 && (first === '"' || first === "'") && t.endsWith(first)) {
    t = t.slice(1, -1).trim();
  }
  if (t === '') throw new Error('token is empty');
  if (/\s/.test(t)) throw new Error('token must not contain whitespace');
  if (t.length > MAX_TOKEN_LENGTH)
    throw new Error(`token is longer than ${MAX_TOKEN_LENGTH} characters`);
  return t;
}

function fixed(kind: 'env' | 'flag', raw: string): TokenSource {
  return { kind, get: async () => normalizeToken(raw) };
}

export function selectTokenSource(opts: {
  flag?: string;
  env: NodeJS.ProcessEnv;
  nonInteractive: boolean;
}): TokenSource {
  if (opts.flag !== undefined && opts.flag !== '') return fixed('flag', opts.flag);
  const envToken = opts.env.BUGSEE_APP_TOKEN;
  if (envToken !== undefined && envToken !== '') return fixed('env', envToken);
  return {
    kind: 'paste',
    get: async () => {
      if (opts.nonInteractive) throw new MissingInputError('token');
      const value = await clack.password({
        message: 'Paste your Bugsee app token',
        validate: (v) => {
          try {
            normalizeToken(v ?? '');
            return undefined;
          } catch (e) {
            return e instanceof Error ? e.message : 'invalid token';
          }
        },
      });
      if (clack.isCancel(value)) throw new CancelledError();
      return normalizeToken(value);
    },
  };
}
