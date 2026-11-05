import type { WizardContext } from '../../core/context.js';

export type IosDistributionMethod = 'cocoapods' | 'spm';
export type AppDelegateLanguage = 'swift' | 'objc';

export interface IosOptions {
  readonly distribution: IosDistributionMethod;
  readonly sizeAnalysis: boolean;
  readonly sizeAnalysisAllConfigurations: boolean;
  readonly autoInjectAppDelegate: boolean;
  readonly runPodInstall: boolean;
}

export interface IosPaths {
  /** Absolute path to the *.xcodeproj directory. */
  readonly xcodeProject: string;
  /** Project name (the .xcodeproj basename without extension). */
  readonly xcodeProjectName: string;
  /** Absolute path to Podfile if present, otherwise null. */
  readonly podfile: string | null;
  /** Absolute path to the chosen shared scheme file (.xcscheme). */
  readonly scheme: string;
  /** Scheme name (the .xcscheme basename without extension). */
  readonly schemeName: string;
  /**
   * Native target name used for Podfile / pbxproj lookups: the scheme's
   * BuildableReference `BlueprintName`, falling back to `schemeName` when the
   * scheme does not expose one. Scheme-file operations keep using `schemeName`.
   */
  readonly targetName: string;
  /**
   * All shared schemes discovered for this project. The recipe presents a
   * picker when more than one is available so apps with App + WatchApp +
   * Extension targets don't silently get configured for the wrong one.
   */
  readonly availableSchemes: readonly string[];
  /** Absolute path to the AppDelegate file we'll inject into, if found. */
  readonly appDelegate: string | null;
  /** Language of the located AppDelegate, if any. */
  readonly appDelegateLanguage: AppDelegateLanguage | null;
}

export interface IosContext extends WizardContext {
  readonly kind: 'ios';
  readonly iosOptions: IosOptions;
  readonly iosPaths: IosPaths;
}

// Public coordinates for the Bugsee iOS SDK.
export const BUGSEE_POD_NAME = 'Bugsee';
export const BUGSEE_SPM_URL = 'https://github.com/bugsee/spm';
export const BUGSEE_SPM_PRODUCT = 'Bugsee';

// Marker comments / titles used to identify Bugsee-managed edits, so each
// step can detect "already applied" and rollback can strip cleanly.
export const PODFILE_MARKER_BEGIN = '# bugsee:wizard:pod:begin';
export const PODFILE_MARKER_END = '# bugsee:wizard:pod:end';
export const POSTACTION_TITLE = 'Bugsee Symbolication';
export const IMPORT_MARKER_BEGIN = '// bugsee:wizard:import:begin';
export const IMPORT_MARKER_END = '// bugsee:wizard:import:end';
export const LAUNCH_MARKER_BEGIN = '// bugsee:wizard:launch:begin';
export const LAUNCH_MARKER_END = '// bugsee:wizard:launch:end';
