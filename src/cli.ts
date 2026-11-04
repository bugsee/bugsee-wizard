#!/usr/bin/env node
import { createBaseProgram } from './cli-program.js';
import { runInstall } from './commands/install.js';
import { runUninstall } from './commands/uninstall.js';
import { readEnvFlags, reportError, resolveOptions } from './engine/noninteractive.js';

const program = createBaseProgram();

program
  .command('install', { isDefault: true })
  .description('install and configure Bugsee in the current project')
  .action(async () => {
    const opts = program.opts();
    // the command sets process.exitCode from its result (exitCodeFor in non-interactive mode)
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
  // flag over env, as in buildOptions (which may itself be what threw)
  const json = program.opts().json ?? readEnvFlags(process.env).json;
  process.exit(reportError(err, { json }));
}
