import { readFile } from 'node:fs/promises';
import * as clack from '@clack/prompts';
import type { WizardOptions } from '../../core/context.js';
import { createLogger } from '../../core/logger.js';
import type { RecipeResult, RollbackResult } from '../../core/result.js';
import { runRollback, runSteps, type Step } from '../../core/step.js';

import { discoverAndroidPaths } from './paths.js';
import { detectProcessConfig } from './process-config.js';
import { addBuildscriptClasspathStep } from './steps/add-buildscript-classpath.js';
import { applyPluginStep } from './steps/apply-plugin.js';
import { configureBugseeBlockStep } from './steps/configure-bugsee-block.js';
import { ensureGitignoredStep } from './steps/ensure-gitignored.js';
import { ensureMavenCentralStep } from './steps/ensure-maven-central.js';
import { injectLoaderStep } from './steps/inject-loader.js';
import { injectManifestMetaStep } from './steps/inject-manifest-meta.js';
import { injectManifestPlaceholderStep } from './steps/inject-manifest-placeholder.js';
import { injectProviderOverrideStep } from './steps/inject-provider-override.js';
import { writeBugseePropertiesStep } from './steps/write-bugsee-properties.js';
import type { AndroidContext, AndroidInitMode, AndroidOptions } from './types.js';

export interface AndroidRecipeInput extends WizardOptions {
  /**
   * Pre-supplied app token. When provided, the recipe skips the token
   * prompt — used by parent recipes (e.g. React Native) that gather
   * tokens at the top level.
   */
  readonly token?: string;
  /**
   * Pre-filled option overrides. Each provided field skips its prompt.
   * Used by parent recipes to constrain platform behaviour based on
   * higher-level choices (e.g. RN's launch path dictates initMode).
   */
  readonly options?: Partial<AndroidOptions>;
  /**
   * When true, the recipe omits its own success / next-steps notes —
   * the parent recipe owns the final summary. Interactive notes from
   * detection (multi-process picker etc.) still fire.
   */
  readonly silent?: boolean;
  /**
   * Out-parameter for a `silent` run: lines the parent recipe should print in
   * its own summary because the user still has a manual step to do (today:
   * the multi-process `<provider>` override snippet when they chose to add it
   * themselves). The recipe pushes into this array; it stays empty otherwise.
   */
  readonly notes?: string[];
}

function providerOverrideSnippet(proc: string): string[] {
  return [
    `Add inside <application> in AndroidManifest.xml (process="${proc}"):`,
    '',
    '  <provider',
    '      android:name="com.bugsee.library.BugseeInitProvider"',
    `      android:authorities="\${applicationId}.bugseeinitprovider"`,
    '      android:exported="false"',
    `      android:process="${proc}"`,
    '      tools:replace="android:process" />',
    '',
    'And on <manifest>, ensure: xmlns:tools="http://schemas.android.com/tools"',
  ];
}

export async function runAndroidRecipe(input: AndroidRecipeInput): Promise<RecipeResult> {
  const log = createLogger({ debug: input.debug });

  const paths = await discoverAndroidPaths(input.cwd).catch((err) => {
    clack.log.error(err instanceof Error ? err.message : String(err));
    return null;
  });
  if (!paths) {
    clack.cancel('Could not locate the Android project files. Cancelled.');
    return 'failed';
  }
  log.info(
    `Detected ${paths.appBuildGradleDsl} DSL, ${paths.appBuildScriptStyle} at ${paths.appBuildGradle}`,
  );

  let tokenValue: string;
  if (input.token !== undefined) {
    tokenValue = input.token;
  } else {
    const tokenAnswer = await clack.text({
      message: 'Bugsee app token (Android)',
      placeholder: 'paste from your Bugsee dashboard',
      validate: (v) => ((v ?? '').trim().length === 0 ? 'Token is required' : undefined),
    });
    if (clack.isCancel(tokenAnswer)) {
      clack.cancel('Cancelled.');
      return 'cancelled';
    }
    tokenValue = tokenAnswer;
  }

  let initMode: AndroidInitMode;
  if (input.options?.initMode !== undefined) {
    initMode = input.options.initMode;
  } else {
    const choice = await clack.select<AndroidInitMode>({
      message: 'How should Bugsee initialize?',
      options: [
        {
          value: 'automatic',
          label: 'Automatic',
          hint: 'token wired into AndroidManifest, SDK launches via ContentProvider',
        },
        {
          value: 'manual',
          label: 'Manual',
          hint: 'you call Bugsee.launch(token) yourself',
        },
      ],
      initialValue: 'automatic',
    });
    if (clack.isCancel(choice)) {
      clack.cancel('Cancelled.');
      return 'cancelled';
    }
    initMode = choice;
  }

  let ndk: boolean;
  if (input.options?.ndk !== undefined) {
    ndk = input.options.ndk;
  } else {
    const answer = await clack.confirm({
      message: 'Enable native (NDK) crash reporting?',
      initialValue: false,
    });
    if (clack.isCancel(answer)) {
      clack.cancel('Cancelled.');
      return 'cancelled';
    }
    ndk = answer;
  }

  let feedback: boolean;
  if (input.options?.feedback !== undefined) {
    feedback = input.options.feedback;
  } else {
    const answer = await clack.confirm({
      message: 'Include the in-app feedback module?',
      initialValue: false,
    });
    if (clack.isCancel(answer)) {
      clack.cancel('Cancelled.');
      return 'cancelled';
    }
    feedback = answer;
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

  // Detect multi-process declarations in the user's manifest. App-wide
  // (`<application android:process="…">`) is the case where Bugsee's
  // auto-init ContentProvider needs an explicit re-declaration in the
  // user's manifest to match the same process. Per-component
  // declarations are informational only.
  const manifestText = await readFile(paths.appManifest, 'utf8').catch(() => null);
  const processConfig = manifestText ? detectProcessConfig(manifestText) : null;

  let providerProcessOverride: string | null = null;
  if (processConfig?.applicationProcess) {
    const proc = processConfig.applicationProcess;
    clack.note(
      [
        `Your <application> runs in process "${proc}".`,
        '',
        `Bugsee's auto-init ContentProvider runs in the main process by`,
        `default — it won't fire in "${proc}" unless re-declared with the`,
        'same process attribute.',
      ].join('\n'),
      'Multi-process detected',
    );
    const choice = await clack.select<'auto' | 'snippet' | 'manual'>({
      message: 'How would you like to handle this?',
      options: [
        { value: 'auto', label: `Add the <provider> override automatically (process="${proc}")` },
        { value: 'snippet', label: 'Print instructions and I will add it myself' },
        { value: 'manual', label: 'Switch to manual init (call Bugsee.launch yourself)' },
      ],
      initialValue: 'auto',
    });
    if (clack.isCancel(choice)) {
      clack.cancel('Cancelled.');
      return 'cancelled';
    }
    if (choice === 'auto') providerProcessOverride = proc;
    if (choice === 'manual') {
      // User decided the wizard's automatic ContentProvider path isn't
      // worth fighting for in their multi-process app. Override their
      // earlier init-mode answer rather than re-prompting.
      initMode = 'manual';
    }
  }
  // Component-level processes are independent of an app-wide one: even when
  // the whole <application> runs in a custom process, individual components
  // may declare yet another, and those are not covered by auto-init.
  const componentOnly = (processConfig?.componentProcesses ?? []).filter(
    (p) => p !== processConfig?.applicationProcess,
  );
  if (componentOnly.length > 0) {
    const procList = componentOnly.map((p) => `"${p}"`).join(', ');
    clack.note(
      [
        `Detected per-component custom processes: ${procList}.`,
        '',
        "Bugsee's auto-init ContentProvider won't fire in these processes.",
        'If you need crash reports from them too, switch to manual init and',
        'gate Bugsee.launch on the process name.',
      ].join('\n'),
      'Multi-process detected',
    );
  }

  const androidOptions: AndroidOptions = {
    initMode,
    ndk,
    feedback,
    sizeAnalysis,
    providerProcessOverride,
  };

  const ctx: AndroidContext = {
    cwd: input.cwd,
    debug: input.debug,
    dryRun: input.dryRun,
    kind: 'android',
    tokens: { android: tokenValue.trim() },
    log,
    androidOptions,
    androidPaths: paths,
  };

  const steps: Step<AndroidContext>[] = [ensureMavenCentralStep];
  if (paths.appBuildScriptStyle === 'legacy-apply') {
    steps.push(addBuildscriptClasspathStep);
  }
  steps.push(writeBugseePropertiesStep, ensureGitignoredStep);
  // The Gradle loader exists only to populate `bugseeAppToken` for
  // manifest-placeholder substitution in automatic init mode. Manual
  // mode never references the variable, so the loader stays out.
  if (initMode === 'automatic') {
    steps.push(injectLoaderStep);
  }
  steps.push(applyPluginStep, configureBugseeBlockStep);
  if (initMode === 'automatic') {
    steps.push(injectManifestPlaceholderStep);
  }
  steps.push(injectManifestMetaStep);
  if (providerProcessOverride !== null) {
    steps.push(injectProviderOverrideStep);
  }

  const result = await runSteps(steps, ctx);

  if (result.failed) {
    clack.log.error('One or more steps failed; previous changes were rolled back.');
    return 'failed';
  }

  // Parent recipe (e.g. React Native) has indicated it will print the
  // final summary itself — skip the platform-level notes, but hand back the
  // manual provider-override snippet so the parent can print it.
  const needsManualProviderSnippet =
    initMode === 'automatic' &&
    !!processConfig?.applicationProcess &&
    providerProcessOverride === null;
  if (input.silent) {
    if (needsManualProviderSnippet && processConfig?.applicationProcess) {
      input.notes?.push(...providerOverrideSnippet(processConfig.applicationProcess));
    }
    return 'ok';
  }
  // a dry run wrote nothing: no notes about tokens stored or Gradle to sync
  if (input.dryRun) return 'ok';

  if (initMode === 'manual') {
    const lines: string[] = [
      'Add the following to your Application or main entry point:',
      '',
      'Kotlin:',
      '  Bugsee.launch("<your-token>")',
      '',
      'Java:',
      '  Bugsee.launch("<your-token>");',
      '',
      '(Token is stored in bugsee.properties; load it via BuildConfig or pass it directly.)',
    ];
    if (processConfig?.applicationProcess) {
      lines.push('');
      lines.push('Multi-process: gate Bugsee.launch on the process name —');
      lines.push('  if (isMainProcess()) Bugsee.launch(...)');
    }
    clack.note(lines.join('\n'), 'Next steps');
  } else {
    const lines: string[] = [
      'Bugsee will auto-launch via ContentProvider on app startup.',
      'Token lives in bugsee.properties (gitignored). Sync Gradle to apply.',
    ];
    // User opted out of the auto-add for the multi-process override —
    // hand them the snippet to paste into AndroidManifest themselves.
    if (needsManualProviderSnippet && processConfig?.applicationProcess) {
      lines.push('');
      lines.push(...providerOverrideSnippet(processConfig.applicationProcess));
    }
    clack.note(lines.join('\n'), 'Done');
  }
  return 'ok';
}

/**
 * Roll back the Android recipe — undo every step in reverse order.
 *
 * Safe to run on a project that was never set up: each step's rollback is
 * a no-op when its target state isn't present. Doesn't ask the user any
 * questions; rollback() doesn't read user options.
 *
 * Returns `'not-found'` when no Android project was found at `input.cwd`
 * (nothing attempted), `'failed'` when any step's rollback threw, else `'ok'`.
 */
export async function runAndroidRollback(input: WizardOptions): Promise<RollbackResult> {
  const log = createLogger({ debug: input.debug });

  const paths = await discoverAndroidPaths(input.cwd).catch((err) => {
    clack.log.error(err instanceof Error ? err.message : String(err));
    return null;
  });
  if (!paths) {
    return 'not-found';
  }

  // Rollback doesn't read options, but the type system requires us to
  // construct a context. Use defaults; they're not load-bearing.
  const ctx: AndroidContext = {
    cwd: input.cwd,
    debug: input.debug,
    dryRun: input.dryRun,
    kind: 'android',
    tokens: {},
    log,
    androidOptions: {
      initMode: 'automatic',
      ndk: false,
      feedback: false,
      sizeAnalysis: false,
      providerProcessOverride: null,
    },
    androidPaths: paths,
  };

  // Include EVERY step (legacy classpath, manifest-placeholder, provider
  // override) unconditionally so rollback is safe regardless of which
  // options were chosen at install time. Each step's rollback is a no-op
  // when its marker isn't present.
  const steps: Step<AndroidContext>[] = [
    ensureMavenCentralStep,
    addBuildscriptClasspathStep,
    writeBugseePropertiesStep,
    ensureGitignoredStep,
    injectLoaderStep,
    applyPluginStep,
    configureBugseeBlockStep,
    injectManifestPlaceholderStep,
    injectManifestMetaStep,
    injectProviderOverrideStep,
  ];

  const result = await runRollback(steps, ctx);
  return result.failed ? 'failed' : 'ok';
}
