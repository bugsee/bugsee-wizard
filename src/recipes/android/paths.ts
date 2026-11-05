import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { findBlock } from './blocks.js';
import type { AndroidPaths, BuildScriptStyle, GradleDsl } from './types.js';

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function pickDsl(
  cwd: string,
  kotlinRel: string,
  groovyRel: string,
  label: string,
): Promise<{ abs: string; dsl: GradleDsl }> {
  const kotlinAbs = path.join(cwd, kotlinRel);
  const groovyAbs = path.join(cwd, groovyRel);
  if (await fileExists(kotlinAbs)) return { abs: kotlinAbs, dsl: 'kotlin' };
  if (await fileExists(groovyAbs)) return { abs: groovyAbs, dsl: 'groovy' };
  throw new Error(`Could not find ${label} (looked for ${kotlinRel} and ${groovyRel}).`);
}

/**
 * Modern AGP (and Android Studio defaults since Arctic Fox) use the plugin
 * DSL `plugins { id("…") version "…" }`. React Native's Android template
 * and older projects still use legacy `apply plugin: "…"` lines at the top
 * of the script, with the corresponding `classpath(...)` declared in the
 * project-level `build.gradle`'s `buildscript { dependencies }` block.
 *
 * Returns `plugins-dsl` if a `plugins { … }` block exists in the file,
 * otherwise `legacy-apply`. The wizard branches recipe steps on this so
 * RN-flavoured projects don't get a wrong-shape edit.
 */
function detectBuildScriptStyle(content: string): BuildScriptStyle {
  return findBlock(content, 'plugins', { topLevel: true }) ? 'plugins-dsl' : 'legacy-apply';
}

export async function discoverAndroidPaths(cwd: string): Promise<AndroidPaths> {
  const settings = await pickDsl(
    cwd,
    'settings.gradle.kts',
    'settings.gradle',
    'settings.gradle[.kts]',
  );
  const appBuild = await pickDsl(
    cwd,
    'app/build.gradle.kts',
    'app/build.gradle',
    'app/build.gradle[.kts]',
  );
  const appBuildContent = await readFile(appBuild.abs, 'utf8');
  const appBuildScriptStyle = detectBuildScriptStyle(appBuildContent);

  // The project-level script only matters for legacy-apply (the classpath
  // entry lives there). A plugins-DSL project resolves the plugin through
  // settings.gradle, so a missing root build file is tolerated there.
  const projectBuildPick = pickDsl(
    cwd,
    'build.gradle.kts',
    'build.gradle',
    'project-level build.gradle[.kts]',
  );
  const projectBuild =
    appBuildScriptStyle === 'legacy-apply'
      ? await projectBuildPick
      : await projectBuildPick.catch(() => null);

  return {
    settingsGradle: settings.abs,
    settingsGradleDsl: settings.dsl,
    projectBuildGradle: projectBuild?.abs ?? null,
    projectBuildGradleDsl: projectBuild?.dsl ?? null,
    appBuildGradle: appBuild.abs,
    appBuildGradleDsl: appBuild.dsl,
    appBuildScriptStyle,
    appManifest: path.join(cwd, 'app/src/main/AndroidManifest.xml'),
    bugseeProperties: path.join(cwd, 'bugsee.properties'),
    gitignore: path.join(cwd, '.gitignore'),
  };
}
