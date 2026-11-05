import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { JsEntry, JsEntryLanguage, RnPlatformPaths } from './types.js';

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

const APP_CANDIDATES: ReadonlyArray<{ name: string; language: JsEntryLanguage }> = [
  { name: 'App.tsx', language: 'tsx' },
  { name: 'App.jsx', language: 'jsx' },
  { name: 'App.ts', language: 'ts' },
  { name: 'App.js', language: 'js' },
];

const INDEX_CANDIDATES: ReadonlyArray<{ name: string; language: JsEntryLanguage }> = [
  { name: 'index.js', language: 'js' },
  { name: 'index.ts', language: 'ts' },
  { name: 'index.tsx', language: 'tsx' },
];

/**
 * Locate the JS file we'll inject the Bugsee launch / init line into.
 *
 * Preference order:
 *   1. `App.tsx` / `App.jsx` / `App.ts` / `App.js` at root  — splice the
 *      launch call into the App component.
 *   2. `index.js` / `index.ts` / `index.tsx` at root — splice near the
 *      top-level (before `AppRegistry.registerComponent`).
 *
 * Returns null when neither shape is present. Callers should fall back
 * to printing the snippet for the user.
 */
export async function discoverJsEntry(rnRoot: string): Promise<JsEntry | null> {
  for (const candidate of APP_CANDIDATES) {
    const abs = path.join(rnRoot, candidate.name);
    if (await fileExists(abs)) {
      return { path: abs, language: candidate.language, kind: 'app-component' };
    }
  }
  for (const candidate of INDEX_CANDIDATES) {
    const abs = path.join(rnRoot, candidate.name);
    if (await fileExists(abs)) {
      return { path: abs, language: candidate.language, kind: 'top-level' };
    }
  }
  return null;
}

/** `app.json` with an `expo` key, in a project that depends on `expo`; null otherwise. */
async function discoverExpoConfig(rnRoot: string, packageJson: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(packageJson, 'utf8')) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    if (!('expo' in { ...pkg.devDependencies, ...pkg.dependencies })) return null;
    const appJson = path.join(rnRoot, 'app.json');
    const app = JSON.parse(await readFile(appJson, 'utf8')) as Record<string, unknown>;
    return typeof app.expo === 'object' && app.expo !== null ? appJson : null;
  } catch {
    return null;
  }
}

export async function discoverRnPaths(rnRoot: string): Promise<RnPlatformPaths> {
  const androidDir = path.join(rnRoot, 'android');
  const iosDir = path.join(rnRoot, 'ios');
  const packageJson = path.join(rnRoot, 'package.json');
  const jsEntry = await discoverJsEntry(rnRoot);
  return {
    androidPath: (await dirExists(androidDir)) ? androidDir : null,
    iosPath: (await dirExists(iosDir)) ? iosDir : null,
    packageJson,
    jsEntry,
    expoConfig: await discoverExpoConfig(rnRoot, packageJson),
  };
}
