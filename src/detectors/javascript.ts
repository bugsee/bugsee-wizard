import type { DetectInput, DetectionResult, Detector } from '../core/detect.js';
import { inspectJavaScript } from '../web/detect.js';

/**
 * JavaScript / TypeScript projects (browser, Node, Bun, Deno, Electron, edge, ...).
 * Mutually exclusive with the React Native detector: a `react-native` dependency makes
 * `inspectJavaScript` return null, leaving the project to the RN recipe.
 */
export const javascriptDetector: Detector = {
  kind: 'javascript',
  async detect({ cwd }: DetectInput): Promise<DetectionResult | null> {
    const found = await inspectJavaScript(cwd);
    if (!found) return null;
    const { detection, evidence } = found;
    // A project found by walking up from a subdirectory is never "high": it must not outrank a
    // native detector (or an explicit choice) just because a parent directory has a package.json.
    const walkedUp = detection.startedIn !== undefined;
    if (walkedUp) {
      evidence.push({
        path: detection.packageDir,
        note: 'project found above the current directory',
      });
    }
    const identified = detection.framework !== undefined || detection.buildTool !== 'cli';
    return {
      kind: 'javascript',
      confidence: identified && !detection.needsPackageChoice && !walkedUp ? 'high' : 'medium',
      evidence,
    };
  },
};
