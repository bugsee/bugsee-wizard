import type { ProjectKind } from '../project-kind.js';
import type { Logger } from './logger.js';

/** Never log or stringify options: they may hold the token. */
export interface WizardOptions {
  readonly cwd: string;
  readonly debug: boolean;
  readonly dryRun: boolean;
  readonly nonInteractive: boolean;
  readonly json: boolean;
  readonly ignoreGitChanges: boolean;
  /** Confirms destructive/uninstall actions in non-interactive mode. */
  readonly yes: boolean;
  readonly package?: string;
  /** Explicit `--token` value; `BUGSEE_APP_TOKEN` is resolved by selectTokenSource and never stored here. */
  readonly token?: string;
}

export interface WizardContext extends WizardOptions {
  readonly kind: ProjectKind;
  readonly tokens: Readonly<Record<string, string>>;
  readonly log: Logger;
}
