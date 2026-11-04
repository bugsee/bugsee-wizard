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

/** The single JSON object printed on stdout in `--json` mode. */
export interface WizardRunResult {
  ok: boolean;
  incomplete: boolean;
  steps: { id: string; outcome: string }[];
  error?: string;
  field?: string;
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
}

/**
 * Pure: an explicitly passed flag wins over the env var (the reverse of
 * Sentry's wizard). The token is flag-only here; `BUGSEE_APP_TOKEN` is read by
 * `selectTokenSource`, so the secret is never copied into options.
 */
export function buildOptions(opts: RawCliOptions, env: NodeJS.ProcessEnv): BuiltOptions {
  const e = readEnvFlags(env);
  const pkg = opts.package ?? e.package;
  return {
    cwd: opts.cwd,
    debug: opts.debug,
    dryRun: opts.dryRun,
    nonInteractive: opts.nonInteractive ?? e.nonInteractive,
    json: opts.json ?? e.json,
    ignoreGitChanges: opts.ignoreGitChanges ?? e.ignoreGitChanges,
    yes: opts.yes ?? e.yes,
    ...(pkg === undefined ? {} : { package: pkg }),
    ...(opts.token === undefined ? {} : { token: opts.token }),
  };
}

/** 0 ok, 1 failed, 2 missing input, 3 incomplete in non-interactive mode. */
export function exitCodeFor(result: WizardRunResult, nonInteractive: boolean): 0 | 1 | 2 | 3 {
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

export interface Output {
  readonly log: Logger;
  result(result: WizardRunResult): void;
}

export function createOutput(opts: { readonly json: boolean; readonly debug: boolean }): Output {
  if (opts.json) return { log: createStderrLogger(opts), result: formatJsonResult };
  return { log: createLogger(opts), result: () => undefined };
}
