export type { WizardContext, WizardOptions } from './core/context.js';
export type {
  DetectInput,
  DetectionConfidence,
  DetectionEvidence,
  DetectionResult,
  Detector,
} from './core/detect.js';
export { getDetectors, registerDetector, runDetectors } from './core/detect.js';
export type { Logger, LoggerOptions } from './core/logger.js';
export { createLogger } from './core/logger.js';
export type {
  ApplyResult,
  ManualSnippet,
  RunRollbackResult,
  RunStepsResult,
  Step,
  StepOutcome,
  StepResult,
  StepStatus,
} from './core/step.js';
export { runRollback, runSteps } from './core/step.js';
export type { ProjectKind } from './project-kind.js';
export { PROJECT_KIND_LABELS, PROJECT_KINDS } from './project-kind.js';
