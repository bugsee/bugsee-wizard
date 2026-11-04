import * as clack from '@clack/prompts';

import type { WizardOptions } from '../core/context.js';
import { runDetectors } from '../core/detect.js';
import { createLogger } from '../core/logger.js';
import { registerAllDetectors } from '../detectors/index.js';
import { PROJECT_KIND_LABELS, type ProjectKind } from '../project-kind.js';
import { runAndroidRecipe } from '../recipes/android/run.js';
import { runIosRecipe } from '../recipes/ios/run.js';
import { runReactNativeRecipe } from '../recipes/react-native/run.js';

export async function runInstall(opts: WizardOptions): Promise<void> {
  registerAllDetectors();

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

  switch (chosen) {
    case 'android':
      await runAndroidRecipe(opts);
      break;
    case 'ios':
      await runIosRecipe(opts);
      break;
    case 'react-native':
      await runReactNativeRecipe(opts);
      break;
    case 'flutter':
    case 'web':
    case 'unknown':
      clack.note(`Recipe for ${PROJECT_KIND_LABELS[chosen]} is not implemented yet.`, 'Next');
      break;
  }

  clack.outro('Done.');
}
