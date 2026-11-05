import { SAMPLE_XCSCHEME } from '../ios/helpers.js';

/**
 * A bare React Native app's native files (RN 0.74 / 0.76 templates, trimmed to the shape the
 * wizard edits), for tests that run the whole recipe. Taken from the Android / iOS step tests.
 */

const SETTINGS_074 = `pluginManagement { includeBuild("../node_modules/@react-native/gradle-plugin") }
plugins { id("com.facebook.react.settings") }
extensions.configure(com.facebook.react.ReactSettingsExtension){ ex -> ex.autolinkLibrariesFromCommand() }
rootProject.name = 'AwesomeProject'
include ':app'
includeBuild('../node_modules/@react-native/gradle-plugin')
`;

const ROOT_074 = `// Top-level build file where you can add configuration options common to all sub-projects/modules.

buildscript {
    ext {
        buildToolsVersion = "34.0.0"
        minSdkVersion = 23
    }
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle")
        classpath("com.facebook.react:react-native-gradle-plugin")
    }
}

apply plugin: "com.facebook.react.rootproject"
`;

const APP_074 = `apply plugin: "com.android.application"
apply plugin: "org.jetbrains.kotlin.android"
apply plugin: "com.facebook.react"

/**
 * This is the configuration block to customize your React Native Android app.
 */
react {
    /* Folders */
    //   The root of your project, i.e. where "package.json" lives. Default is '../..'
    // root = file("../../")

    /* Hermes Commands */
    //   The hermes compiler command to run. By default it is 'hermesc'
    // hermesCommand = "$rootDir/my-custom-hermesc/bin/hermesc"
    //
    //   The list of flags to pass to the Hermes compiler. By default is "-O", "-output-source-map"
    // hermesFlags = ["-O", "-output-source-map"]
}

def enableProguardInReleaseBuilds = false
def jscFlavor = 'org.webkit:android-jsc:+'

android {
    namespace "com.awesomeproject"
    defaultConfig {
        applicationId "com.awesomeproject"
    }
    buildTypes {
        release {
            minifyEnabled enableProguardInReleaseBuilds
        }
    }
}

dependencies {
    // The version of react-native is set by the React Native Gradle Plugin
    implementation("com.facebook.react:react-android")

    if (hermesEnabled.toBoolean()) {
        implementation("com.facebook.react:hermes-android")
    } else {
        implementation jscFlavor
    }
}

apply from: file("../../node_modules/@react-native-community/cli-platform-android/native_modules.gradle"); applyNativeModulesAppBuildGradle(project)
`;

// RN 0.76+ template: quoted invocation.
const SCRIPT_076 =
  'set -e\\n\\nWITH_ENVIRONMENT=\\"$REACT_NATIVE_PATH/scripts/xcode/with-environment.sh\\"\\nREACT_NATIVE_XCODE=\\"$REACT_NATIVE_PATH/scripts/react-native-xcode.sh\\"\\n\\n/bin/sh -c \\"\\\\\\"$WITH_ENVIRONMENT\\\\\\" \\\\\\"$REACT_NATIVE_XCODE\\\\\\"\\"\\n';

function pbx(scripts: string[], name = 'Bundle React Native code and images'): string {
  const phases = scripts
    .map(
      (s, i) => `\t\t00DD1BFF1BD5951E006B06B${i} /* ${name} */ = {
\t\t\tisa = PBXShellScriptBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t);
\t\t\tinputPaths = (
\t\t\t\t"$(SRCROOT)/.xcode.env.local",
\t\t\t\t"$(SRCROOT)/.xcode.env",
\t\t\t);
\t\t\tname = "${name}";
\t\t\toutputPaths = (
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t\tshellPath = /bin/sh;
\t\t\tshellScript = "${s}";
\t\t};
\t\t00EEFC60759A1932668264C${i} /* [CP] Embed Pods Frameworks */ = {
\t\t\tisa = PBXShellScriptBuildPhase;
\t\t\tname = "[CP] Embed Pods Frameworks";
\t\t\tshellPath = /bin/sh;
\t\t\tshellScript = "\\"\${PODS_ROOT}/Pods-frameworks.sh\\"\\n";
\t\t};
`,
    )
    .join('');
  return `// !$*UTF8*$!
{
\tobjects = {

/* Begin PBXShellScriptBuildPhase section */
${phases}/* End PBXShellScriptBuildPhase section */
\t};
}
`;
}

export const BARE_ANDROID_FILES: Record<string, string> = {
  'android/settings.gradle': SETTINGS_074,
  'android/build.gradle': ROOT_074,
  'android/app/build.gradle': APP_074,
};

export const BARE_IOS_FILES: Record<string, string> = {
  'ios/MyApp.xcodeproj/project.pbxproj': pbx([SCRIPT_076]),
  'ios/MyApp.xcodeproj/xcshareddata/xcschemes/MyApp.xcscheme': SAMPLE_XCSCHEME,
  'ios/Podfile': "platform :ios, '15.1'\n",
};
