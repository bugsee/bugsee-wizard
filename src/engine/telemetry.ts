import { randomUUID } from 'node:crypto';
import { isTruthy } from './noninteractive.js';

/**
 * Opt-in, anonymous telemetry GATE. There is deliberately no network
 * transport in this module: with no sink, nothing leaves the process. The
 * runId is generated per createTelemetry() call and never persisted.
 */

export const WIZARD_VERSION = '0.0.0';

const NAMES = ['run', 'step'] as const;
const OUTCOMES = ['applied', 'skipped', 'manual', 'failed'] as const;
const CATEGORIES = ['parse', 'io', 'network', 'install', 'unsupported', 'other'] as const;
/** Recipe/step ids: short identifiers only, so free text (paths, messages) cannot ride along. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type TelemetryEvent = {
  name: (typeof NAMES)[number];
  wizard: string;
  nodeMajor: number;
  os: 'darwin' | 'linux' | 'win32' | 'other';
  recipe?: string;
  step?: string;
  outcome?: (typeof OUTCOMES)[number];
  errorCategory?: (typeof CATEGORIES)[number];
  runId: string;
};

export interface TelemetrySink {
  send(e: TelemetryEvent): void;
}

export type TelemetryInput = Omit<TelemetryEvent, 'runId' | 'wizard' | 'nodeMajor' | 'os'>;

function oneOf<T extends string>(set: readonly T[], v: unknown): T | undefined {
  return set.find((x) => x === v);
}

function osName(): TelemetryEvent['os'] {
  const p = process.platform;
  return p === 'darwin' || p === 'linux' || p === 'win32' ? p : 'other';
}

/**
 * Enabled only by `flag === true` or a truthy BUGSEE_WIZARD_TELEMETRY.
 * Out-of-vocabulary values are dropped: an unknown `name` drops the whole
 * event; an unknown outcome/errorCategory/recipe/step drops just that field;
 * unknown extra keys are never copied.
 */
export function createTelemetry(opts: {
  flag: boolean;
  env: NodeJS.ProcessEnv;
  sink?: TelemetrySink;
}): { enabled: boolean; emit(e: TelemetryInput): void } {
  const enabled = opts.flag === true || isTruthy(opts.env.BUGSEE_WIZARD_TELEMETRY);
  const runId = randomUUID();
  const { sink } = opts;
  return {
    enabled,
    emit(input) {
      if (!enabled || sink === undefined) return;
      const name = oneOf(NAMES, input.name);
      if (name === undefined) return;
      const outcome = oneOf(OUTCOMES, input.outcome);
      const errorCategory = oneOf(CATEGORIES, input.errorCategory);
      const recipe =
        typeof input.recipe === 'string' && ID_RE.test(input.recipe) ? input.recipe : undefined;
      const step =
        typeof input.step === 'string' && ID_RE.test(input.step) ? input.step : undefined;
      sink.send({
        name,
        wizard: WIZARD_VERSION,
        nodeMajor: Number(process.versions.node.split('.')[0]),
        os: osName(),
        ...(recipe === undefined ? {} : { recipe }),
        ...(step === undefined ? {} : { step }),
        ...(outcome === undefined ? {} : { outcome }),
        ...(errorCategory === undefined ? {} : { errorCategory }),
        runId,
      });
    },
  };
}
