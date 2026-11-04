import * as clack from '@clack/prompts';

import type { WizardOptions } from '../../core/context.js';
import { createLogger } from '../../core/logger.js';
import { type Step, runRollback, runSteps } from '../../core/step.js';
import { runAndroidRecipe, runAndroidRollback } from '../android/run.js';
import { runIosRecipe, runIosRollback } from '../ios/run.js';
import { detectPackageManager, isManagerOnPath } from './package-manager.js';
import { discoverRnPaths } from './paths.js';
import { ensureRnBugseePackageStep } from './steps/ensure-rn-bugsee-package.js';
import { injectJsEntryStep } from './steps/inject-js-entry.js';
import { runPackageInstallStep } from './steps/run-package-install.js';
import { RN_PACKAGE_NAME, type RnContext, type RnLaunchPath, type RnOptions } from './types.js';

export interface ReactNativeRecipeInput extends WizardOptions {}

const TOKEN_VALIDATE = (v: string): string | undefined => {
  const trimmed = v.trim();
  if (trimmed.length === 0) return 'Token is required';
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    return 'Tokens are alphanumeric (with `.`, `_`, `-` permitted) — looks like extra characters got pasted';
  }
  return undefined;
};

async function pickLaunchPath(): Promise<RnLaunchPath | null> {
  clack.note(
    [
      'Native (recommended): SDK launches before the JS bridge comes up.',
      "  Android: auto-init via the SDK's `BugseeInitProvider` ContentProvider",
      '           — no code change, just `<meta-data>` wiring in AndroidManifest.',
      '           Manual init in `Application.onCreate()` is also possible but',
      '           slightly less early; the wizard picks the ContentProvider path.',
      '  iOS:     `Bugsee.launch()` in your AppDelegate.',
      'Either way, crashes / console / network from the first ms of process',
      'lifetime are captured. Filters configured in JS only apply once the',
      "bridge is ready; events arriving before that don't see them.",
      '',
      'JavaScript: launch happens after the bridge is ready, via your',
      'JS code calling `Bugsee.launch(token)` in App.tsx. Filters apply to',
      'every event, but you lose early-process visibility.',
    ].join('\n'),
    'Native vs JS launch',
  );
  const choice = await clack.select<RnLaunchPath>({
    message: 'Where should Bugsee launch?',
    options: [
      { value: 'native', label: 'Native (recommended)' },
      { value: 'javascript', label: 'JavaScript' },
    ],
    initialValue: 'native',
  });
  return clack.isCancel(choice) ? null : choice;
}

async function pickPlatforms(
  hasAndroid: boolean,
  hasIos: boolean,
): Promise<readonly ('android' | 'ios')[] | null> {
  const both = hasAndroid && hasIos;
  if (!both) {
    if (hasAndroid) return ['android'];
    if (hasIos) return ['ios'];
    return [];
  }
  const choice = await clack.select<'both' | 'android' | 'ios'>({
    message: 'Set up Bugsee for which platform?',
    options: [
      { value: 'both', label: 'Both Android and iOS' },
      { value: 'android', label: 'Android only' },
      { value: 'ios', label: 'iOS only' },
    ],
    initialValue: 'both',
  });
  if (clack.isCancel(choice)) return null;
  if (choice === 'both') return ['android', 'ios'];
  return [choice];
}

export async function runReactNativeRecipe(input: ReactNativeRecipeInput): Promise<void> {
  const log = createLogger({ debug: input.debug });
  const paths = await discoverRnPaths(input.cwd);

  if (!paths.androidPath && !paths.iosPath) {
    clack.log.warn('No `android/` or `ios/` subdirectory found at the project root.');
    return;
  }

  // 1. Pick platforms.
  const targets = await pickPlatforms(!!paths.androidPath, !!paths.iosPath);
  if (targets === null) {
    clack.cancel('Cancelled.');
    return;
  }
  if (targets.length === 0) {
    clack.log.warn('Nothing to do.');
    return;
  }

  // 2. Pick launch path.
  const launchPath = await pickLaunchPath();
  if (launchPath === null) {
    clack.cancel('Cancelled.');
    return;
  }

  // 3. Per-platform tokens (Bugsee's RN dashboard issues separate ones).
  let androidToken: string | null = null;
  let iosToken: string | null = null;
  if (targets.includes('android')) {
    const ans = await clack.text({
      message: 'Bugsee app token (Android)',
      placeholder: 'paste from your Bugsee dashboard',
      validate: TOKEN_VALIDATE,
    });
    if (clack.isCancel(ans)) {
      clack.cancel('Cancelled.');
      return;
    }
    androidToken = ans.trim();
  }
  if (targets.includes('ios')) {
    const ans = await clack.text({
      message: 'Bugsee app token (iOS)',
      placeholder: 'paste from your Bugsee dashboard',
      validate: TOKEN_VALIDATE,
    });
    if (clack.isCancel(ans)) {
      clack.cancel('Cancelled.');
      return;
    }
    iosToken = ans.trim();
  }

  // 4. Auto-inject JS entry?
  const jsEntryLabel = paths.jsEntry ? paths.jsEntry.path.split('/').slice(-2).join('/') : null;
  const autoInjectJsEntry = await clack.confirm({
    message: jsEntryLabel
      ? `Auto-inject Bugsee ${launchPath === 'javascript' ? 'launch' : 'initialize'} into ${jsEntryLabel}?`
      : `Auto-inject Bugsee ${launchPath === 'javascript' ? 'launch' : 'initialize'}? (no entry file found — will print a snippet instead)`,
    initialValue: paths.jsEntry !== null,
  });
  if (clack.isCancel(autoInjectJsEntry)) {
    clack.cancel('Cancelled.');
    return;
  }

  // 5. Package install opt-in.
  const detectedManager = await detectPackageManager(input.cwd);
  const managerAvailable = isManagerOnPath(detectedManager);
  const runPackageInstall = await clack.confirm({
    message: managerAvailable
      ? `Run \`${detectedManager} install\` now to fetch ${RN_PACKAGE_NAME}?`
      : `Run \`${detectedManager} install\` now? (${detectedManager} is not on PATH — this will fail unless installed first)`,
    initialValue: managerAvailable,
  });
  if (clack.isCancel(runPackageInstall)) {
    clack.cancel('Cancelled.');
    return;
  }

  const rnOptions: RnOptions = {
    launchPath,
    autoInjectJsEntry,
    runPackageInstall,
  };

  // 6. RN-level steps (package.json + JS injection + install).
  const tokens: Record<string, string> = {};
  if (androidToken) tokens.android = androidToken;
  if (iosToken) tokens.ios = iosToken;

  const rnCtx: RnContext = {
    cwd: input.cwd,
    debug: input.debug,
    dryRun: input.dryRun,
    kind: 'react-native',
    tokens,
    log,
    rnPaths: paths,
    rnOptions,
  };

  const rnSteps: Step<RnContext>[] = [
    ensureRnBugseePackageStep,
    injectJsEntryStep,
    runPackageInstallStep,
  ];
  const rnResult = await runSteps(rnSteps, rnCtx);
  if (rnResult.failed) {
    clack.log.error('One or more RN-level steps failed; previous changes were rolled back.');
    return;
  }

  // 7. Delegate to platform recipes with launch-path-aware overrides.
  if (targets.includes('android') && paths.androidPath && androidToken) {
    clack.log.step('Configuring Android…');
    await runAndroidRecipe({
      ...input,
      cwd: paths.androidPath,
      token: androidToken,
      options: {
        // Native launch → keep the manifest meta-data wiring so the
        // SDK auto-init ContentProvider fires. JS launch → flip to
        // manual; the JS layer's `Bugsee.launch(token)` call drives
        // initialization through the bridge.
        initMode: launchPath === 'native' ? 'automatic' : 'manual',
      },
      silent: true,
    });
  }
  if (targets.includes('ios') && paths.iosPath && iosToken) {
    clack.log.step('Configuring iOS…');
    await runIosRecipe({
      ...input,
      cwd: paths.iosPath,
      token: iosToken,
      options: {
        // RN's iOS native deps go through CocoaPods (the wrapper's
        // podspec); SPM isn't a meaningful choice here.
        distribution: 'cocoapods',
        // Native launch → inject Bugsee.launch into AppDelegate. JS
        // launch → leave AppDelegate alone; JS owns init.
        autoInjectAppDelegate: launchPath === 'native',
      },
      silent: true,
    });
  }

  // 8. Final unified summary.
  const summary: string[] = [];
  summary.push(`Launch path: ${launchPath === 'native' ? 'Native' : 'JavaScript'}.`);
  if (!runPackageInstall) {
    summary.push(`Run \`${detectedManager} install\` to fetch ${RN_PACKAGE_NAME}.`);
  }
  if (targets.includes('ios')) {
    summary.push("Run `pod install` from your `ios/` directory if you didn't opt in.");
  }
  if (!autoInjectJsEntry) {
    summary.push('');
    summary.push('Add to your App.tsx / index.js:');
    summary.push('');
    summary.push(`  import Bugsee from '${RN_PACKAGE_NAME}';`);
    if (launchPath === 'javascript') {
      summary.push(`  import { Platform } from 'react-native';`);
      summary.push('');
      summary.push(
        `  Bugsee.launch(Platform.OS === 'ios' ? '${iosToken ?? '<IOS_TOKEN>'}' : '${androidToken ?? '<ANDROID_TOKEN>'}');`,
      );
    } else {
      summary.push('');
      summary.push('  Bugsee.initialize();');
    }
  }
  clack.note(summary.join('\n'), 'Done');
}

/**
 * Roll back both platform recipes against an RN root, plus the
 * RN-level steps (package.json edit, JS-entry injection). Each step's
 * rollback is a no-op when its target state isn't present, so attempting
 * everything is safe even when only one launch path was originally set
 * up.
 */
export async function runReactNativeRollback(input: WizardOptions): Promise<boolean> {
  const log = createLogger({ debug: input.debug });
  const paths = await discoverRnPaths(input.cwd);

  let attempted = false;

  // RN-level rollback first — JS injection depends on tokens for the
  // marker but the strip itself doesn't need them, so we pass empties.
  const rnCtx: RnContext = {
    cwd: input.cwd,
    debug: input.debug,
    dryRun: input.dryRun,
    kind: 'react-native',
    tokens: {},
    log,
    rnPaths: paths,
    rnOptions: {
      launchPath: 'native',
      autoInjectJsEntry: false,
      runPackageInstall: false,
    },
  };
  const rnSteps: Step<RnContext>[] = [
    ensureRnBugseePackageStep,
    injectJsEntryStep,
    runPackageInstallStep,
  ];
  await runRollback(rnSteps, rnCtx);
  attempted = true;

  // Then platform rollbacks.
  if (paths.androidPath) {
    const ran = await runAndroidRollback({ ...input, cwd: paths.androidPath });
    if (ran) attempted = true;
  }
  if (paths.iosPath) {
    const ran = await runIosRollback({ ...input, cwd: paths.iosPath });
    if (ran) attempted = true;
  }
  return attempted;
}
