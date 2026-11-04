import type { ProjectKind } from '../project-kind.js';
import type { Logger } from './logger.js';

export interface WizardOptions {
  readonly cwd: string;
  readonly debug: boolean;
  readonly dryRun: boolean;
  readonly nonInteractive: boolean;
  readonly json: boolean;
}

export interface WizardContext extends WizardOptions {
  readonly kind: ProjectKind;
  readonly tokens: Readonly<Record<string, string>>;
  readonly log: Logger;
}
