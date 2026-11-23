import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { Step } from '../../core/step.js';
import {
  addBundlerPlugin,
  bundlerPluginSnippet,
  findConfigFile,
  hasBugseeMarker,
  type PluginTarget,
} from '../config-ast.js';
import { editTextFile } from '../fs-edit.js';
import type { OpSpec, RecipeContext } from '../recipe.js';
import { manifestPath, readBytes, resolveInside, restoreBytes } from './shared.js';

type Spec = Extract<OpSpec, { op: 'add-bundler-plugin' }>;

const MARKER = 'bugsee-wizard';
// any existing source-map setting (even `false`) is the user's to change; we only report when none exists
const SOURCEMAP_SET_RE = /\b(?:sourcemap|sourceMap|devtool)\b/;

const SOURCEMAP_HINT: Record<PluginTarget, string> = {
  vite: 'build: { sourcemap: true }',
  rollup: 'output: { sourcemap: true }',
  webpack: "devtool: 'source-map'",
  rspack: "devtool: 'source-map'",
  esbuild: "sourcemap: 'external'",
};

/** Where the snippet goes when no config file exists (esbuild has none by convention). */
function fallbackFile(target: PluginTarget): string {
  return target === 'esbuild' ? 'your esbuild build script' : `${target}.config.ts`;
}

function fallbackTitle(spec: Spec): string {
  return spec.target === 'esbuild'
    ? 'Add the Bugsee plugin to your esbuild build script'
    : `Add the Bugsee plugin to your ${spec.target} config`;
}

function pluginSnippet(spec: Spec): string {
  if (spec.target === 'esbuild') {
    // no script was found, so its module system is unknown: show both forms (marker comment included)
    return bundlerPluginSnippet('esbuild', spec, 'both');
  }
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

/** The scripts a package.json `scripts` entry runs with node/tsx/bun and the like (relative JS/TS paths only). */
const SCRIPT_FILE_RE =
  /(?:^|[\s"'=])((?:\.{1,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.(?:[cm]?[jt]s))(?=$|[\s"'])/g;

async function packageScriptFiles(packageDir: string): Promise<string[]> {
  let scripts: unknown;
  try {
    scripts = (
      JSON.parse(await readFile(resolve(packageDir, 'package.json'), 'utf8')) as {
        scripts?: unknown;
      }
    ).scripts;
  } catch {
    return [];
  }
  if (typeof scripts !== 'object' || scripts === null) return [];
  const files = new Set<string>();
  for (const cmd of Object.values(scripts)) {
    if (typeof cmd !== 'string') continue;
    for (const m of cmd.matchAll(SCRIPT_FILE_RE)) if (m[1] !== undefined) files.add(m[1]);
  }
  return [...files].slice(0, 20);
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
  // esbuild has no config file: the plugin goes into the user's own build script (esbuild.config.* or whatever
  // package.json runs), so a re-run looks there, and takes the marker comment OR a hand-wired import and call
  const wired = (src: string): boolean =>
    hasBugseeMarker(src) || (src.includes(spec.importFrom) && src.includes(`${spec.importName}(`));
  const precheckEsbuild = async (
    ctx: RecipeContext,
  ): Promise<{ kind: 'pending' | 'satisfied' }> => {
    const candidates: string[] = [];
    const config = await find(ctx);
    if (config) candidates.push(config);
    for (const rel of await packageScriptFiles(ctx.packageDir)) {
      try {
        candidates.push(await resolveInside(ctx.packageDir, rel));
      } catch {
        // outside the project: not ours to read
      }
    }
    for (const path of candidates) {
      let src: string;
      try {
        src = await readFile(path, 'utf8');
      } catch {
        continue; // named in a script but not there
      }
      if (!wired(src)) continue;
      if (spec.ensureSourcemap === true && !SOURCEMAP_SET_RE.test(src)) continue;
      return { kind: 'satisfied' };
    }
    return { kind: 'pending' };
  };
  return {
    id: `add-bundler-plugin:${spec.target}`,
    title: `Add the Bugsee plugin to the ${spec.target} config`,
    async precheck(ctx) {
      if (spec.target === 'esbuild') return precheckEsbuild(ctx);
      const path = await find(ctx);
      if (!path) return { kind: 'pending' }; // apply hands back a manual snippet
      const src = await readFile(path, 'utf8');
      const res = hasBugseeMarker(src) ? undefined : addBundlerPlugin(src, spec.target, plugin);
      const pluginDone = res === undefined || ('code' in res && res.code === src);
      if (!pluginDone) return { kind: 'pending' };
      // the source-map switch is never edited automatically: keep reporting it until it is there
      return spec.ensureSourcemap === true && !SOURCEMAP_SET_RE.test(src)
        ? { kind: 'pending' }
        : { kind: 'satisfied' };
    },
    async apply(ctx) {
      const path = await find(ctx);
      const wantHint = spec.ensureSourcemap === true;
      const hint = wantHint ? sourcemapSnippet(spec) : undefined;
      if (!path) {
        const file = fallbackFile(spec.target);
        ctx.manifest.record({ file, action: 'manual' });
        return {
          manual: {
            file,
            title: fallbackTitle(spec),
            code: [pluginSnippet(spec), hint].filter(Boolean).join('\n\n'),
          },
        };
      }
      const file = manifestPath(ctx, path);
      const src = await readFile(path, 'utf8');
      const hintHere = wantHint && !SOURCEMAP_SET_RE.test(src) ? hint : undefined;
      const res = addBundlerPlugin(src, spec.target, plugin);
      if ('manual' in res) {
        ctx.manifest.record({ file, action: 'manual' });
        return {
          manual: {
            file,
            title: `Add the Bugsee plugin to ${basename(path)}`,
            code: [res.manual, hintHere].filter(Boolean).join('\n\n'),
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
      if (wantHint && !SOURCEMAP_SET_RE.test(edit.after)) {
        return {
          manual: { file, title: `Enable source maps in ${basename(path)}`, code: hint as string },
          // an edit made in this run must still be rolled back if a later step fails
          ...(edit.changed ? { applied: true } : {}),
        };
      }
      return undefined;
    },
    async preview(ctx) {
      // the decision apply makes, on the same text, without writing
      const path = await find(ctx);
      const wantHint = spec.ensureSourcemap === true;
      const hint = wantHint ? sourcemapSnippet(spec) : undefined;
      if (!path) {
        const file = fallbackFile(spec.target);
        return {
          manual: {
            file,
            title: fallbackTitle(spec),
            code: [pluginSnippet(spec), hint].filter(Boolean).join('\n\n'),
          },
        };
      }
      const src = await readFile(path, 'utf8');
      const res = addBundlerPlugin(src, spec.target, plugin);
      const file = manifestPath(ctx, path);
      if ('manual' in res) {
        const hintHere = wantHint && !SOURCEMAP_SET_RE.test(src) ? hint : undefined;
        return {
          manual: {
            file,
            title: `Add the Bugsee plugin to ${basename(path)}`,
            code: [res.manual, hintHere].filter(Boolean).join('\n\n'),
          },
        };
      }
      if (wantHint && !SOURCEMAP_SET_RE.test(res.code)) {
        return {
          manual: { file, title: `Enable source maps in ${basename(path)}`, code: hint as string },
        };
      }
      return undefined;
    },
    async rollback() {
      if (before === undefined || editedPath === undefined) return;
      await restoreBytes(editedPath, before);
    },
  };
}
