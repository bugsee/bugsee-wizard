import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { RnNativeVersions } from './types.js';

const FILE = path.join('node_modules', '@bugsee', 'react-native', 'native-versions.json');
const MAX_PARENTS = 8;

function pick(value: unknown, ...keys: string[]): string | null {
  let v: unknown = value;
  for (const k of keys)
    v = typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[k] : undefined;
  return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * The native pins of the installed `@bugsee/react-native` (its `native-versions.json`), looked up
 * from the app directory through its parents (a monorepo hoists node_modules). Null when the
 * package is not installed or the file is not what we expect.
 */
export async function readInstalledNativeVersions(
  rnRoot: string,
): Promise<RnNativeVersions | null> {
  let dir = path.resolve(rnRoot);
  for (let i = 0; i <= MAX_PARENTS; i++) {
    try {
      const json = JSON.parse(await readFile(path.join(dir, FILE), 'utf8')) as unknown;
      const androidSdk = pick(json, 'android', 'sdk');
      const androidGradlePlugin = pick(json, 'android', 'gradlePlugin');
      const iosSdk = pick(json, 'ios', 'sdk');
      return androidSdk && androidGradlePlugin && iosSdk
        ? { androidSdk, androidGradlePlugin, iosSdk }
        : null;
    } catch {
      // not here: try the parent
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
