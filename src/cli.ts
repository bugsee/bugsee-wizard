#!/usr/bin/env node
import * as clack from '@clack/prompts';
import { Command } from '@commander-js/extra-typings';
import { runInstall } from './commands/install.js';
import { runUninstall } from './commands/uninstall.js';
import { buildOptions } from './engine/noninteractive.js';

const program = new Command()
  .name('bugsee-wizard')
  .description('Set up Bugsee in your project.')
  .version('0.0.0', '-v, --version')
  .option('-C, --cwd <path>', 'run as if started in <path>', process.cwd())
  .option('--debug', 'enable verbose logging', false)
  .option('--dry-run', 'plan changes without writing files', false)
  .option(
    '--non-interactive',
    'never prompt; fail with exit code 2 on missing input (env: BUGSEE_WIZARD_NON_INTERACTIVE)',
  )
  .option(
    '--json',
    'print one JSON result object on stdout, everything else on stderr (env: BUGSEE_WIZARD_JSON)',
  )
  .option('--package <path>', 'target package in a monorepo (env: BUGSEE_WIZARD_PACKAGE)')
  .option('--token <token>', 'Bugsee app token (env: BUGSEE_APP_TOKEN)')
  .option(
    '--telemetry',
    'send anonymous usage events (off by default; env: BUGSEE_WIZARD_TELEMETRY)',
  )
  .option(
    '--ignore-git-changes',
    'proceed even if the git working tree is dirty (env: BUGSEE_WIZARD_IGNORE_GIT_CHANGES)',
  )
  .option(
    '--yes',
    'confirm destructive actions such as uninstall in non-interactive mode (env: BUGSEE_WIZARD_YES)',
  )
  .addHelpText(
    'after',
    '\nPrecedence: an explicit flag always wins over its environment variable.\nTruthy env values: 1, true, yes.',
  );

program
  .command('install', { isDefault: true })
  .description('install and configure Bugsee in the current project')
  .action(async () => {
    const opts = program.opts();
    await runInstall(buildOptions(opts, process.env));
  });

program
  .command('uninstall')
  .description('remove Bugsee configuration from the current project')
  .action(async () => {
    const opts = program.opts();
    await runUninstall(buildOptions(opts, process.env));
  });

try {
  await program.parseAsync();
} catch (err) {
  clack.log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
