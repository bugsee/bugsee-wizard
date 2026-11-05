import * as clack from '@clack/prompts';

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  success(msg: string): void;
  step(msg: string): void;
  debug(msg: string): void;
}

export interface LoggerOptions {
  readonly debug: boolean;
}

export function createLogger(opts: LoggerOptions): Logger {
  return {
    info: (msg) => clack.log.info(msg),
    warn: (msg) => clack.log.warn(msg),
    error: (msg) => clack.log.error(msg),
    success: (msg) => clack.log.success(msg),
    step: (msg) => clack.log.step(msg),
    debug: (msg) => {
      if (opts.debug) clack.log.message(`[debug] ${msg}`);
    },
  };
}
