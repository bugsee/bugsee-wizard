# Bugsee setup wizard — the JavaScript/web recipes, and getting the repo to a pushable state

Status: DRAFT for approval (2026-11-04), updated after the owner's answers. Nothing in this document has been built.

## 1. Intent

`npx @bugsee/wizard` should take a JavaScript/TypeScript project from "no Bugsee" to "Bugsee SDK installed,
initialised, and source maps uploading on every production build" with one command and a few prompts, the way
`npx @sentry/wizard` does for Sentry.

Why now: the JS SDK (`@bugsee/*`, 0.1.0-beta.5) is feature-complete, but only the Vite, Rollup and webpack
plugins automate source-map upload; the framework adapters (Next, Nuxt, SvelteKit, Astro, Remix, Angular,
Electron) wire nothing, and Node/Bun/Deno/Angular users run a manual CLI recipe. Nothing is hurting customers
today; this closes the gaps found in the source-map audit (JS repo, `docs/review/cli-js-flows.md`, plus the
2026-11-04 survey) and makes setup repeatable and testable.

## 2. Where things stand

- **Repo** `github.com/bugsee/bugsee-wizard` has only CI workflows (`claude-review`, `bugseeai`), `LICENSE`,
  `.gitignore`. The local checkout `~/Projects/Bugsee/wizard-cli` holds ~4.5k lines of TypeScript that were
  **never committed**: the CLI scaffold, the detector/step framework (`precheck → apply → rollback`, runner
  with reverse rollback, `--dry-run`), and recipes for **Android, iOS, React Native**, with tests. The `web`
  project kind exists but prints "not implemented".
- **Dependencies are behind** (npm outdated): commander 12→15, @commander-js/extra-typings 12→15, @clack/prompts
  0.9→1.8, magicast 0.3→0.5, vitest 2→5, @vitest/coverage-v8 2→5, biome 1.9→2.6, tsup 8→9, typescript 5.9→7.0,
  open 10→11, xcode 3→4, @types/node stays on 22.x, yaml 2.8→2.9.
- `@bugsee/wizard` is not published to npm.
- **Sentry's wizard** (v9.1.0, cloned and read in full for the web paths) is the reference. Its mechanics are
  summarised in §8.

## 3. Goals

1. Commit and push the existing wizard (framework + native recipes) to `bugsee/bugsee-wizard` on a branch via
   PR, with all dependencies updated and CI green.
2. A **web recipe** that detects the project's framework/bundler/runtime and, with consent, applies the right
   steps: install packages, add SDK init, wire source maps, store the token safely, optionally add CI and a
   verification page.
3. Source-map wiring for **every toolchain we can name**: Vite, webpack, Rollup, esbuild, Rspack, Next.js,
   Nuxt, SvelteKit, Astro, Remix/React Router, Angular, Electron, Cloudflare Wrangler, tsc/Node/Bun/Deno, and a
   generic "other tool" path that uses `bugsee-cli` directly.
4. **Idempotent and reversible**: re-running changes nothing; `uninstall` reverses what the wizard did.
5. **Non-interactive mode** that works in CI and for automation (every prompt has a flag/env equivalent and a
   default; failures are structured).
6. Token obtained by **pasting** (now). The browser flow is designed for but **deferred** (§5, D2).

## 4. Non-goals and anti-goals

Non-goals (this project): the browser-login token flow itself; Flutter; publishing `@bugsee/wizard` to npm (the
release is a separate step); changes to the JS SDK packages or `bugsee-cli` (they are inputs, with follow-ups
listed in §10).

Anti-goals — would make this a failure even if it works:
- The token is printed to the terminal or logs, or committed by the wizard by accident. (The app token is not
  a secret on the developer's machine — owner decision D3 — so it may live in a plain `.env` file and in
  SDK init code, but the wizard still never echoes it.)
- The wizard silently rewrites a file it could not parse; any unparseable shape ends in a manual snippet and a
  clear "this was not applied", never a false success (Sentry has this bug: SvelteKit's Vite catch path logs
  success after showing the fallback).
- It runs user project code (Sentry `import()`s `svelte.config.js` and the Remix config).
- It breaks a build: every edit must keep the project buildable, and e2e tests prove it.

## 5. Decisions

Decided by the owner (verbatim intent):
- **D1.** Token: offer both paste and browser login, asking the user which. Implement **paste first**; the
  browser flow (viewer opens, uses the existing session or shows sign-in, redirects to an application picker,
  and the terminal learns the selection) is deferred. Design the token source as a seam so it slots in later.
- **D2.** Work the existing repo: review the code, update all dependencies, investigate Sentry deeply, port
  and improve its logic, and push to `bugsee/bugsee-wizard`.

My calls (change any you disagree with):
- **C1.** Push via a branch and PR, not directly to `main` (the repo has a Claude review workflow and the
  wizard edits users' files; review is worth it). The first PR carries the existing native recipes untouched
  apart from dependency migration, so that diff is reviewable separately from the web work.
- **C2.** Update every dependency to latest, **except** adopt TypeScript 7 only if `tsup` declaration build and
  vitest work under it; otherwise stay on the newest TypeScript 5.x/6.x and say so. Each major bump is its own
  commit with the test suite green.
- **C2a.** Node floor raised to 22.18 on 2026-11-04 because the latest majors of vitest, tsup and commander require it (Node 20 is EOL).
- **C3.** Config edits use **magicast/recast for JS/TS configs, JSON-C-aware edits for `tsconfig`/`angular.json`/
  `wrangler.jsonc`, and a format-preserving `package.json` writer** (detect indent, key order, trailing
  newline) — Sentry rewrites `package.json` with `JSON.stringify(…, 2)` and loses formatting. Static analysis
  only; never `import()` user config.
- **C4.** Source-map wiring prefers the **bundler plugin** (`@bugsee/vite-plugin`, `webpack-plugin`, or
  `@bugsee/bundler-plugin-core` for Rollup/esbuild/Rspack), and falls back to a **post-build npm script**
  (`bugsee:sourcemaps`) that runs `bugsee-cli sourcemaps inject` then `debug-files upload` for tsc, Angular,
  Bun, Deno, Electron and "other". Until the CLI grows a single `ship` command the script chains the existing
  commands; switching later is a template change.
- **C5.** The wizard installs SDK packages at the **`beta`** dist-tag while the SDK is in beta, and the target
  version lives in one table (`src/web/versions.ts`), not scattered literals.
- **C6.** Telemetry is **opt-in and off by default** (owner decision, 2026-11-04: "for now" none, but build the
  mechanism). It is enabled only by an explicit `--telemetry` flag or `BUGSEE_WIZARD_TELEMETRY=1`; the wizard
  never asks interactively and never persists the choice, so the default run sends nothing. When on, it is
  **completely anonymous**: events carry only a fixed vocabulary — wizard version, Node major version, OS family
  (darwin/linux/win32), the detected recipe ids, and per-step outcome (`applied`/`skipped`/`manual`/`failed`) with a
  step id and an error *category* from a closed list. No user or machine name, hostname, IP-derived data, paths,
  repository or package names, file contents, tokens, app ids, or free-text error messages. A fresh random
  run id is generated per run and never stored, so runs cannot be linked to a machine or person. **Deferred (owner,
  2026-11-04): the collection endpoint and the wire format are designed later.** This round builds only the
  anonymous event vocabulary, the opt-in gate and a sink interface, with **no network transport**: even when opted
  in, nothing leaves the machine until a sink is added. A test asserts that no event field can hold a value
  outside the allowed vocabulary.
- **C6a.** Persist a small **change manifest** (`.bugsee/wizard-manifest.json`, committed or ignored per user
  choice) listing created/edited files and the inserted markers; `uninstall` and re-run detection use it. Edits
  carry a `bugsee-wizard` marker comment so detection is structural, not substring-based.
- **C7.** Per D4 the token goes into `.env.bugsee-build-plugin` (so the bundler plugins find it at build time)
  and the framework's own env mechanism for SDK init (e.g. `VITE_BUGSEE_APP_TOKEN`, `NEXT_PUBLIC_…`), instead of
  a literal in code where the framework supports it. The `.env` files are git-ignored by default (the entry is
  created if `.gitignore` is missing, with glob coverage) because they are per-developer, not because the value
  is secret; the user may opt to commit. The wizard never prints the token; for CI it names the variable.
- **C8.** Framework SDK init for frameworks without a one-line hook (Next, SvelteKit, Astro, Remix) is done by
  the wizard editing the user's files, as Sentry does. Longer term, the same hooks should become helpers in the
  JS SDK packages (`withBugsee(nextConfig)` etc.); that is a JS-repo follow-up, not a prerequisite. The
  follow-ups are tracked as issues in `bugsee/bugsee-javascript` (see §10).

- **D3.** Scope of this round is **(B)**: update dependencies and push the existing code, build the recipe engine
  and the source-map recipes (Vite, webpack, Rollup, esbuild, Rspack, tsc/Node/Bun/Deno, generic). Framework
  recipes (Next, Nuxt, SvelteKit, Astro, Remix, Angular, Cloudflare, Electron) are a later round, as separate PRs.
- **D4.** The Bugsee **app token is not a secret** when handled on the developer's machine (the person running
  the wizard). It may be written to a plain `.env` file and into SDK init code.
- **D6.** The old `web` platform is **decomposed into runtime subtypes** (browser, node, bun, deno, electron,
  webworker, serviceworker, edge), because the JS SDK targets more than the web (§6.1, C16).
- **D5.** **Recipes are data, published at `download.bugsee.com/sdk/wizard-recipes/<platform>/…`**, one model
  for every platform (web, iOS, Android, React Native, and later Unity, Flutter, Cordova and others), following the
  option-manifest precedent (§6.1). Recipes are never executable code. Not npm packages.

Further calls (from the builder check; each is mine, change any):
- **C16.** A recipe has a `kind`: **runtime** (which SDK package and init for a subtype), **framework** (spans
  runtimes: Next = browser + node + edge; it composes runtime recipes), or **buildtool** (source-map wiring for
  Vite, webpack, Rollup, esbuild, Rspack, tsc/CLI). A run resolves a runtime recipe per target, an optional
  framework recipe, and a buildtool recipe. The wizard's `web` project kind splits the same way, and detection
  reports the runtime subtype(s) alongside the framework and build tool. Electron is a separate recipe because
  it has three processes (main, preload, renderer) with different bundles.
- **C9.** Failure policy: a **required** step that fails during `apply` rolls back every step already applied in
  that recipe (the runner's existing reverse rollback), leaves the tree as it was, and exits non-zero. A step
  that merely cannot be automated (unparseable config shape) is **incomplete, not failed**: it prints the
  snippet, is recorded in the manifest as `manual`, the run continues, and the exit code is non-zero in
  non-interactive mode only.
- **C10.** The existing `Step`/runner is **extended, not replaced**, in Phase 2: add a `manual` outcome carrying
  a snippet, a per-file atomic-write helper, and a JSON result for non-interactive runs. The native recipes keep
  working unchanged; if clack 1.x or commander 15 force changes to the runner API, they land in Phase 1 with the
  upgrade so everything later builds on one foundation.
- **C11.** Monorepo v1: detect the workspace root, list workspace packages that look like web apps, and ask which
  to configure (`--package <path>` non-interactively); install in that package; support pnpm `catalog:` and
  `workspace:` specifiers when reading versions; search `.gitignore` upward.
- **C12.** Supported versions v1 (centralised in `src/web/versions.ts`, anything older gets a warning and a
  manual-docs link): Next.js 14+ (App and Pages Router), Nuxt 3.7+ and 4, SvelteKit 2, Astro 5+, Remix 2 and React
  Router 7, Angular 17+ (standalone), Vite 5+, webpack 5 (4 detected but unsupported for auto-edit), Rollup 4,
  esbuild 0.2x, Node 22+, Bun 1.x, Deno 2.x. Revisit when the table is first written.
- **C13.** E2E fixtures: the wizard repo's CI checks out `bugsee/bugsee-javascript` at a pinned ref and copies
  `samples/*` and `*-e2e` into temp dirs; the builds install `@bugsee/*` from the public registry at the `beta`
  tag. No submodule, no vendored copies.
- **C14.** First push: base branch is `main` (it has the CI workflows), PR from a feature branch. Branch
  protection or credentials are checked with `gh` before pushing; if the push is blocked I stop and report.
- **C15.** Plugin env-file contract: the wizard writes `.env.bugsee-build-plugin` and the bundler plugins
  (`bundler-plugin-core`) must **read it** (as Sentry's plugin reads `.env.sentry-build-plugin`). Today the
  plugins read only `process.env.BUGSEE_APP_TOKEN`, so this is a small JS-repo follow-up the web recipes depend
  on; until it lands the wizard also adds a `dotenv`-free fallback by documenting `BUGSEE_APP_TOKEN` in CI.

## 6. How it works

### 6.1 Recipes: data, published at download.bugsee.com, one model for every platform

A **recipe** is a JSON document (no code): detection rules, target package and version, and an ordered list of
**operations** with parameters. The wizard ships a **closed operation set** it implements and tests itself —
install a package, add a Vite/webpack/Rollup plugin to a config, wrap a default export, set a JSON/JSON-C key,
edit `package.json` scripts, insert an import, write a file from a template, ensure a `.gitignore` line, write an
env var. A recipe can only combine these; a remote document can therefore never execute code on the developer's
machine (the supply-chain risk of downloaded codemods). A step the operation set cannot express is a wizard
release, not a recipe.

**Store and URLs.** Recipes follow the precedent of the SDK option manifests (`bugsee/specs` `sdk/options`,
published by the Android and iOS release scripts to `download.bugsee.com`):

```
https://download.bugsee.com/sdk/wizard-recipes/<platform>/<sdk-version>/<revision>.json   immutable
https://download.bugsee.com/sdk/wizard-recipes/<platform>/index.json                       mutable index
```

`<platform>` is one id per SDK target: for JavaScript, one id per runtime subtype, aligned with the backend's
JS application subtypes (`javascript-browser`, `javascript-node`, `javascript-bun`, `javascript-deno`,
`javascript-electron`, `javascript-webworker`, `javascript-serviceworker`, `javascript-edge`); framework recipes
(`javascript-nextjs`, `javascript-nuxt`, …) and build-tool recipes (`javascript-vite`, `javascript-webpack`, …) use
the same scheme; then `ios`, `android`, `react-native`, `flutter`, `unity`, `cordova`, `capacitor`, `dotnet`, `kmp`
(new SDKs add an id; the wizard needs no change to read it). There is no `web` id: "web" is not a runtime, since
the JS SDK also covers Node, Bun, Deno and Electron. A revision file is
immutable once published. The index lists, per recipe revision: the SDK version range it covers, its URL, its
`sha256`, and the **minimum wizard engine version** it needs. A recipe fix is a new revision plus an index update,
with no SDK release. The format, URL scheme, immutability and index rules go into a new spec,
`bugsee/specs` `sdk/wizard-recipes/`, so every SDK repo implements against one contract. React Native's recipes
reference the iOS and Android ones.

**Resolution at run time.** The wizard detects the environment, resolves the SDK version it will install, fetches
the platform's `index.json`, and picks the newest revision whose SDK range includes that version and whose engine
requirement it meets. It verifies the `sha256` from the index before using the file. If the engine is too old it
says so and points to `npx @bugsee/wizard@latest`. If `download.bugsee.com` is unreachable it falls back to the
snapshot of recipes bundled with the wizard release. If no recipe covers the SDK version it uses the nearest older
one and warns.

**Keeping them in sync.**
- Each SDK's release pipeline publishes the matching recipe through its existing deploy step, the same way the
  option manifest is published today (Android `deploy.sh` / `deploy_options_manifest.sh`; iOS `deploy.sh` and the
  beta scripts), plus a manual "publish recipe" workflow to backfill or retry, like `publish-options-manifest`.
  The `bugsee-javascript` release (`scripts/release.sh` and `release.yml`, GitHub-hosted, npm OIDC only today)
  has no AWS access: it needs an OIDC deploy role for the S3 upload. That is new infrastructure and a dependency
  of Phase 3. SDKs with no release workflow today (React Native, Cordova, Unity, .NET, KMP, Capacitor) get the
  step when they get a workflow, or run the publish script by hand until then.
- **Release gate:** an SDK release fails if the index holds no recipe revision covering the version about to ship.
- **Recipe CI:** before a revision is published, CI runs every recipe against the fixture projects (for JavaScript:
  `samples/*` and `*-e2e`), builds them, and runs `bugsee-cli … --dry-run`.
- **Consumer check:** like the option-manifest rule, the wizard repo vendors the current recipes and CI diffs them
  against the published ones, so drift arrives as a reviewable diff.
- Native Android/iOS/RN recipes already exist as code in this repo; they move to the data model in a later round
  and keep working as code until then.
- Integrity v1 is HTTPS plus the index `sha256`; signing the index is a possible hardening, left out for now.

### 6.2 Run flow

```
detect → confirm → preconditions → token → plan → (consent) → apply → verify → manifest
```

- **Detect** (`src/web/detect.ts`): from `package.json` (deps/devDeps/workspaces), lockfiles, and config files,
  produce a ranked set: package manager (npm/yarn/pnpm/bun/deno), framework (most specific wins), bundler, runtime
  target (browser/node/edge/electron), TypeScript or not. Walk up to the workspace root; find the right package
  in a monorepo.
- **Preconditions:** git repo, clean tree (prompt or `--ignore-git-changes`), supported framework version, Node
  version. Same gates as Sentry, centralised in one table.
- **Plan:** a list of `Step`s (existing interface). `precheck` reports `satisfied/pending/blocked` by looking for
  the marker; `apply` edits; `rollback` reverses. `--dry-run` prints the plan with diffs.
- **Edits are all-or-nothing per file**: parse, transform, re-serialise, verify it re-parses, then write. A
  failure produces a manual snippet and a "not applied" result and sets a non-zero exit status in
  non-interactive mode.
- **Verify:** optional example page/route that throws; the outro prints the production-build test steps.

### Recipe matrix

| Project | Packages | SDK init | Source maps |
|---|---|---|---|
| Vite SPA (React/Vue/Svelte/Solid/Preact) | `@bugsee/<ui>`, `@bugsee/vite-plugin` | entry file | plugin in `vite.config`, `build.sourcemap` |
| webpack / CRA | `@bugsee/<ui>`, `@bugsee/webpack-plugin` | entry file | plugin in config (CJS/ESM), `devtool` |
| Rollup / esbuild / Rspack | `@bugsee/bundler-plugin-core` | entry file | plugin + `sourcemap` |
| Next.js | `@bugsee/nextjs` | `instrumentation(.client).ts`, `next.config` | webpack plugin via config, `productionBrowserSourceMaps`, server maps |
| Nuxt | `@bugsee/nuxt` | module entry in `nuxt.config` | `sourcemap` + Vite plugin |
| SvelteKit | `@bugsee/sveltekit` | hooks files | Vite plugin |
| Astro | `@bugsee/astro` | integration in `astro.config` | Vite plugin |
| Remix / React Router | `@bugsee/remix` | entry files, root | Vite plugin, or build-script upload |
| Angular | `@bugsee/angular` | `main.ts` / `app.config.ts` (read `angular.json`, do not hard-code paths) | `sourceMap` in `angular.json` + `bugsee:sourcemaps` script |
| Electron | `@bugsee/electron` | main + preload + renderer | script over main and renderer outputs |
| Node/Bun/Deno/tsc | `@bugsee/node` / `bun` / `deno` | entry import | `tsconfig` flags + script |
| Cloudflare/Vercel edge | `@bugsee/cloudflare` / `vercel-edge` | wrap worker, `wrangler` config | `wrangler` or bundler plugin |
| Any other | — | printed instructions | `bugsee-cli` script |

## 7. Improvements over Sentry (each is a requirement)

1. Real **non-interactive mode** for web (flags + `BUGSEE_WIZARD_*` env, no hanging prompts, JSON result).
2. **Structured idempotency** (markers + manifest), never substring checks; no overwrite-and-delete of user files.
3. **`package.json` written format-preserving.**
4. **Monorepo aware**: workspace root, per-package detection, `.gitignore` search upward.
5. **Static analysis only**, no user code execution.
6. **Honest results**: a failed edit is reported as failed; the exit code reflects it.
7. **Token never printed**; CI step names the secret.
8. **Cross-platform scripts** (no `NODE_OPTIONS=… cmd` prefix that breaks on Windows; use `cross-env` or a node
   wrapper).
9. **Uninstall for web**, using the manifest.
10. **Centralised version/gate table.**
11. Fixes for the specific bugs found: preSelected key mismatch (`id` vs `projectId`); CJS Next config edited by
    AST not text appending; Cloudflare compat-date overwrite; SvelteKit false success.

## 8. What Sentry's wizard does (reference, condensed)

Entry `bin.ts` → `src/run.ts` (env overrides flags; prompts for integration if no `-i`) → a per-framework
wizard wrapped in telemetry. Shared utils cover: git checks (`git status --porcelain=v1 -z`), package-manager
detection by lockfile, lockfile-aware install with error log, `package.json` helpers incl. pnpm `catalog:`
versions, AST helpers (`findFile`, `hasSentryContent`, object-property get/set, JSON-C parse/print), token file
writer + `.gitignore` appender, copy-paste fallback prompts. Login is a hash/poll against a Sentry endpoint
(`api/0/wizard/`), which the deferred Bugsee browser flow would mirror. Source maps: `detectUsedTool` over an
ordered package map; bundler plugin install and config edit via magicast `addVitePlugin` (and recast for
webpack CJS); a `sentry-cli` fallback that adds an npm script and optionally appends it to `build`; CI step is a
printed env var. Tests: unit tests on codemods with fixtures, plus e2e tests that copy a real test app to a temp
dir and drive prompts with `clifty`, asserting file contents and that the project builds/runs.

## 9. Testing

- **Unit:** each codemod against fixture inputs (every config shape: default export, `defineConfig`, function
  form, CJS, TS, JSON-C), including the "already applied" and "cannot parse" cases. Detectors against fixture
  `package.json`s. Per the Bugsee standard: tests first, and a mutation loop per entity.
- **E2E:** reuse the JS repo's `samples/*` and `*-e2e` fixtures: copy to a temp dir, run the wizard
  non-interactively with a fake token, assert the diff, **run the real build**, and run `bugsee-cli … --dry-run`
  against the output to prove injection and upload discovery work. A mock collector can assert the upload.
- **CI:** typecheck, biome, unit, then the e2e matrix by framework.

## 10. Phases (round B)

1. **Foundation:** dependency updates (own commits), commit the existing code, CI, PR #1 to the repo.
2. **Engine:** detectors, package-manager and workspace logic, format-preserving writers, AST helpers, the
   operation set and recipe loader/resolver, manifest + markers, token store, non-interactive layer, `uninstall`.
3. **Source-map recipes (the deliverable):** Vite, webpack, Rollup, esbuild, Rspack, tsc/Node/Bun/Deno, generic;
   the `javascript-*` recipes under `sdk/wizard-recipes/`, the `sdk/wizard-recipes` spec in `bugsee/specs`, and the
   publish step/gate (including the AWS OIDC deploy role) in `bugsee-javascript`'s release.

Later rounds (not in this one): framework recipes (Next, Nuxt, SvelteKit, Astro, Remix/React Router, Angular,
Cloudflare, Electron); moving native recipes to the data model; the browser token flow (needs the viewer
redirect, a short-lived pairing endpoint, and terminal polling).

Follow-ups outside this repo. Opened in `bugsee/bugsee-javascript` on 2026-11-04:
- #181 meta-framework build integration helpers (C8: `withBugsee` and friends);
- #182 bundler plugins read `.env.bugsee-build-plugin` (C15);
- #183 migrate the plugins from `@bugsee/bugsee-cli` (frozen at 0.8.2) to `@bugsee/cli`;
- #184 the esbuild and Rspack plugins do not inject or upload, and the docs say they do;
- #185 Node `--enable-source-maps` breaks the debug-ID lookup (measured);
- #186 publish recipes at release: AWS OIDC role, release step, gate, recipe CI.

Not opened (other repos): the `sdk/wizard-recipes` spec in `bugsee/specs`, and a `bugsee-cli sourcemaps ship`
command (a single call for inject, upload, optional map deletion and build registration).

## 11. Left to the builder

File layout inside `src/web`, the exact prompt wording, the manifest schema details, which clack components to
use, naming of the generated npm script and env file beyond those above, the order of recipe delivery inside
phases 3 and 4, and how to split commits.
