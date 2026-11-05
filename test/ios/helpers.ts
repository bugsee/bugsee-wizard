import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { WizardContext } from '../../src/core/context.js';
import { createLogger } from '../../src/core/logger.js';
import type {
  AppDelegateLanguage,
  IosContext,
  IosOptions,
  IosPaths,
} from '../../src/recipes/ios/types.js';

export async function makeFixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bugsee-wizard-ios-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

export async function readFixture(dir: string, rel: string): Promise<string> {
  return readFile(path.join(dir, rel), 'utf8');
}

export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

interface MakeIosContextOpts {
  cwd: string;
  schemeName: string;
  targetName?: string;
  xcodeProjectName?: string;
  podfilePath?: string | null;
  appDelegate?: { path: string; language: AppDelegateLanguage } | null;
  iosOptions?: Partial<IosOptions>;
  tokens?: Readonly<Record<string, string>>;
  dryRun?: boolean;
}

export function makeIosContext(opts: MakeIosContextOpts): IosContext {
  const projectName = opts.xcodeProjectName ?? opts.schemeName;
  const xcodeProject = path.join(opts.cwd, `${projectName}.xcodeproj`);
  const scheme = path.join(
    xcodeProject,
    'xcshareddata',
    'xcschemes',
    `${opts.schemeName}.xcscheme`,
  );
  const paths: IosPaths = {
    xcodeProject,
    xcodeProjectName: projectName,
    podfile: opts.podfilePath ?? null,
    scheme,
    schemeName: opts.schemeName,
    targetName: opts.targetName ?? opts.schemeName,
    availableSchemes: [scheme],
    appDelegate: opts.appDelegate?.path ?? null,
    appDelegateLanguage: opts.appDelegate?.language ?? null,
  };
  const iosOptions: IosOptions = {
    distribution: 'cocoapods',
    sizeAnalysis: false,
    sizeAnalysisAllConfigurations: false,
    autoInjectAppDelegate: false,
    runPodInstall: false,
    ...opts.iosOptions,
  };
  const base: WizardContext = {
    cwd: opts.cwd,
    debug: false,
    dryRun: opts.dryRun ?? false,
    kind: 'ios',
    tokens: opts.tokens ?? { ios: 'TEST_TOKEN' },
    log: createLogger({ debug: false }),
  };
  return { ...base, kind: 'ios', iosOptions, iosPaths: paths };
}

// ───────────────────────── Sample fixtures ──────────────────────────

export const SAMPLE_RN_PODFILE = `require_relative '../node_modules/react-native/scripts/react_native_pods'
require_relative '../node_modules/@react-native-community/cli-platform-ios/native_modules'

platform :ios, '14.0'
prepare_react_native_project!

target 'AwesomeProject' do
  config = use_native_modules!

  use_react_native!(
    :path => config[:reactNativePath],
    :hermes_enabled => true
  )

  target 'AwesomeProjectTests' do
    inherit! :complete
  end
end
`;

export const SAMPLE_SIMPLE_PODFILE = `platform :ios, '13.0'

target 'MyApp' do
  use_frameworks!
  pod 'SomeOtherPod'
end
`;

export const SAMPLE_XCSCHEME = `<?xml version="1.0" encoding="UTF-8"?>
<Scheme
   LastUpgradeVersion = "1430"
   version = "1.7">
   <BuildAction
      parallelizeBuildables = "YES"
      buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry
            buildForTesting = "YES"
            buildForRunning = "YES"
            buildForProfiling = "YES"
            buildForArchiving = "YES"
            buildForAnalyzing = "YES">
            <BuildableReference
               BuildableIdentifier = "primary"
               BlueprintIdentifier = "AAAA1111BBBB2222CCCC3333"
               BuildableName = "MyApp.app"
               BlueprintName = "MyApp"
               ReferencedContainer = "container:MyApp.xcodeproj">
            </BuildableReference>
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <ArchiveAction
      buildConfiguration = "Release"
      revealArchiveInOrganizer = "YES">
   </ArchiveAction>
</Scheme>
`;

// Same scheme but with `<ArchiveAction />` self-closed — Xcode emits this
// when the action has no children. Wizard must handle both shapes.
export const SAMPLE_XCSCHEME_SELFCLOSING_ARCHIVE = `<?xml version="1.0" encoding="UTF-8"?>
<Scheme
   LastUpgradeVersion = "1430"
   version = "1.7">
   <BuildAction
      parallelizeBuildables = "YES"
      buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry
            buildForTesting = "YES"
            buildForRunning = "YES"
            buildForProfiling = "YES"
            buildForArchiving = "YES"
            buildForAnalyzing = "YES">
            <BuildableReference
               BuildableIdentifier = "primary"
               BlueprintIdentifier = "AAAA1111BBBB2222CCCC3333"
               BuildableName = "MyApp.app"
               BlueprintName = "MyApp"
               ReferencedContainer = "container:MyApp.xcodeproj">
            </BuildableReference>
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <ArchiveAction
      buildConfiguration = "Release"
      revealArchiveInOrganizer = "YES" />
</Scheme>
`;

// Scheme with a pre-existing user PostAction that is NOT ours. The wizard's
// removePostAction must not touch this on rollback.
export const SAMPLE_XCSCHEME_WITH_USER_POSTACTION = `<?xml version="1.0" encoding="UTF-8"?>
<Scheme
   LastUpgradeVersion = "1430"
   version = "1.7">
   <BuildAction
      parallelizeBuildables = "YES"
      buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry
            buildForTesting = "YES"
            buildForRunning = "YES"
            buildForProfiling = "YES"
            buildForArchiving = "YES"
            buildForAnalyzing = "YES">
            <BuildableReference
               BuildableIdentifier = "primary"
               BlueprintIdentifier = "AAAA1111BBBB2222CCCC3333"
               BuildableName = "MyApp.app"
               BlueprintName = "MyApp"
               ReferencedContainer = "container:MyApp.xcodeproj">
            </BuildableReference>
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <ArchiveAction
      buildConfiguration = "Release"
      revealArchiveInOrganizer = "YES">
      <PostActions>
         <ExecutionAction
            ActionType = "Xcode.IDEStandardExecutionActionsCore.ExecutionActionType.ShellScriptAction">
            <ActionContent
               title = "User Custom Script"
               scriptText = "echo &quot;hello&quot;"
               shellToInvoke = "/bin/sh">
            </ActionContent>
         </ExecutionAction>
      </PostActions>
   </ArchiveAction>
</Scheme>
`;

export const SAMPLE_APP_DELEGATE_SWIFT = `import UIKit

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }
}
`;

export const SAMPLE_APP_DELEGATE_OBJC = `#import "AppDelegate.h"

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
    return YES;
}

@end
`;
