import { relative, resolve } from 'node:path';

import type { WizardOptions } from '../core/context.js';
import { MissingInputError } from '../engine/noninteractive.js';
import type { JsDetection } from './detect.js';
import type { Prompts } from './prompts.js';

export type PackageChoice =
  | { readonly ok: true; readonly dir: string }
  | { readonly ok: false; readonly message: string };

const show = (root: string, dir: string): string =>
  relative(root, dir).split('\\').join('/') || '.';

/**
 * The package a run targets. `--package` (relative to cwd) always wins and must name the detected
 * project or one of its workspace packages. Without it, a workspace root that is not itself an app
 * needs a choice: asked interactively, MissingInputError('package') otherwise.
 */
export async function choosePackage(
  det: JsDetection,
  opts: Pick<WizardOptions, 'cwd' | 'package' | 'nonInteractive'>,
  prompts: Prompts,
): Promise<PackageChoice> {
  const packages = det.workspace?.packages ?? [];
  const root = det.workspace?.root ?? det.packageDir;
  if (opts.package !== undefined) {
    const wanted = resolve(opts.cwd, opts.package);
    const candidates = [det.packageDir, ...packages.map((p) => p.dir)].map((d) => resolve(d));
    if (candidates.includes(wanted)) return { ok: true, dir: wanted };
    const list = packages.map((p) => `  ${show(root, p.dir)}`).join('\n');
    return {
      ok: false,
      message: `--package ${opts.package} is not a package of this project.${
        list === '' ? '' : ` Choose one of:\n${list}`
      }`,
    };
  }
  if (!det.needsPackageChoice) return { ok: true, dir: det.packageDir };
  if (opts.nonInteractive) throw new MissingInputError('package');
  const dir = await prompts.select(
    'Which package should Bugsee be added to?',
    packages.map((p) => ({ value: p.dir, label: `${show(root, p.dir)} (${p.name})` })),
  );
  return { ok: true, dir };
}
