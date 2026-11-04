#!/usr/bin/env node
import * as clack from '@clack/prompts';
import { createBaseProgram } from './cli-program.js';
import { runInstall } from './commands/install.js';
import { runUninstall } from './commands/uninstall.js';
import { outcomeForError, resolveOptions } from './engine/noninteractive.js';

const program = createBaseProgram();

program
  .command('install', { isDefault: true })
  .description('install and configure Bugsee in the current project')
  .action(async () => {
    const opts = program.opts();
    await runInstall(await resolveOptions(opts, process.env));
  });

program
  .command('uninstall')
  .description('remove Bugsee configuration from the current project')
  .action(async () => {
    const opts = program.opts();
    await runUninstall(await resolveOptions(opts, process.env));
  });

try {
  await program.parseAsync();
} catch (err) {
  const outcome = outcomeForError(err);
  if (outcome.level === 'plain') process.stderr.write(`${outcome.message}\n`);
  else clack.log.error(outcome.message);
  process.exit(outcome.code);
}
