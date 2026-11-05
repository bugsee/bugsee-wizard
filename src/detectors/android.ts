import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { DetectInput, DetectionResult, Detector } from '../core/detect.js';

const APPLICATION_PLUGIN_RE =
  /\b(?:id\s*\(\s*["']com\.android\.application["']\s*\)|id\s+["']com\.android\.application["']|apply\s*\(\s*plugin\s*=\s*["']com\.android\.application["']\s*\)|apply\s+plugin\s*:\s*["']com\.android\.application["'])/;

// Version-catalog aliases: Kotlin `alias(libs.plugins.x.y)`, Groovy
// `alias libs.plugins.x.y` (the catalog may be named other than `libs`).
const ALIAS_RE = /\balias\s*(?:\(\s*)?\w+\.plugins\.([\w.-]+)/g;
const APP_PLUGIN_ID = 'com.android.application';
const VERSION_CATALOG = 'gradle/libs.versions.toml';

const APP_GRADLE_CANDIDATES = ['app/build.gradle.kts', 'app/build.gradle'];

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readText(absPath: string): Promise<string | null> {
  try {
    return await readFile(absPath, 'utf8');
  } catch {
    return null;
  }
}

/** Gradle exposes catalog key `android-application` as `android.application`. */
function normalizeAlias(name: string): string {
  return name.replace(/[-_]/g, '.');
}

/**
 * Accessor names of `[plugins]` entries in a version catalog that resolve to
 * `com.android.application`. Handles `n = { id = "…", version.ref = "…" }`
 * and the string form `n = "com.android.application:<version>"`. Also
 * returns every declared name so callers can tell "resolved to something
 * else" apart from "not in the catalog".
 */
function parseCatalogPlugins(toml: string): { app: Set<string>; known: Set<string> } {
  const app = new Set<string>();
  const known = new Set<string>();
  let inPlugins = false;
  for (const raw of toml.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inPlugins = line.replace(/\s/g, '') === '[plugins]';
      continue;
    }
    if (!inPlugins) continue;
    const m = /^([\w.-]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = normalizeAlias(m[1] as string);
    const value = m[2] as string;
    known.add(name);
    const idForm = /\bid\s*=\s*["']([^"']+)["']/.exec(value);
    const strForm = /^["']([^"':]+)(?::[^"']*)?["']/.exec(value);
    if ((idForm ? idForm[1] : strForm?.[1]) === APP_PLUGIN_ID) app.add(name);
  }
  return { app, known };
}

async function usesApplicationAlias(content: string, cwd: string): Promise<boolean> {
  const aliases = [...content.matchAll(ALIAS_RE)].map((m) => normalizeAlias(m[1] as string));
  if (aliases.length === 0) return false;
  let catalog: ReturnType<typeof parseCatalogPlugins> | null = null;
  try {
    catalog = parseCatalogPlugins(await readFile(path.join(cwd, VERSION_CATALOG), 'utf8'));
  } catch {
    // no catalog: fall through to the name heuristic
  }
  return aliases.some((a) => {
    if (catalog?.app.has(a)) return true;
    if (catalog?.known.has(a)) return false;
    // Heuristic ONLY for an alias we cannot resolve (no catalog, or the
    // entry lives elsewhere): a name like `android.application` /
    // `androidApplication` / `android-application` is overwhelmingly the AGP
    // application plugin.
    return a.toLowerCase().replace(/\./g, '').includes('androidapplication');
  });
}

async function isApplicationScript(absPath: string, cwd: string): Promise<boolean> {
  const content = await readText(absPath);
  if (content === null) return false;
  return APPLICATION_PLUGIN_RE.test(content) || (await usesApplicationAlias(content, cwd));
}

export const androidDetector: Detector = {
  kind: 'android',
  async detect({ cwd }: DetectInput): Promise<DetectionResult | null> {
    for (const rel of APP_GRADLE_CANDIDATES) {
      const abs = path.join(cwd, rel);
      if (!(await fileExists(abs))) continue;
      if (!(await isApplicationScript(abs, cwd))) continue;
      return {
        kind: 'android',
        confidence: 'high',
        evidence: [{ path: rel, note: 'com.android.application plugin' }],
      };
    }
    return null;
  },
};
