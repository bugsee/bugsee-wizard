import * as clack from '@clack/prompts';

/** What clack returns for Ctrl-C; `clack.isCancel` narrows to exactly this. */
type Cancel = typeof clack.CANCEL_SYMBOL;

/**
 * Prompts with `--yes` support, for the flows that talk to clack directly.
 *
 * `--yes` answers the question with its recommended default (what `npm init -y` does) and says so
 * in the log, so the run stays readable. A question with no default (a token, a project to pick)
 * is still asked: there is nothing to assume. The return type is clack's own (the answer or the
 * cancel symbol), so `clack.isCancel` checks at the call sites stay as they are.
 */

/** Print what `--yes` chose, so a scripted run's log still says what happened. */
function chose(message: string, answer: string): void {
  clack.log.info(`${message} ${answer} (--yes)`);
}

export interface ConfirmConfig {
  readonly message: string;
  readonly initialValue: boolean;
  /**
   * With `--yes`, answer this instead of the default. For a gate on the very action the user
   * invoked ("Detected X. Continue?", "Remove Bugsee from this project?"), where the default is
   * not what `--yes` means.
   */
  readonly assume?: boolean;
}

export async function confirm(
  yes: boolean | undefined,
  config: ConfirmConfig,
): Promise<boolean | Cancel> {
  if (yes === true) {
    const answer = config.assume ?? config.initialValue;
    chose(config.message, answer ? 'Yes' : 'No');
    return answer;
  }
  return clack.confirm({ message: config.message, initialValue: config.initialValue });
}

export async function select<T extends string>(
  yes: boolean | undefined,
  config: Parameters<typeof clack.select<T>>[0],
): Promise<T | Cancel> {
  if (yes === true && config.initialValue !== undefined) {
    const picked = config.options.find((o) => o.value === config.initialValue);
    chose(config.message, String(picked?.label ?? config.initialValue));
    return config.initialValue;
  }
  return clack.select<T>(config);
}
