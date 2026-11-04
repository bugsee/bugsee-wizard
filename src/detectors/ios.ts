import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import type { DetectInput, DetectionResult, Detector } from '../core/detect.js';

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function findXcodeProject(cwd: string): Promise<string | null> {
  // Match cwd-level `*.xcodeproj` only. RN projects are detected at
  // their root (where `package.json` declares react-native) by
  // `reactNativeDetector`; the RN recipe overlays `cwd` to
  // `<root>/ios/` before invoking the iOS recipe, so this lookup
  // doesn't need to know about the RN layout.
  return findIn(cwd);
}

async function findIn(dir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (name.endsWith('.xcodeproj')) return path.join(dir, name);
  }
  return null;
}

export const iosDetector: Detector = {
  kind: 'ios',
  async detect({ cwd }: DetectInput): Promise<DetectionResult | null> {
    const xcodeProject = await findXcodeProject(cwd);
    if (!xcodeProject) return null;
    return {
      kind: 'ios',
      confidence: 'high',
      evidence: [{ path: path.relative(cwd, xcodeProject), note: 'Xcode project' }],
    };
  },
};
