import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import fastGlob from 'fast-glob';

import type { AppDelegateLanguage, IosPaths } from './types.js';

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
  for (const name of entries) {
    if (name.endsWith('.xcodeproj')) return path.join(cwd, name);
  }
  return null;
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
): Promise<{ path: string; language: AppDelegateLanguage } | null> {
  // Scan the cwd and the typical RN `ios/` subdir. Skip vendored folders so
  // we don't match Pods/, node_modules/, build artefacts, etc.
  const matches = await fastGlob(APPDELEGATE_GLOBS, {
    cwd,
    absolute: true,
    followSymbolicLinks: false,
    ignore: ['**/node_modules/**', '**/Pods/**', '**/build/**', '**/DerivedData/**'],
  });
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

export async function discoverIosPaths(cwd: string): Promise<IosPaths> {
  const xcodeProject = await findXcodeProject(cwd);
  if (!xcodeProject) {
    throw new Error(`Could not find an .xcodeproj under ${cwd} (or its ios/ subdirectory).`);
  }
  const xcodeProjectName = path.basename(xcodeProject, '.xcodeproj');

  const schemes = await listSharedSchemes(xcodeProject);
  const scheme = pickMainScheme(schemes, xcodeProjectName);
  if (!scheme) {
    throw new Error(
      `No shared scheme found under ${xcodeProject}/xcshareddata/xcschemes. Open Xcode → Manage Schemes and check "Shared" for your app's scheme, then re-run.`,
    );
  }
  const schemeName = path.basename(scheme, '.xcscheme');

  const appDelegate = await findAppDelegate(cwd);
  const podfile = await findPodfile(cwd, xcodeProject);

  return {
    xcodeProject,
    xcodeProjectName,
    podfile,
    scheme,
    schemeName,
    availableSchemes: schemes,
    appDelegate: appDelegate?.path ?? null,
    appDelegateLanguage: appDelegate?.language ?? null,
  };
}
