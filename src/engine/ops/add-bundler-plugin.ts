import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Step } from '../../core/step.js';
import {
  addBundlerPlugin,
  findConfigFile,
  hasBugseeMarker,
  type PluginTarget,
} from '../config-ast.js';
import { editTextFile } from '../fs-edit.js';
import type { OpSpec, RecipeContext } from '../recipe.js';
import { manifestPath, readBytes, restoreBytes } from './shared.js';

type Spec = Extract<OpSpec, { op: 'add-bundler-plugin' }>;

const MARKER = 'bugsee-wizard';

const SOURCEMAP_HINT: Record<PluginTarget, string> = {
  vite: 'build: { sourcemap: true }',
  rollup: 'output: { sourcemap: true }',
  webpack: "devtool: 'source-map'",
  rspack: "devtool: 'source-map'",
};

function pluginSnippet(spec: Spec): string {
  return [
    `import { ${spec.importName} } from '${spec.importFrom}';`,
    '',
    `// add to the plugins array of your ${spec.target} config:`,
    `${spec.importName}(${spec.callArgs})`,
  ].join('\n');
}

function sourcemapSnippet(spec: Spec): string {
  return `// enable source maps in your ${spec.target} config:\n${SOURCEMAP_HINT[spec.target]}`;
}

export function addBundlerPluginStep(spec: Spec): Step<RecipeContext> {
  let before: Buffer | undefined;
  let editedPath: string | undefined;
  const find = (ctx: RecipeContext): Promise<string | undefined> =>
    findConfigFile(ctx.packageDir, `${spec.target}.config`);
  const plugin = {
    importFrom: spec.importFrom,
    importName: spec.importName,
    callArgs: spec.callArgs,
  };
  return {
    id: `add-bundler-plugin:${spec.target}`,
    title: `Add the Bugsee plugin to the ${spec.target} config`,
    async precheck(ctx) {
      const path = await find(ctx);
      if (!path) return { kind: 'pending' }; // apply hands back a manual snippet
      const src = await readFile(path, 'utf8');
      if (hasBugseeMarker(src)) return { kind: 'satisfied' };
      const res = addBundlerPlugin(src, spec.target, plugin);
      return 'code' in res && res.code === src ? { kind: 'satisfied' } : { kind: 'pending' };
    },
    async apply(ctx) {
      const path = await find(ctx);
      const hint = spec.ensureSourcemap === true ? sourcemapSnippet(spec) : undefined;
      if (!path) {
        const file = `${spec.target}.config.ts`;
        ctx.manifest.record({ file, action: 'manual' });
        return {
          manual: {
            file,
            title: `Add the Bugsee plugin to your ${spec.target} config`,
            code: [pluginSnippet(spec), hint].filter(Boolean).join('\n\n'),
          },
        };
      }
      const file = manifestPath(ctx, path);
      const src = await readFile(path, 'utf8');
      const res = addBundlerPlugin(src, spec.target, plugin);
      if ('manual' in res) {
        ctx.manifest.record({ file, action: 'manual' });
        return {
          manual: {
            file,
            title: `Add the Bugsee plugin to ${basename(path)}`,
            code: [res.manual, hint].filter(Boolean).join('\n\n'),
          },
        };
      }
      before = (await readBytes(path)) ?? undefined;
      editedPath = path;
      const edit = await editTextFile(path, () => res.code, { validate: hasBugseeMarker });
      if (edit.changed) {
        ctx.manifest.record({
          file,
          action: 'edited',
          before: edit.before,
          after: edit.after,
          marker: MARKER,
        });
      }
      // The plugin is in; the source-map switch is the one part the helpers cannot place safely.
      if (hint) {
        return { manual: { file, title: `Enable source maps in ${basename(path)}`, code: hint } };
      }
      return undefined;
    },
    async rollback() {
      if (before === undefined || editedPath === undefined) return;
      await restoreBytes(editedPath, before);
    },
  };
}
