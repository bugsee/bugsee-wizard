import * as clack from '@clack/prompts';

import type { WizardOptions } from '../core/context.js';
import { runDetectors } from '../core/detect.js';
import { createLogger } from '../core/logger.js';
import type { RecipeResult } from '../core/result.js';
import { registerAllDetectors } from '../detectors/index.js';
import {
  CancelledError,
  createOutput,
  exitCodeFor,
  MissingInputError,
  type WizardRunResult,
} from '../engine/noninteractive.js';
import { PROJECT_KIND_LABELS, type ProjectKind } from '../project-kind.js';
import { runAndroidRecipe } from '../recipes/android/run.js';
import { runIosRecipe } from '../recipes/ios/run.js';
import { runReactNativeRecipe } from '../recipes/react-native/run.js';
import { runJavaScriptInstall } from '../web/run.js';

export async function runInstall(opts: WizardOptions): Promise<void> {
  registerAllDetectors();
  if (opts.json || opts.nonInteractive) {
    await runInstallNonInteractive(opts);
    return;
  }

  const log = createLogger({ debug: opts.debug });
  clack.intro('Bugsee wizard');

  const detected = await runDetectors({ cwd: opts.cwd });

  const onlyConfident =
    detected.length === 1 && detected[0]?.confidence === 'high' ? detected[0] : undefined;

  let chosen: ProjectKind;
  if (onlyConfident) {
    const confirmed = await clack.confirm({
      message: `Detected ${PROJECT_KIND_LABELS[onlyConfident.kind]}. Continue?`,
      initialValue: true,
    });
    if (clack.isCancel(confirmed) || !confirmed) {
      clack.cancel('Cancelled.');
      return;
    }
    chosen = onlyConfident.kind;
  } else {
    const pick = await clack.select<ProjectKind>({
      message: 'What kind of project is this?',
      options: (Object.entries(PROJECT_KIND_LABELS) as [ProjectKind, string][]).map(
        ([value, label]) => ({ value, label }),
      ),
    });
    if (clack.isCancel(pick)) {
      clack.cancel('Cancelled.');
      return;
    }
    chosen = pick;
  }

  log.info(`Selected: ${PROJECT_KIND_LABELS[chosen]}`);

  let result: RecipeResult;
  switch (chosen) {
    case 'android':
      result = await runAndroidRecipe(opts);
      break;
    case 'ios':
      result = await runIosRecipe(opts);
      break;
    case 'react-native':
      result = await runReactNativeRecipe(opts);
      break;
    case 'javascript':
      await finishJavaScript(opts);
      return;
    case 'flutter':
    case 'unknown':
      clack.note(`Recipe for ${PROJECT_KIND_LABELS[chosen]} is not implemented yet.`, 'Next');
      clack.outro('Nothing was installed.');
      return;
  }

  if (result === 'ok') {
    clack.outro('Done.');
  } else if (result === 'failed') {
    // Non-zero so scripted/CI callers can tell Bugsee was not installed.
    clack.outro('Bugsee was not installed — see the errors above.');
    process.exitCode = 1;
  }
  // 'cancelled': the recipe already printed "Cancelled." — exit 0, no outro.
}

async function finishJavaScript(opts: WizardOptions): Promise<void> {
  let result: WizardRunResult;
  try {
    result = await runJavaScriptInstall(opts);
  } catch (err) {
    if (!(err instanceof CancelledError)) throw err;
    clack.cancel('Cancelled.');
    return;
  }
  if (!result.ok) {
    clack.outro('Bugsee was not installed — see the errors above.');
    process.exitCode = 1;
  } else if (result.incomplete) {
    clack.note('Some changes need a manual step: see the snippets above.', 'Manual steps');
    clack.outro('Done, with manual steps left for you.');
  } else {
    clack.outro('Done.');
  }
}

/**
 * `--json` / `--non-interactive`: no prompts, no intro/outro. It needs exactly one detected
 * project kind, and only JavaScript can run without prompts. `--json` implies non-interactive.
 */
async function runInstallNonInteractive(opts: WizardOptions): Promise<void> {
  const output = createOutput({ json: opts.json, debug: opts.debug });
  const detected = await runDetectors({ cwd: opts.cwd });
  const only = detected.length === 1 ? detected[0] : undefined;
  if (only === undefined) throw new MissingInputError('kind');
  let result: WizardRunResult;
  if (only.kind === 'javascript') {
    result = await runJavaScriptInstall({ ...opts, nonInteractive: true }, { output });
  } else {
    const message = `${PROJECT_KIND_LABELS[only.kind]} setup is interactive only; run the wizard without --non-interactive / --json.`;
    output.log.error(message);
    result = {
      ok: false,
      incomplete: false,
      steps: [],
      error: 'unsupported-non-interactive',
      field: only.kind,
      message,
    };
  }
  output.result(result);
  process.exitCode = exitCodeFor(result, true);
}
