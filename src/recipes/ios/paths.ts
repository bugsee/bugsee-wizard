import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import fastGlob from 'fast-glob';

import type { AppDelegateLanguage, IosPaths } from './types.js';
import { XcodeProject } from './xcode-project.js';

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function findXcodeProject(cwd: string): Promise<string | null> {
  // cwd-level `*.xcodeproj` only. The RN recipe overlays cwd to
  // `<rn-root>/ios/` before calling discoverIosPaths, so this stays
  // strict and doesn't need to know about RN's nested layout.
  if (!(await fileExists(cwd))) return null;
  const entries = await readdir(cwd);
  const candidates: string[] = [];
  for (const name of entries.sort()) {
    if (!name.endsWith('.xcodeproj')) continue;
    // A bundle without project.pbxproj is not a usable project.
    if (!(await fileExists(path.join(cwd, name, 'project.pbxproj')))) continue;
    candidates.push(path.join(cwd, name));
  }
  if (candidates.length > 1) {
    throw new Error(
      `Found more than one .xcodeproj in ${cwd}: ${candidates
        .map((c) => path.basename(c))
        .join(', ')}. Re-run from a directory that contains only the app's project.`,
    );
  }
  return candidates[0] ?? null;
}

/**
 * Target name for pbxproj / Podfile lookups: the `BlueprintName` of the
 * scheme's app BuildableReference (preferring a `.app` product, else the
 * first), or null when the scheme cannot be read.
 */
async function readSchemeTargetName(schemePath: string): Promise<string | null> {
  let xml: string;
  try {
    xml = await readFile(schemePath, 'utf8');
  } catch {
    return null;
  }
  const buildAction = /<BuildAction\b[\s\S]*?<\/BuildAction>/.exec(xml)?.[0];
  if (!buildAction) return null;
  const refs = [...buildAction.matchAll(/<BuildableReference\b([\s\S]*?)>/g)].map(
    (m) => m[1] ?? '',
  );
  const attr = (a: string, name: string) =>
    new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(a)?.[1] ?? null;
  const app = refs.find((r) => attr(r, 'BuildableName')?.endsWith('.app'));
  return attr(app ?? refs[0] ?? '', 'BlueprintName') || null;
}

async function listSharedSchemes(xcodeProject: string): Promise<string[]> {
  const dir = path.join(xcodeProject, 'xcshareddata', 'xcschemes');
  if (!(await fileExists(dir))) return [];
  const entries = await readdir(dir);
  return entries.filter((e) => e.endsWith('.xcscheme')).map((e) => path.join(dir, e));
}

/**
 * Pick the "main" shared scheme:
 *  - if exactly one, return it;
 *  - if a scheme matches the .xcodeproj name, prefer that;
 *  - otherwise return the first one as a heuristic. Caller can still surface
 *    a warning to the user when ambiguous.
 */
function pickMainScheme(schemes: string[], xcodeProjectName: string): string | null {
  if (schemes.length === 0) return null;
  if (schemes.length === 1) {
    const only = schemes[0];
    return only === undefined ? null : only;
  }
  const exact = schemes.find((s) => path.basename(s, '.xcscheme') === xcodeProjectName);
  if (exact) return exact;
  const fallback = schemes[0];
  return fallback === undefined ? null : fallback;
}

const APPDELEGATE_GLOBS = ['**/AppDelegate.swift', '**/AppDelegate.m', '**/AppDelegate.mm'];

async function findAppDelegate(
  cwd: string,
  targetSources: readonly string[] | null,
): Promise<{ path: string; language: AppDelegateLanguage } | null> {
  // Scan the cwd and the typical RN `ios/` subdir. Skip vendored folders so
  // we don't match Pods/, node_modules/, build artefacts, etc.
  let matches = await fastGlob(APPDELEGATE_GLOBS, {
    cwd,
    absolute: true,
    followSymbolicLinks: false,
    ignore: ['**/node_modules/**', '**/Pods/**', '**/build/**', '**/DerivedData/**'],
  });
  // When the pbxproj gives the target's source list, only an AppDelegate in
  // it is eligible; if the list has none (e.g. a SwiftUI `@main App` target
  // next to another target that has an AppDelegate) there is no AppDelegate
  // for this target and the caller prints the snippet instead. Only a null
  // list (no explicit sources, e.g. synchronized folders) falls back to the
  // heuristic below.
  if (targetSources) {
    const members = new Set(targetSources.map((p) => path.resolve(p)));
    matches = matches.filter((m) => members.has(path.resolve(m)));
  }
  if (matches.length === 0) return null;
  // Prefer a non-test location: paths without `Tests/` segment.
  const sorted = matches.sort((a, b) => {
    const aTest = /\/Tests?\//.test(a) ? 1 : 0;
    const bTest = /\/Tests?\//.test(b) ? 1 : 0;
    return aTest - bTest;
  });
  const first = sorted[0];
  if (!first) return null;
  const language: AppDelegateLanguage = first.endsWith('.swift') ? 'swift' : 'objc';
  return { path: first, language };
}

async function findPodfile(cwd: string, xcodeProject: string): Promise<string | null> {
  for (const candidate of [
    path.join(cwd, 'Podfile'),
    path.join(path.dirname(xcodeProject), 'Podfile'),
  ]) {
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

export interface DiscoverIosPathsOptions {
  /**
   * Tolerate a project with no shared scheme (used by rollback, which must
   * still clean the Podfile / pbxproj / AppDelegate). The scheme path then
   * points at a non-existent file so the scheme step's rollback is a no-op.
   */
  readonly allowMissingScheme?: boolean;
}

/**
 * Pick the target name: the scheme's BlueprintName, unless the pbxproj is
 * readable, has no such native target, and does have one named like the
 * scheme (older behaviour) — then that one.
 */
async function resolveTargetName(
  xcodeProject: string,
  scheme: string,
  schemeName: string,
): Promise<string> {
  const blueprint = await readSchemeTargetName(scheme);
  if (!blueprint || blueprint === schemeName) return schemeName;
  try {
    const proj = new XcodeProject(xcodeProject);
    if (!proj.findNativeTarget(blueprint) && proj.findNativeTarget(schemeName)) return schemeName;
  } catch {
    // unreadable pbxproj: trust the scheme
  }
  return blueprint;
}

/** Resolve the AppDelegate for a given target (used again after a scheme re-pick). */
export function resolveTargetSources(xcodeProject: string, targetName: string): string[] | null {
  try {
    return new XcodeProject(xcodeProject).targetSourceFiles(targetName);
  } catch {
    return null;
  }
}

export async function discoverIosPaths(
  cwd: string,
  options: DiscoverIosPathsOptions = {},
): Promise<IosPaths> {
  const xcodeProject = await findXcodeProject(cwd);
  if (!xcodeProject) {
    throw new Error(`Could not find an .xcodeproj under ${cwd} (or its ios/ subdirectory).`);
  }
  const xcodeProjectName = path.basename(xcodeProject, '.xcodeproj');

  const schemes = await listSharedSchemes(xcodeProject);
  let scheme = pickMainScheme(schemes, xcodeProjectName);
  if (!scheme) {
    if (!options.allowMissingScheme) {
      throw new Error(
        `No shared scheme found under ${xcodeProject}/xcshareddata/xcschemes. Open Xcode → Manage Schemes and check "Shared" for your app's scheme, then re-run.`,
      );
    }
    scheme = path.join(xcodeProject, 'xcshareddata', 'xcschemes', `${xcodeProjectName}.xcscheme`);
  }
  const schemeName = path.basename(scheme, '.xcscheme');
  const targetName = await resolveTargetName(xcodeProject, scheme, schemeName);

  const appDelegate = await findAppDelegate(cwd, resolveTargetSources(xcodeProject, targetName));
  const podfile = await findPodfile(cwd, xcodeProject);

  return {
    xcodeProject,
    xcodeProjectName,
    podfile,
    scheme,
    schemeName,
    targetName,
    availableSchemes: schemes,
    appDelegate: appDelegate?.path ?? null,
    appDelegateLanguage: appDelegate?.language ?? null,
  };
}

/**
 * Re-derive the scheme-dependent fields after the user picked a different
 * scheme than the heuristic default.
 */
export async function withScheme(paths: IosPaths, scheme: string): Promise<IosPaths> {
  const schemeName = path.basename(scheme, '.xcscheme');
  const targetName = await resolveTargetName(paths.xcodeProject, scheme, schemeName);
  const appDelegate = await findAppDelegate(
    path.dirname(paths.xcodeProject), // the project sits at cwd level
    resolveTargetSources(paths.xcodeProject, targetName),
  );
  return {
    ...paths,
    scheme,
    schemeName,
    targetName,
    appDelegate: appDelegate?.path ?? paths.appDelegate,
    appDelegateLanguage: appDelegate?.language ?? paths.appDelegateLanguage,
  };
}
