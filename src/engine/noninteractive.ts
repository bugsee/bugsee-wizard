import semver from 'semver';

import { createLogger, type Logger } from '../core/logger.js';

/** Missing required input in non-interactive mode (exit code 2). Never carries a value, only the field name. */
export class MissingInputError extends Error {
  readonly field: string;
  constructor(field: string) {
    super(`missing required input: ${field}`);
    this.name = 'MissingInputError';
    this.field = field;
  }
}

/** Ctrl-C / cancel at a prompt: a clean exit, not an error. */
export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

export const CANCELLED_MESSAGE = 'Cancelled.';

/** The single JSON object printed on stdout in `--json` mode. */
export interface WizardRunResult {
  ok: boolean;
  incomplete: boolean;
  steps: { id: string; outcome: string }[];
  /** A machine-readable code (`missing-input`, `dirty-git-tree`, ...). */
  error?: string;
  field?: string;
  /** Human-readable detail for `error`. Never carries the token. */
  message?: string;
  /** Changes the wizard could not make itself (incomplete runs). */
  snippets?: { file: string; title: string; code: string }[];
}

export interface EnvFlags {
  readonly nonInteractive: boolean;
  readonly json: boolean;
  readonly telemetry: boolean;
  readonly ignoreGitChanges: boolean;
  readonly yes: boolean;
  readonly package: string | undefined;
}

const TRUTHY = new Set(['1', 'true', 'yes']);

export function isTruthy(v: string | undefined): boolean {
  return v !== undefined && TRUTHY.has(v.trim().toLowerCase());
}

export function readEnvFlags(env: NodeJS.ProcessEnv): EnvFlags {
  const pkg = env.BUGSEE_WIZARD_PACKAGE;
  return {
    nonInteractive: isTruthy(env.BUGSEE_WIZARD_NON_INTERACTIVE),
    json: isTruthy(env.BUGSEE_WIZARD_JSON),
    telemetry: isTruthy(env.BUGSEE_WIZARD_TELEMETRY),
    ignoreGitChanges: isTruthy(env.BUGSEE_WIZARD_IGNORE_GIT_CHANGES),
    yes: isTruthy(env.BUGSEE_WIZARD_YES),
    package: pkg === undefined || pkg === '' ? undefined : pkg,
  };
}

/** Raw commander option values; booleans are `undefined` when the flag was not given. */
export interface RawCliOptions {
  readonly cwd: string;
  readonly debug: boolean;
  readonly dryRun: boolean;
  readonly nonInteractive?: boolean | undefined;
  readonly json?: boolean | undefined;
  readonly package?: string | undefined;
  readonly token?: string | undefined;
  readonly ignoreGitChanges?: boolean | undefined;
  readonly yes?: boolean | undefined;
  readonly sdkVersion?: string | undefined;
  readonly runtime?: string | undefined;
}

export interface BuiltOptions {
  readonly cwd: string;
  readonly debug: boolean;
  readonly dryRun: boolean;
  readonly nonInteractive: boolean;
  readonly json: boolean;
  readonly ignoreGitChanges: boolean;
  readonly yes: boolean;
  readonly package?: string;
  readonly token?: string;
  /** Pins the SDK version recipes are resolved for (skips the npm registry lookup). */
  readonly sdkVersion?: string;
  /** The runtime to set the SDK up for (`none`: leave the code alone). */
  readonly runtime?: 'browser' | 'node' | 'bun' | 'none';
}

const RUNTIMES: readonly string[] = ['browser', 'node', 'bun', 'none'];

/** Empty or whitespace-only strings count as absent. */
function present(v: string | undefined): string | undefined {
  return v === undefined || v.trim() === '' ? undefined : v;
}

/**
 * Pure: an explicitly passed flag wins over the env var (the reverse of
 * Sentry's wizard). The token is flag-only here; `BUGSEE_APP_TOKEN` is read by
 * `selectTokenSource`, so the secret is never copied into options.
 */
export function buildOptions(opts: RawCliOptions, env: NodeJS.ProcessEnv): BuiltOptions {
  const e = readEnvFlags(env);
  const pkg = present(opts.package) ?? e.package;
  const token = present(opts.token);
  const rawSdk = present(opts.sdkVersion) ?? present(env.BUGSEE_WIZARD_SDK_VERSION);
  // normalized: `v1.2.3` and ` 1.2.3 ` both become `1.2.3`
  const sdkVersion = rawSdk === undefined ? undefined : semver.valid(rawSdk.trim());
  if (sdkVersion === null) {
    throw new Error(`Invalid SDK version "${rawSdk}": expected an exact semantic version`);
  }
  const rawRuntime = present(opts.runtime) ?? present(env.BUGSEE_WIZARD_RUNTIME);
  const runtime = rawRuntime === undefined ? undefined : rawRuntime.trim().toLowerCase();
  if (runtime !== undefined && !RUNTIMES.includes(runtime)) {
    throw new Error(`Invalid runtime "${rawRuntime}": expected browser, node, bun or none`);
  }
  return {
    cwd: opts.cwd,
    debug: opts.debug,
    dryRun: opts.dryRun,
    nonInteractive: opts.nonInteractive ?? e.nonInteractive,
    json: opts.json ?? e.json,
    ignoreGitChanges: opts.ignoreGitChanges ?? e.ignoreGitChanges,
    yes: opts.yes ?? e.yes,
    ...(pkg === undefined ? {} : { package: pkg }),
    ...(token === undefined ? {} : { token }),
    ...(sdkVersion === undefined ? {} : { sdkVersion }),
    ...(runtime === undefined ? {} : { runtime: runtime as NonNullable<BuiltOptions['runtime']> }),
  };
}

/** 0 ok, 1 failed, 2 missing input, 3 incomplete in non-interactive mode, 130/143 interrupted (SIGINT/SIGTERM). */
export function exitCodeFor(
  result: WizardRunResult,
  nonInteractive: boolean,
): 0 | 1 | 2 | 3 | 130 | 143 {
  if (result.error === 'interrupted') return 130;
  if (result.error === 'terminated') return 143;
  if (result.error === 'missing-input') return 2;
  if (!result.ok) return 1;
  if (result.incomplete && nonInteractive) return 3;
  return 0;
}

export function formatJsonResult(result: WizardRunResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

/** A Logger that writes only to stderr, so stdout stays a single JSON document. */
export function createStderrLogger(opts: { readonly debug: boolean }): Logger {
  const w = (tag: string, msg: string): void => {
    process.stderr.write(`[${tag}] ${msg}\n`);
  };
  return {
    info: (m) => w('info', m),
    warn: (m) => w('warn', m),
    error: (m) => w('error', m),
    success: (m) => w('ok', m),
    step: (m) => w('step', m),
    debug: (m) => {
      if (opts.debug) w('debug', m);
    },
  };
}

export interface TokenInputDeps {
  readonly readStdin: () => Promise<string>;
  readonly isTTY: boolean;
}

/** Reads the first line of a stream (the token for `--token -`). */
export async function readStdinToken(stream: AsyncIterable<string | Uint8Array>): Promise<string> {
  let data = '';
  for await (const chunk of stream) {
    data += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (data.includes('\n')) break;
  }
  return data.split('\n')[0] ?? '';
}

/**
 * buildOptions plus the one async step: `--token -` reads the token from
 * stdin (allowed when stdin is not a TTY or `nonInteractive`), so it never
 * appears in the process list. Errors never carry the value.
 */
export async function resolveOptions(
  opts: RawCliOptions,
  env: NodeJS.ProcessEnv,
  deps: TokenInputDeps = {
    readStdin: () => readStdinToken(process.stdin),
    isTTY: process.stdin.isTTY === true,
  },
): Promise<BuiltOptions> {
  const built = buildOptions(opts, env);
  if (built.token !== '-') return built;
  if (deps.isTTY && !built.nonInteractive) throw new MissingInputError('token');
  const line = (await deps.readStdin()).trim().split(/\r?\n/)[0]?.trim() ?? '';
  if (line === '') throw new MissingInputError('token');
  return { ...built, token: line };
}

export interface ErrorOutcome {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly level: 'plain' | 'error';
}

/** Maps a top-level error to exit code and presentation. Cancel is a clean exit. */
export function outcomeForError(err: unknown): ErrorOutcome {
  if (err instanceof CancelledError) return { code: 0, message: CANCELLED_MESSAGE, level: 'plain' };
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof MissingInputError) return { code: 2, message, level: 'error' };
  return { code: 1, message, level: 'error' };
}

export interface ErrorIo {
  stdout(s: string): void;
  stderr(s: string): void;
  error(message: string): void;
}

const defaultErrorIo = (): ErrorIo => ({
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  error: (m) => createLogger({ debug: false }).error(m),
});

/**
 * Present a top-level error and return the exit code. With `--json` stdout carries exactly one
 * result object (`missing-input` + field for MissingInputError); a cancel is a plain stderr line.
 */
export function reportError(
  err: unknown,
  opts: { readonly json: boolean },
  io: ErrorIo = defaultErrorIo(),
): 0 | 1 | 2 {
  const outcome = outcomeForError(err);
  if (outcome.level === 'plain') {
    io.stderr(`${outcome.message}\n`);
  } else if (opts.json) {
    const result: WizardRunResult = {
      ok: false,
      incomplete: false,
      steps: [],
      ...(err instanceof MissingInputError
        ? { error: 'missing-input', field: err.field }
        : { error: 'error' }),
      message: outcome.message,
    };
    io.stdout(`${JSON.stringify(result)}\n`);
  } else {
    io.error(outcome.message);
  }
  return outcome.code;
}

export interface Output {
  readonly log: Logger;
  result(result: WizardRunResult): void;
}

export function createOutput(opts: { readonly json: boolean; readonly debug: boolean }): Output {
  if (opts.json) return { log: createStderrLogger(opts), result: formatJsonResult };
  return { log: createLogger(opts), result: () => undefined };
}
