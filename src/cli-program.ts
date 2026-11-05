import { Command } from '@commander-js/extra-typings';

export function createBaseProgram() {
  return new Command()
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
    .option('--no-non-interactive', 'override the env var and turn this off')
    .option(
      '--json',
      'print one JSON result object on stdout, everything else on stderr (env: BUGSEE_WIZARD_JSON)',
    )
    .option('--no-json', 'override the env var and turn this off')
    .option('--package <path>', 'target package in a monorepo (env: BUGSEE_WIZARD_PACKAGE)')
    .option(
      '--token <token>',
      'Bugsee app token; visible to other users in the process list, so prefer the BUGSEE_APP_TOKEN environment variable or `--token -` (read from stdin)',
    )
    .option(
      '--telemetry',
      'send anonymous usage events (off by default; env: BUGSEE_WIZARD_TELEMETRY)',
    )
    .option('--no-telemetry', 'override the env var and turn this off')
    .option(
      '--ignore-git-changes',
      'proceed even if the git working tree is dirty (env: BUGSEE_WIZARD_IGNORE_GIT_CHANGES)',
    )
    .option('--no-ignore-git-changes', 'override the env var and turn this off')
    .option(
      '-y, --yes',
      'answer yes to confirmations and take the default of option questions (uninstall, applying changes, pnpm 11 install-script approval, Android/iOS/React Native options); tokens and the git-state checks still need --token / --ignore-git-changes (env: BUGSEE_WIZARD_YES)',
    )
    .option('--no-yes', 'override the env var and turn this off')
    .option(
      '--sdk-version <version>',
      'resolve recipes for this exact SDK version instead of the npm "beta" tag (env: BUGSEE_WIZARD_SDK_VERSION)',
    )
    .addHelpText(
      'after',
      '\nPrecedence: an explicit flag always wins over its environment variable.\nTruthy env values: 1, true, yes.',
    );
}
