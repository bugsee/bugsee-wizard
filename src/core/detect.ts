import type { ProjectKind } from '../project-kind.js';

export type DetectionConfidence = 'high' | 'medium' | 'low';

export interface DetectionEvidence {
  readonly path: string;
  readonly note?: string;
}

export interface DetectionResult {
  readonly kind: ProjectKind;
  readonly confidence: DetectionConfidence;
  readonly evidence: readonly DetectionEvidence[];
}

export interface DetectInput {
  readonly cwd: string;
}

export interface Detector {
  readonly kind: ProjectKind;
  detect(input: DetectInput): Promise<DetectionResult | null>;
}

const detectors: Detector[] = [];

export function registerDetector(d: Detector): void {
  detectors.push(d);
}

export function getDetectors(): readonly Detector[] {
  return detectors;
}

export async function runDetectors(input: DetectInput): Promise<readonly DetectionResult[]> {
  const results = await Promise.all(detectors.map((d) => d.detect(input)));
  return results.filter((r): r is DetectionResult => r !== null);
}
