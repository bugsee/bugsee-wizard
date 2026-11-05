# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project intent

`@bugsee/wizard` is the Bugsee setup wizard — a strict-TypeScript ESM CLI run in a user's project directory that integrates Bugsee into that project for them.

End-to-end flow:

1. **Detect** the project type from the CWD (Android, iOS, React Native, Flutter, web, etc.). If detection is ambiguous or fails, prompt the user to pick from a list.
2. **Collect tokens** — one application token, or multiple when the project is cross-platform (e.g. RN/Flutter with separate iOS + Android tokens).
3. **Apply the platform-specific recipe** in user-land. Each project type has its own set of side effects on the user's repo, e.g.:
   - Android — add the Bugsee SDK dependency and the Gradle plugin
   - iOS — add the SDK and inject `BugseeAgent.py` as an Xcode build phase
   - JS-based stacks (RN, web) — wire up JS-mapping upload scripts
   - …and so on per platform

`uninstall` is also a first-class command: every step ships with a `rollback()` from day one. After uninstall completes, a single optional question asks why the user is removing Bugsee.

## Toolchain (locked decisions)

- **Node ≥ 22.18**, **ESM only** (`"type": "module"`).
- **TypeScript** strict mode, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. Module resolution is `bundler`; we drop `.js` extensions only inside the project's own bundled output, but **all relative imports in source must use the `.js` extension** to stay portable.
- **Build:** `tsup` → bundled `dist/cli.js` (with `#!/usr/bin/env node` shebang from `src/cli.ts`) and `dist/index.js` (programmatic API). `tsc` is used only for typechecking.
- **CLI:** `commander` + `@commander-js/extra-typings`.
- **Prompts/UI:** `@clack/prompts` (the reason we went ESM — clack is ESM-only).
- **Colors:** `picocolors`.
- **Tests:** `vitest`. Mock `@clack/prompts` in tests so prompts don't hang. Use on-disk fixtures for any test that mutates real config files (`.pbxproj`, `build.gradle`, etc.).
- **Lint/format:** `biome` (single tool, single config in `biome.json`).
- **No bundled binary.** Bugsee already has a Gradle plugin (Android) and `BugseeAgent.py` (iOS). The wizard *configures* user projects to invoke them; it does not ship a binary.
- **No telemetry.** Bugsee has no JS SDK yet. The uninstall exit-poll is volunteered user feedback — single POST via native `fetch`, not silent telemetry.

## Architecture

Two extension points, both centralized:

- **Detectors** (`src/core/detect.ts`) — each returns `{ kind, confidence, evidence[] }`. The dispatcher tallies. Adding a platform = one detector registration.
- **Steps** (`src/core/step.ts`) — every recipe is a list of `Step` objects with `precheck → apply → rollback`. The runner skips satisfied steps, halts on blocked or failed, and rolls back already-applied steps in reverse. **All recipes go through this runner — do not bypass it.** (Sentry's wizard has no Step abstraction and visibly suffers when implementing uninstall paths; we will not repeat that.)

Recipes mutate user-owned files, so:
- **Idempotent** — every step's `precheck` must detect "already applied" via a content sniff (e.g. search for `io.bugsee.android.gradle` in `build.gradle`, look for our marker in a build phase script).
- **Plan-then-write** — read the file, compute the new contents, confirm, write. Never stream edits.
- **`--dry-run`** must work for every step. The runner already gates apply/rollback on `ctx.dryRun`; step implementations should not bypass.

For native-project file editing, follow the patterns in Sentry's `sentry-wizard` (cloned at `/tmp/sentry-wizard` during research):
- `.pbxproj` → `xcode` npm package, wrapped in our own class (their `xcode-manager.ts` is the reference; it handles Xcode 15 `PBXFileSystemSynchronizedRootGroup`).
- Gradle / Podfile / AndroidManifest → regex + string slicing (deliberate, no AST).
- JS/TS configs → `magicast`.
- `package.json` → plain JSON parse + `detect-indent` to preserve user formatting.

## Commands

```bash
npm install              # install deps

npm run typecheck        # tsc --noEmit, the source of truth for types
npm run lint             # biome check
npm run lint:fix         # biome check --write
npm run format           # biome format --write
npm test                 # vitest run (one-shot)
npm run test:watch       # vitest watch
npm run build            # tsup → dist/
npm run dev              # tsup --watch
npm start                # node ./dist/cli.js (after build)
```

Run a single test file:
```bash
npx vitest run test/step.test.ts
```

Run the CLI against a fixture project without installing globally:
```bash
npm run build && node ./dist/cli.js --cwd /path/to/sample-project
# or, against an in-process build:
npx tsx src/cli.ts --cwd /path/to/sample-project
```

## Layout

```
src/
  cli.ts                # entry, hashbang, commander wiring
  index.ts              # programmatic API barrel
  project-kind.ts       # ProjectKind union + labels
  core/
    context.ts          # WizardOptions / WizardContext
    detect.ts           # Detector interface + registry + runDetectors()
    logger.ts           # thin clack wrapper with debug() gating
    step.ts             # Step interface + runSteps() with rollback
  commands/
    install.ts          # install command flow
    uninstall.ts        # uninstall command + exit poll
  detectors/            # (TODO) one file per platform, register at module load
  recipes/              # (TODO) one folder per platform; each exports a Step[]
test/
  step.test.ts          # smoke test for the Step runner
```

Detectors and recipes are not implemented yet — the scaffold proves the runner and CLI plumbing work end-to-end.
