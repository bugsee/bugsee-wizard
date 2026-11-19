import type { Step } from '../../core/step.js';
import type { OpSpec, RecipeContext } from '../recipe.js';
import { addBundlerPluginStep } from './add-bundler-plugin.js';
import { addPackageScriptStep } from './add-package-script.js';
import { addSdkInitStep } from './add-sdk-init.js';
import { ensureGitignoreStep } from './ensure-gitignore.js';
import { installPackageStep } from './install-package.js';
import { setJsonKeyStep } from './set-json-key.js';
import { writeEnvVarStep } from './write-env-var.js';
import { writeFileStep } from './write-file.js';

/** One Step per operation; the operation set is closed. */
export function opToStep(spec: OpSpec): Step<RecipeContext> {
  switch (spec.op) {
    case 'install-package':
      return installPackageStep(spec);
    case 'add-bundler-plugin':
      return addBundlerPluginStep(spec);
    case 'add-sdk-init':
      return addSdkInitStep(spec);
    case 'set-json-key':
      return setJsonKeyStep(spec);
    case 'add-package-script':
      return addPackageScriptStep(spec);
    case 'ensure-gitignore':
      return ensureGitignoreStep(spec);
    case 'write-env-var':
      return writeEnvVarStep(spec);
    case 'write-file':
      return writeFileStep(spec);
    default: {
      const unknown: never = spec;
      throw new Error(`Unknown operation: ${JSON.stringify(unknown)}`);
    }
  }
}
