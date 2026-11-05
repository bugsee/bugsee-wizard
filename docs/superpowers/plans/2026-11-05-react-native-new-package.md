# React Native recipe: move to `@bugsee/react-native` (7.x)

Decision (user, 2026-11-05): the wizard targets `@bugsee/react-native` (the new package, beta tag) and
automates everything for bare and Expo apps. A project that has the legacy `react-native-bugsee`
is stopped with a message: the packages are different, not an in-place upgrade.

Source of truth for the mechanics: https://github.com/bugsee/bugsee-react-native (`packages/react-native`:
README, `plugin/src/*` = the Expo config plugin that performs the same edits on prebuilt projects,
`scripts/*`, `native-versions.json`, `examples/bare` = the target state of a bare app).

## What changes vs the old recipe

- The wrapper bundles the native SDKs: the wizard no longer runs the Android/iOS native recipes
  (no SPM dependency, no pod, no AppDelegate / ContentProvider launch, no manifest meta-data).
  iOS: RN >= 0.87 resolves the SDK through SPM by autolinking, earlier RN through the pod the wrapper
  ships (`pod install`). Nothing is published to CocoaPods trunk.
- Launch is from JavaScript: `Bugsee.launch(token)` (the old native-launch path is gone).
- Bare apps need native edits for network capture and release symbolication:
  - Android: Bugsee Gradle plugin (`settings.gradle`, `build.gradle`, `app/build.gradle`), NDK
    dependency, `android/bugsee.properties` (`app_token`, `plugin.ndk.enabled`), Hermes source-map hook
    (`hermesCommand` + `apply from bugsee-sourcemaps.gradle`). Groovy and Kotlin DSL.
  - iOS: the app target's "Bundle React Native code and images" phase runs `bugsee-xcode.sh`; the
    scheme's Archive action gets the dSYM post-action; the token goes to `ios/.xcode.env.local`.
- Expo apps get one config-plugin entry in `app.json` instead.
- Versions of the native pieces come from the installed package's `native-versions.json`
  (`android.sdk`, `android.gradlePlugin`, `ios.sdk`), never hard-coded in a snippet.

## Shared contract (src/recipes/react-native/types.ts, paths.ts)

- `RnOptions.nativeVersions: { androidSdk, androidGradlePlugin, iosSdk }`
- `RnPlatformPaths.expoConfig: string | null` — absolute path of `app.json` (with an `expo` key) when the
  project has the `expo` dependency, else null. Expo projects get the Expo step and NOT the bare
  Android/iOS steps.
- `ctx.tokens.android` / `ctx.tokens.ios` — per-platform app tokens (either may be absent).
- `ctx.dryRun`, `ctx.cwd` (= RN root), `ctx.rnPaths.androidPath` / `iosPath`.

## Work packages (disjoint files; each exports `Step<RnContext>`s, with prechecks that make a second run a no-op and rollbacks that restore the exact bytes)

1. Core flow (run.ts, ensure-package / install, JS entry, pod install, legacy detection, rollback wiring).
2. `steps/android-gradle.ts` -> `androidGradleSteps`
3. `steps/ios-xcode.ts` -> `iosXcodeSteps`
4. `steps/expo-plugin.ts` -> `expoPluginStep`
