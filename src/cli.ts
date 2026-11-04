#!/usr/bin/env node
import * as clack from '@clack/prompts';
import { Command } from '@commander-js/extra-typings';

import { runInstall } from './commands/install.js';
import { runUninstall } from './commands/uninstall.js';

const program = new Command()
  .name('bugsee-wizard')
  .description('Set up Bugsee in your project.')
  .version('0.0.0', '-v, --version')
  .option('-C, --cwd <path>', 'run as if started in <path>', process.cwd())
  .option('--debug', 'enable verbose logging', false)
  .option('--dry-run', 'plan changes without writing files', false);

program
  .command('install', { isDefault: true })
  .description('install and configure Bugsee in the current project')
  .action(async () => {
    const opts = program.opts();
    await runInstall({
      cwd: opts.cwd,
      debug: opts.debug,
      dryRun: opts.dryRun,
      nonInteractive: false,
      json: false,
    });
  });

program
  .command('uninstall')
  .description('remove Bugsee configuration from the current project')
  .action(async () => {
    const opts = program.opts();
    await runUninstall({
      cwd: opts.cwd,
      debug: opts.debug,
      dryRun: opts.dryRun,
      nonInteractive: false,
      json: false,
    });
  });

try {
  await program.parseAsync();
} catch (err) {
  clack.log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
