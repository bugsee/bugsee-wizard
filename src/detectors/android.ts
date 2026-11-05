import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { DetectInput, DetectionResult, Detector } from '../core/detect.js';

const APPLICATION_PLUGIN_RE =
  /\b(?:id\s*\(\s*["']com\.android\.application["']\s*\)|id\s+["']com\.android\.application["']|apply\s*\(\s*plugin\s*=\s*["']com\.android\.application["']\s*\)|apply\s+plugin\s*:\s*["']com\.android\.application["'])/;

const APP_GRADLE_CANDIDATES = ['app/build.gradle.kts', 'app/build.gradle'];

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function fileMatches(absPath: string, re: RegExp): Promise<boolean> {
  try {
    const content = await readFile(absPath, 'utf8');
    return re.test(content);
  } catch {
    return false;
  }
}

export const androidDetector: Detector = {
  kind: 'android',
  async detect({ cwd }: DetectInput): Promise<DetectionResult | null> {
    for (const rel of APP_GRADLE_CANDIDATES) {
      const abs = path.join(cwd, rel);
      if (!(await fileExists(abs))) continue;
      if (!(await fileMatches(abs, APPLICATION_PLUGIN_RE))) continue;
      return {
        kind: 'android',
        confidence: 'high',
        evidence: [{ path: rel, note: 'com.android.application plugin' }],
      };
    }
    return null;
  },
};
