import { basename, join } from 'node:path';
import type { ManualSnippet, Step } from '../../core/step.js';
import { hasBugseeMarker } from '../config-ast.js';
import { type EntryFile, findEntry, hasViteClientTypes } from '../entry-detect.js';
import { editTextFile } from '../fs-edit.js';
import { readPackageJson } from '../package-json.js';
import type { OpSpec, RecipeContext } from '../recipe.js';
import {
  addSdkInit,
  hasSdkIntegration,
  type SdkInitSpec,
  sdkInitSnippet,
} from '../sdk-init-ast.js';
import { manifestPath, readBytes, resolveInside, restoreBytes } from './shared.js';

type Spec = Extract<OpSpec, { op: 'add-sdk-init' }>;

const MARKER = 'bugsee-wizard';
/** Shown (and recorded) when no entry file could be found: the user knows which file it is. */
const NO_ENTRY = 'your entry file';

async function packageType(dir: string): Promise<string | undefined> {
  try {
    const type = (await readPackageJson(join(dir, 'package.json'))).data.type;
    return typeof type === 'string' ? type : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Add the SDK import and `launch(...)` to the project's entry file (found by static analysis). The
 * token is never in a title, log line or snippet; with a `tokenExpr` it is not in the code either.
 * An entry that cannot be understood stays untouched and becomes a manual snippet: never a false success.
 */
export function addSdkInitStep(spec: Spec): Step<RecipeContext> {
  let before: Buffer | undefined;
  let editedPath: string | undefined;

  const locate = async (
    ctx: RecipeContext,
  ): Promise<{ entry: EntryFile; path: string } | undefined> => {
    const entry = await findEntry(ctx.packageDir, spec.runtime);
    if (!entry) return undefined;
    return { entry, path: await resolveInside(ctx.packageDir, entry.file) };
  };
  const initSpec = async (ctx: RecipeContext, entry: EntryFile): Promise<SdkInitSpec> => {
    const type = await packageType(ctx.packageDir);
    return {
      importFrom: spec.importFrom,
      token: ctx.token,
      fileName: basename(entry.file),
      runtime: spec.runtime,
      viteClientTypes: await hasViteClientTypes(ctx.packageDir),
      ...(spec.tokenExpr !== undefined ? { tokenExpr: spec.tokenExpr } : {}),
      ...(type !== undefined ? { packageType: type } : {}),
    };
  };

  return {
    id: `add-sdk-init:${spec.runtime}`,
    title: `Initialise the Bugsee SDK in the ${spec.runtime} entry file`,
    async precheck(ctx) {
      if (spec.tokenExpr === undefined && ctx.token === '') {
        return { kind: 'blocked', reason: 'No Bugsee token is available' };
      }
      let found: Awaited<ReturnType<typeof locate>>;
      try {
        found = await locate(ctx);
      } catch (err) {
        return { kind: 'blocked', reason: (err as Error).message };
      }
      if (!found) return { kind: 'pending' }; // apply hands back a manual snippet
      const src = (await readBytes(found.path))?.toString('utf8') ?? '';
      return hasSdkIntegration(src) ? { kind: 'satisfied' } : { kind: 'pending' };
    },
    async apply(ctx) {
      const found = await locate(ctx);
      const manual = (file: string, code: string): { manual: ManualSnippet } => {
        ctx.manifest.record({ file, action: 'manual' });
        const name = file === NO_ENTRY ? NO_ENTRY : basename(file);
        return { manual: { file, title: `Initialise Bugsee in ${name}`, code } };
      };
      if (!found) {
        const probe: SdkInitSpec = {
          importFrom: spec.importFrom,
          token: '',
          fileName: spec.runtime === 'browser' ? 'main.ts' : 'index.ts',
          runtime: spec.runtime,
          ...(spec.tokenExpr !== undefined ? { tokenExpr: spec.tokenExpr } : {}),
        };
        return manual(NO_ENTRY, sdkInitSnippet(probe, false));
      }
      const file = manifestPath(ctx, found.path);
      const prior = await readBytes(found.path);
      const src = prior?.toString('utf8') ?? '';
      const sdk = await initSpec(ctx, found.entry);
      const res = addSdkInit(src, sdk);
      if ('manual' in res) return manual(file, res.manual);
      before = prior ?? undefined;
      editedPath = found.path;
      const edit = await editTextFile(found.path, () => res.code, {
        validate: (out) => hasBugseeMarker(out),
      });
      if (edit.changed) {
        ctx.manifest.record({
          file,
          action: 'edited',
          before: edit.before,
          after: edit.after,
          marker: MARKER,
        });
      }
      return undefined;
    },
    async rollback() {
      if (before === undefined || editedPath === undefined) return;
      await restoreBytes(editedPath, before);
    },
  };
}
