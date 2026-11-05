import path from 'node:path';

import * as clack from '@clack/prompts';

import type { WizardOptions } from '../../core/context.js';
import { createLogger } from '../../core/logger.js';
import type { RecipeResult, RollbackResult } from '../../core/result.js';
import { runRollback, runSteps, type Step } from '../../core/step.js';
import { discoverIosPaths, withScheme } from './paths.js';
import { isPodOnPath } from './pod.js';
import { addPodStep } from './steps/add-pod.js';
import { addSchemePostActionStep } from './steps/add-scheme-postaction.js';
import { addSpmDependencyStep } from './steps/add-spm-dependency.js';
import { injectAppDelegateStep } from './steps/inject-app-delegate.js';
import { runPodInstallStep } from './steps/run-pod-install.js';
import type { IosContext, IosDistributionMethod, IosOptions } from './types.js';

export interface IosRecipeInput extends WizardOptions {
  /**
   * Pre-supplied app token. When provided, the recipe skips the token
   * prompt — used by parent recipes (e.g. React Native).
   */
  readonly token?: string;
  /**
   * Pre-filled option overrides. Each provided field skips its prompt.
   */
  readonly options?: Partial<IosOptions>;
  /**
   * When true, the recipe omits its own success / next-steps notes —
   * the parent recipe owns the final summary.
   */
  readonly silent?: boolean;
}

export async function runIosRecipe(input: IosRecipeInput): Promise<RecipeResult> {
  const log = createLogger({ debug: input.debug });

  let paths = await discoverIosPaths(input.cwd).catch((err) => {
    clack.log.error(err instanceof Error ? err.message : String(err));
    return null;
  });
  if (!paths) {
    clack.cancel('Could not locate the iOS project files. Cancelled.');
    return 'failed';
  }

  // When the project has multiple shared schemes (App + Extensions, Watch
  // companion, etc.), prompt the user. The default is the heuristic match
  // already chosen by paths.ts (scheme matching the project name, or the
  // first one), so the common single-scheme case is just a confirmation.
  if (paths.availableSchemes.length > 1) {
    const options = paths.availableSchemes.map((schemePath) => {
      const name = schemePath.split('/').pop()?.replace('.xcscheme', '') ?? schemePath;
      return { value: schemePath, label: name };
    });
    const picked = await clack.select<string>({
      message: 'Multiple schemes found — which one is the main app target?',
      options,
      initialValue: paths.scheme,
    });
    if (clack.isCancel(picked)) {
      clack.cancel('Cancelled.');
      return 'cancelled';
    }
    if (picked !== paths.scheme) {
      paths = await withScheme(paths, picked);
    }
  }

  log.info(
    `Detected Xcode project ${paths.xcodeProjectName} (scheme: ${paths.schemeName}, target: ${paths.targetName})`,
  );

  let tokenValue: string;
  if (input.token !== undefined) {
    tokenValue = input.token;
  } else {
    const tokenAnswer = await clack.text({
      message: 'Bugsee app token (iOS)',
      placeholder: 'paste from your Bugsee dashboard',
      validate: (v) => {
        const trimmed = (v ?? '').trim();
        if (trimmed.length === 0) return 'Token is required';
        // The token is interpolated raw into Swift/ObjC source and into the
        // post-action shell line. Restrict to a safe character set so we
        // don't have to escape downstream and so we fail loudly on paste
        // mistakes (whole URLs, surrounding quotes, etc.).
        if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
          return 'Tokens are alphanumeric (with `.`, `_`, `-` permitted) — looks like extra characters got pasted';
        }
        return undefined;
      },
    });
    if (clack.isCancel(tokenAnswer)) {
      clack.cancel('Cancelled.');
      return 'cancelled';
    }
    tokenValue = tokenAnswer;
  }

  let distribution: IosDistributionMethod;
  if (input.options?.distribution !== undefined) {
    distribution = input.options.distribution;
  } else {
    const distributionDefault: IosDistributionMethod = paths.podfile ? 'cocoapods' : 'spm';
    const choice = await clack.select<IosDistributionMethod>({
      message: 'Distribution method for the Bugsee SDK',
      options: [
        {
          value: 'cocoapods',
          label: 'CocoaPods',
          hint: paths.podfile ? 'Podfile detected' : 'no Podfile detected',
        },
        {
          value: 'spm',
          label: 'Swift Package Manager',
          hint: 'github.com/bugsee/spm',
        },
      ],
      initialValue: distributionDefault,
    });
    if (clack.isCancel(choice)) {
      clack.cancel('Cancelled.');
      return 'cancelled';
    }
    distribution = choice;
  }

  let sizeAnalysis: boolean;
  if (input.options?.sizeAnalysis !== undefined) {
    sizeAnalysis = input.options.sizeAnalysis;
  } else {
    const answer = await clack.confirm({
      message: 'Enable build size analysis?',
      initialValue: false,
    });
    if (clack.isCancel(answer)) {
      clack.cancel('Cancelled.');
      return 'cancelled';
    }
    sizeAnalysis = answer;
  }

  let sizeAnalysisAllConfigurations = false;
  if (input.options?.sizeAnalysisAllConfigurations !== undefined) {
    sizeAnalysisAllConfigurations = input.options.sizeAnalysisAllConfigurations;
  } else if (sizeAnalysis) {
    const allConfigs = await clack.confirm({
      message: 'Upload for all build configurations? (default: Release only)',
      initialValue: false,
    });
    if (clack.isCancel(allConfigs)) {
      clack.cancel('Cancelled.');
      return 'cancelled';
    }
    sizeAnalysisAllConfigurations = allConfigs;
  }

  let runPodInstall = false;
  if (input.options?.runPodInstall !== undefined) {
    runPodInstall = input.options.runPodInstall;
  } else if (distribution === 'cocoapods') {
    const podAvailable = isPodOnPath();
    const answer = await clack.confirm({
      message: podAvailable
        ? 'Run `pod install` now to sync everything?'
        : 'Run `pod install` now? (CocoaPods is not on PATH — this will fail unless installed first)',
      initialValue: podAvailable,
    });
    if (clack.isCancel(answer)) {
      clack.cancel('Cancelled.');
      return 'cancelled';
    }
    runPodInstall = answer;
  }

  let autoInjectAppDelegate: boolean;
  if (input.options?.autoInjectAppDelegate !== undefined) {
    autoInjectAppDelegate = input.options.autoInjectAppDelegate;
  } else {
    const answer = await clack.confirm({
      message:
        paths.appDelegate !== null
          ? `Auto-inject Bugsee.launch into ${paths.appDelegate.split('/').slice(-2).join('/')}?`
          : 'Auto-inject Bugsee.launch into AppDelegate? (none found — will print a snippet instead)',
      initialValue: paths.appDelegate !== null,
    });
    if (clack.isCancel(answer)) {
      clack.cancel('Cancelled.');
      return 'cancelled';
    }
    autoInjectAppDelegate = answer;
  }

  const iosOptions: IosOptions = {
    distribution,
    sizeAnalysis,
    sizeAnalysisAllConfigurations,
    autoInjectAppDelegate,
    runPodInstall,
  };

  const ctx: IosContext = {
    cwd: input.cwd,
    debug: input.debug,
    dryRun: input.dryRun,
    kind: 'ios',
    tokens: { ios: tokenValue.trim() },
    log,
    iosOptions,
    iosPaths: paths,
  };

  // Build the step list. Each step's precheck guards against running when
  // its preconditions don't apply (e.g. SPM step is satisfied when the user
  // chose CocoaPods, and the AppDelegate step is satisfied when auto-inject
  // wasn't selected).
  const steps: Step<IosContext>[] = [
    addPodStep,
    addSpmDependencyStep,
    addSchemePostActionStep,
    injectAppDelegateStep,
    runPodInstallStep,
  ];

  const result = await runSteps(steps, ctx);

  if (result.failed) {
    clack.log.error('One or more steps failed; previous changes were rolled back.');
    return 'failed';
  }

  // Parent recipe (e.g. React Native) has indicated it will print the
  // final summary itself.
  if (input.silent) return 'ok';

  // Was the AppDelegate step actually applied, or did it self-skip (no
  // AppDelegate / no didFinishLaunching / SwiftUI App)? If it skipped, fall
  // back to printing the snippet for the user — same effective outcome as
  // when the user declined auto-inject.
  const appDelegateSkipped = result.results.some(
    (r) => r.id === 'ios.inject-app-delegate' && r.outcome === 'skipped',
  );
  const showSnippet = !autoInjectAppDelegate || appDelegateSkipped;

  // Post-recipe instructions tailored to the user's choices.
  const notes: string[] = [];
  if (distribution === 'cocoapods' && !runPodInstall) {
    notes.push('Run `pod install` (from your Podfile directory) to fetch the SDK.');
  } else if (distribution === 'spm') {
    notes.push('Open the project in Xcode and let SPM resolve packages.');
  }
  if (showSnippet) {
    notes.push('');
    notes.push('Add to your AppDelegate:');
    notes.push('');
    notes.push('Swift:');
    notes.push('  import Bugsee');
    notes.push(`  Bugsee.launch(token: "${tokenValue.trim()}")`);
    notes.push('');
    notes.push('Objective-C:');
    notes.push('  #import <Bugsee/Bugsee.h>');
    notes.push(`  [Bugsee launchWithToken:@"${tokenValue.trim()}"];`);
  }
  clack.note(notes.join('\n'), 'Next steps');
  return 'ok';
}

/**
 * Roll back the iOS recipe — undo every step in reverse order.
 *
 * Safe to run on a project that was never set up: each step's rollback is
 * a no-op when its target state isn't present. Doesn't ask the user any
 * questions; rollback() doesn't read user options.
 *
 * Returns `'not-found'` when no iOS project was found at `input.cwd`
 * (nothing attempted), `'failed'` when any step's rollback threw, else `'ok'`.
 */
export async function runIosRollback(input: WizardOptions): Promise<RollbackResult> {
  const log = createLogger({ debug: input.debug });

  const paths = await discoverIosPaths(input.cwd, {
    allowMissingScheme: true,
  }).catch((err) => {
    clack.log.error(err instanceof Error ? err.message : String(err));
    return null;
  });
  if (!paths) {
    return 'not-found';
  }

  const ctx: IosContext = {
    cwd: input.cwd,
    debug: input.debug,
    dryRun: input.dryRun,
    kind: 'ios',
    tokens: {},
    log,
    iosOptions: {
      // Defaults are not load-bearing for rollback — every step's rollback
      // path strips by marker / sniffs for our content, regardless of what
      // was chosen at install time.
      distribution: 'cocoapods',
      sizeAnalysis: false,
      sizeAnalysisAllConfigurations: false,
      autoInjectAppDelegate: false,
      runPodInstall: false,
    },
    iosPaths: paths,
  };

  const steps: Step<IosContext>[] = [
    addPodStep,
    addSpmDependencyStep,
    addSchemePostActionStep,
    injectAppDelegateStep,
    runPodInstallStep,
  ];

  const result = await runRollback(steps, ctx);
  let failed = result.failed;

  // Install may have written the Archive post-action to a scheme the user
  // picked in the multi-scheme prompt, which is not the default one discovery
  // selected above. Rollback has no prompt, so sweep every other shared scheme.
  for (const scheme of paths.availableSchemes) {
    if (scheme === paths.scheme) continue;
    const schemeCtx: IosContext = {
      ...ctx,
      iosPaths: { ...paths, scheme, schemeName: path.basename(scheme, '.xcscheme') },
    };
    const extra = await runRollback([addSchemePostActionStep], schemeCtx);
    if (extra.failed) failed = true;
  }
  return failed ? 'failed' : 'ok';
}
