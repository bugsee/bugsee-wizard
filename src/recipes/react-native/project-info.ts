import { readFile } from 'node:fs/promises';
import path from 'node:path';

import semver from 'semver';

import { LEGACY_RN_PACKAGE_NAME } from './types.js';

/** `@bugsee/react-native` needs React Native 0.81 or later (with the New Architecture and Hermes). */
export const MIN_REACT_NATIVE = '0.81.0';
/** From this React Native version on, the wrapper's iOS SDK is resolved through SPM, not a pod. */
const SPM_REACT_NATIVE = '0.87.0';

export interface RnProjectInfo {
  /** The old `react-native-bugsee` is a dependency: the packages are not an in-place upgrade. */
  readonly legacyPackage: boolean;
  /** `@bugsee/react-native` is already a dependency. */
  readonly hasWrapper: boolean;
  /** `expo` is a dependency (the config may live in app.config.js/ts, which the wizard cannot edit). */
  readonly hasExpo: boolean;
  /** The React Native version: the installed one when known, else the lowest the range allows. */
  readonly reactNativeVersion: string | null;
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as unknown;
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function readRnProjectInfo(rnRoot: string): Promise<RnProjectInfo> {
  const pkg = await readJson(path.join(rnRoot, 'package.json'));
  const deps = {
    ...(pkg?.devDependencies as Record<string, unknown> | undefined),
    ...(pkg?.dependencies as Record<string, unknown> | undefined),
  };
  const installed = await readJson(
    path.join(rnRoot, 'node_modules', 'react-native', 'package.json'),
  );
  const installedVersion =
    typeof installed?.version === 'string' ? semver.valid(installed.version) : null;
  const range = deps['react-native'];
  const fromRange =
    typeof range === 'string' && semver.validRange(range) !== null
      ? (semver.minVersion(range)?.version ?? null)
      : null;
  return {
    legacyPackage: LEGACY_RN_PACKAGE_NAME in deps,
    hasWrapper: '@bugsee/react-native' in deps,
    hasExpo: 'expo' in deps,
    reactNativeVersion: installedVersion ?? fromRange,
  };
}

/** Before React Native 0.87 the iOS SDK comes through the wrapper's pod: `pod install` is needed. */
export function usesPodsForWrapper(reactNativeVersion: string | null): boolean {
  return reactNativeVersion === null || semver.lt(reactNativeVersion, SPM_REACT_NATIVE);
}
