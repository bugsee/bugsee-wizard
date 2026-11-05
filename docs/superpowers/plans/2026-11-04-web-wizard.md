# Bugsee Wizard: Foundation, Recipe Engine and Source-Map Recipes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push the existing wizard to `bugsee/bugsee-wizard` with current dependencies, then add a recipe engine and the JavaScript source-map recipes (Vite, webpack, Rollup, esbuild, Rspack, tsc/Node/Bun/Deno, generic).

**Architecture:** Recipes are JSON data made of a closed set of operations the wizard implements; they are resolved by SDK version from `download.bugsee.com/sdk/wizard-recipes/<platform>/index.json`, with a snapshot bundled in the wizard as fallback. The existing `Step` runner (`precheck → apply → rollback`) is extended, not replaced; each operation compiles to a `Step`. Detection reports runtime subtype(s), framework, build tool and package manager.

**Tech Stack:** TypeScript (strict, ESM, `.js` import suffixes), Node ≥ 22.18, commander, @clack/prompts, magicast (JS configs), recast via magicast, detect-indent, vitest, biome, tsup.

**Spec:** `docs/superpowers/specs/2026-11-04-web-wizard-design.md` (approved 2026-11-04). Read it first; section numbers below refer to it.

## Global Constraints

- Repo `/Users/alexeykarimov/Projects/Bugsee/wizard-cli`, remote `github.com/bugsee/bugsee-wizard`, base branch `main`. Work on feature branches; open PRs ready (not draft). Never push to `main`; if a push is refused, stop and report.
- Node `>=22.18.0`, ESM only; all relative imports use the `.js` extension; `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` stay on.
- Checks that must pass before every commit: `npm run typecheck && npm run lint && npm test && npm run build`.
- TDD: failing test first, then code; after each new function run a mutation pass (inject one bug, confirm a test fails, roll it back) per the Bugsee standard.
- Recipes are data only; the wizard never downloads or executes code (§6.1). No `import()` of user config; edits are static (magicast / JSON-C / format-preserving JSON).
- Edits are all-or-nothing per file: parse → transform → re-parse the result → write. Unparseable shape ⇒ outcome `manual` with a snippet, never a false success (§4, C9).
- Token: app token is not secret on the developer's machine (D4); the wizard never prints it. Env file is `.env.bugsee-build-plugin` (C7, C15).
- Telemetry: off by default, only `--telemetry` / `BUGSEE_WIZARD_TELEMETRY=1`, fixed anonymous vocabulary, **no network transport** this round (C6).
- SDK install tag: `beta` while the SDK is in beta; all versions come from `src/web/versions.ts` (C5, C12).
- Recipe platform ids: `javascript-<browser|node|bun|deno|electron|webworker|serviceworker|edge>`, framework `javascript-<nextjs|nuxt|…>`, build tool `javascript-<vite|webpack|rollup|esbuild|rspack|tsc|cli>`. There is no `web` id (D6, C16).
- Out of scope: framework recipes, native recipes moving to data, browser token flow, telemetry endpoint, `bugsee-cli ship`, publishing `@bugsee/wizard` to npm, the AWS publish step (JS repo issue #186).

## Review Focus

1. **Monorepo root** — run from a workspace root with several apps; expect a package prompt (or `--package`), never edits to the root `package.json`.
2. **Unusual config shapes** — `vite.config` as function / async / `mergeConfig`, webpack ESM or array config; expect `manual` + snippet and a non-zero non-interactive exit, with files untouched.
3. **Re-run** — second run changes nothing (exit 0, all steps `skipped`); a user-edited marker line is respected.
4. **Formatting** — `package.json` with tabs, CRLF, no trailing newline, odd key order is rewritten byte-identically except the changed key.
5. **Pasted token** — surrounding whitespace/newline/quotes are trimmed; empty or inner-space values are rejected; never echoed in logs or `--debug` output.

---

## Phase 1 — Foundation (PR #1)

### Task 1: Baseline commit and CI

**Files:** Create `.github/workflows/ci.yml`; commit everything currently untracked (`src/`, `test/`, `docs/`, `CLAUDE.md`, `package.json`, `package-lock.json`, `biome.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`); Modify `.gitignore` (add `dist`, `coverage`, `.DS_Store`, `.bugsee/`).

- [ ] **Step 1:** `git pull --ff-only` on `main` (local is behind `origin/main` by the two workflow commits), then `git switch -c chore/baseline-and-deps`.
- [ ] **Step 2:** Run `npm ci && npm run typecheck && npm run lint && npm test && npm run build` on the current code; record failures. Fix only what blocks green (lint formatting via `npm run lint:fix`); do not change behavior.
- [ ] **Step 3:** Add `ci.yml`: trigger `pull_request` and `push` to `main`; matrix Node `22.18`, `24` on `ubuntu-latest`; steps `npm ci`, typecheck, lint, test, build.
- [ ] **Step 4:** Commit in two commits: `chore: import existing wizard (framework, android, ios, react-native)` and `ci: typecheck, lint, test, build on Node 22.18/24`. Push the branch.

### Task 2: Dependency upgrades (one commit per major)

**Files:** `package.json`, `package-lock.json`, plus whatever each upgrade forces.

**Interfaces:** Produces the library versions every later task assumes: commander 15, @clack/prompts 1.x, magicast 0.5, vitest 5, biome 2, tsup 9, open 11, xcode 4, yaml latest; add `semver` and its types.

- [ ] **Step 1:** For each target below, read the package's `engines`. If any latest major requires Node > 22.18, **stop and report** (do not raise the floor silently).
- [ ] **Step 2:** In this order, each its own commit, running the four checks after each: (a) `yaml`, patch bumps; (b) `@biomejs/biome` 1.9→2 (run `npx biome migrate --write`, then `lint:fix`); (c) `vitest` + `@vitest/coverage-v8` 2→5; (d) `tsup` 8→9; (e) `commander` + `@commander-js/extra-typings` 12→15 (fix `src/cli.ts`); (f) `@clack/prompts` 0.9→1.x (fix prompt call sites in `src/commands/*` and recipes; the test mock in `test/step.test.ts` must still match); (g) `magicast` 0.3→0.5; (h) `open` 11, `xcode` 4; (i) `typescript` 7: if `npm run build` (tsup dts) or vitest fails under 7, use the newest 5.x/6.x, say so in the commit body.
- [ ] **Step 3:** `@types/node` stays on the 22.x line (the engine floor) so Node 24+ APIs cannot be used by accident; note this as the one deliberate exception to "all latest" in the PR description.
- [ ] **Step 4:** `npm outdated` shows only the deliberate `@types/node` exception (and TypeScript if held back).

### Task 3: Open PR #1

- [ ] **Step 1:** Push; `gh pr create --base main` (ready, not draft) with a body that lists the dependency table (before → after), the `@types/node`/TypeScript decisions, and states the native recipes are unchanged except for API migration. End with the Claude Code attribution line.
- [ ] **Step 2:** Watch CI and the `claude-review` job; fix real findings test-first, reply on threads with commit SHAs. Do not merge; a human must approve.

---

## Phase 2 — Recipe engine (PR #2, branch off `main` after PR #1 merges)

All new engine code lives in `src/engine/` (one responsibility per file); web-specific code in `src/web/`. Tests mirror paths under `test/engine/` and `test/web/` with on-disk fixtures in `test/fixtures/`.

### Task 4: Extend the step runner for `manual` and `incomplete`

**Files:** Modify `src/core/step.ts`, `src/core/context.ts`, `src/index.ts`; Test `test/step.test.ts` (extend).

**Interfaces:** Produces:
```ts
export type StepOutcome = 'applied' | 'skipped' | 'blocked' | 'failed' | 'rolled-back' | 'manual';
export interface ManualSnippet { readonly file: string; readonly title: string; readonly code: string }
export interface ApplyResult { readonly manual?: ManualSnippet }       // Step.apply: Promise<ApplyResult | void>
export interface StepResult { /* existing */ readonly snippet?: ManualSnippet }
export interface RunStepsResult { readonly results: readonly StepResult[]; readonly failed: boolean; readonly incomplete: boolean }
```
`WizardOptions` gains `nonInteractive: boolean` and `json: boolean` (both default false).

- [ ] **Step 1:** Tests: (a) a step whose `apply` returns `{manual}` yields outcome `manual`, does **not** trigger rollback, run continues, `incomplete: true`, `failed: false`; (b) a later throwing step rolls back earlier `applied` steps but not `manual` ones; (c) `--dry-run` never calls `apply`.
- [ ] **Step 2:** Implement in `runSteps`; keep `runRollback` unchanged. Run the existing tests to prove the native recipes still pass.

### Task 5: Safe file edits, package.json, .gitignore, env files

**Files:** Create `src/engine/fs-edit.ts`, `src/engine/package-json.ts`, `src/engine/gitignore.ts`, `src/engine/env-file.ts`; Test `test/engine/{fs-edit,package-json,gitignore,env-file}.test.ts`.

**Interfaces:** Produces:
```ts
editTextFile(path: string, transform: (src: string) => string, opts: { validate: (out: string) => boolean }): Promise<{ changed: boolean; before: string; after: string }>
readPackageJson(path: string): Promise<{ data: Record<string, unknown>; write: (next: Record<string, unknown>) => Promise<void> }>   // preserves indent, EOL, key order, trailing newline
ensureGitignoreLine(root: string, line: string): Promise<'added' | 'present' | 'created'>   // glob-aware: `.env*` satisfies `.env.bugsee-build-plugin`
setEnvVar(file: string, key: string, value: string): Promise<'added' | 'present' | 'conflict'>   // never overwrites an existing different value
```

- [ ] **Step 1:** Tests with real temp dirs: `editTextFile` writes atomically (temp file + rename) and refuses (throws, file untouched) when `validate(out)` is false; `readPackageJson` round-trips tabs/CRLF/no-final-newline fixtures byte-identically when nothing changes and changes only the target key otherwise (Review Focus 4); `ensureGitignoreLine` handles missing file (creates), CRLF, and a covering glob; `setEnvVar` reports `conflict` for a different existing value.
- [ ] **Step 2:** Implement with `detect-indent`; CRLF detected from the first newline.

### Task 6: Package manager and workspace detection

**Files:** Create `src/engine/package-manager.ts`, `src/engine/workspace.ts`; Test `test/engine/{package-manager,workspace}.test.ts` with fixture trees.

**Interfaces:** Produces:
```ts
type PackageManagerName = 'npm' | 'yarn' | 'pnpm' | 'bun' | 'deno';
detectPackageManager(startDir: string): Promise<{ name: PackageManagerName; root: string; installArgs: (pkgs: string[], dev: boolean) => string[] } | null>  // walks up; exactly one lockfile or null
findWorkspace(startDir: string): Promise<{ root: string; packages: { dir: string; name: string }[] } | null>   // package.json `workspaces`, pnpm-workspace.yaml
resolveDependencyVersion(pkgDir: string, dep: string): Promise<string | undefined>   // understands `catalog:` and `workspace:`
```

- [ ] **Step 1:** Tests: each lockfile; two lockfiles ⇒ `null`; pnpm `catalog:` resolved from `pnpm-workspace.yaml`; workspace root listing (Review Focus 1).
- [ ] **Step 2:** Implement; walk up at most 10 directories (Sentry's cap); pnpm and yarn-v1 install args include the workspace-root flag when inside a workspace.

### Task 7: Config AST helpers

**Files:** Create `src/engine/config-ast.ts`; Test `test/engine/config-ast.test.ts`, fixtures `test/fixtures/configs/*` (vite: default object, `defineConfig({})`, function form, async, identifier export; webpack: CJS, ESM, array; rollup; esbuild script; rspack).

**Interfaces:** Produces:
```ts
findConfigFile(dir: string, base: string): Promise<string | undefined>   // tries .ts .mts .js .mjs .cjs
type PluginTarget = 'vite' | 'webpack' | 'rollup' | 'rspack';
addBundlerPlugin(source: string, target: PluginTarget, spec: { importFrom: string; importName: string; callArgs: string }): { code: string } | { manual: string }
setJsonCKey(source: string, path: string[], value: unknown): string   // preserves comments (tsconfig, angular.json)
hasBugseeMarker(source: string): boolean   // structural: marker comment `bugsee-wizard`
```
Every edit adds a `// bugsee-wizard` marker comment; `addBundlerPlugin` is a no-op when the marker or the import already exists.

- [ ] **Step 1:** Tests per fixture: result re-parses; plugin appears once after a second application (idempotent); function/async/`mergeConfig` shapes return `{ manual }` with a usable snippet (Review Focus 2).
- [ ] **Step 2:** Implement over `magicast` (`parseModule`, `addVitePlugin` where it fits); everything else by explicit node handling. Mutation pass on the shape-detection branches.

### Task 8: Recipe format, validator and operations

**Files:** Create `src/engine/recipe.ts`, `src/engine/ops/{index,install-package,add-bundler-plugin,set-json-key,add-package-script,ensure-gitignore,write-env-var,write-file}.ts`, `src/engine/execute.ts`; Test `test/engine/{recipe,execute}.test.ts`, `test/engine/ops/*.test.ts`.

**Interfaces:** Consumes Tasks 4–7. Produces:
```ts
interface Recipe { schema: 1; id: string; kind: 'runtime' | 'framework' | 'buildtool'; platform: string;
  engine: { min: string }; sdk: { range: string }; detect: DetectRule[]; ops: OpSpec[]; verify?: string[] }
type OpSpec = { op: 'install-package'; packages: string[]; dev?: boolean; tag?: string }
  | { op: 'add-bundler-plugin'; target: PluginTarget; importFrom: string; importName: string; callArgs: string; ensureSourcemap?: boolean }
  | { op: 'set-json-key'; file: string; path: string[]; value: unknown }
  | { op: 'add-package-script'; name: string; command: string; chainInto?: string }
  | { op: 'ensure-gitignore'; line: string } | { op: 'write-env-var'; file: string; key: string; from: 'token' }
  | { op: 'write-file'; path: string; template: string };
parseRecipe(json: unknown): Recipe            // throws RecipeError listing every violation; unknown `op` is an error
opToStep(spec: OpSpec): Step<RecipeContext>   // one Step per op
executeRecipe(recipe: Recipe, ctx: RecipeContext): Promise<RunStepsResult>
```
`RecipeContext` extends `WizardContext` with `packageDir`, `packageManager`, `token`, `manifest`. `chainInto` appends `&& npm run <name>`-style (cross-platform; no `NODE_OPTIONS=` prefixes).

- [ ] **Step 1:** Tests: `parseRecipe` rejects unknown ops, a missing `engine.min`, and a `write-file` path escaping the package dir; each op's `precheck` reports `satisfied` on re-run and `apply` + `rollback` restore the exact prior bytes; `write-env-var` never logs the value (spy on the logger).
- [ ] **Step 2:** Implement with a hand-written validator (no schema dependency); `install-package` runs the detected package manager with `shell: false` and on failure writes nothing into the repo.

### Task 9: Manifest, markers and uninstall for JavaScript

**Files:** Create `src/engine/manifest.ts`; Modify `src/commands/uninstall.ts`; Test `test/engine/manifest.test.ts`.

**Interfaces:** Produces `.bugsee/wizard-manifest.json`: `{ schema: 1, wizard: string, recipes: { id; revision }[], entries: { file: string; action: 'created' | 'edited' | 'manual'; beforeSha256?: string; marker?: string }[] }`; functions `loadManifest(dir)`, `recordEntry(dir, entry)`, `rollbackFromManifest(ctx)`.

- [ ] **Step 1:** Tests: after a successful run the manifest lists every created/edited file; `rollbackFromManifest` removes created files and reverts edited ones only when the current hash matches what the wizard wrote (otherwise reports `manual`); re-run uses the manifest to mark steps `skipped` (Review Focus 3).
- [ ] **Step 2:** Implement; the manifest file path is added to `.gitignore` by default.

### Task 10: Recipe store client

**Files:** Create `src/engine/recipe-store.ts`, `snapshot/` (bundled recipes, empty `index.json` for now); Modify `package.json` (`files: ["dist", "snapshot"]`); Test `test/engine/recipe-store.test.ts` against a local `node:http` mock server.

**Interfaces:** Produces:
```ts
resolveRecipe(q: { platform: string; sdkVersion: string; engine: string; baseUrl?: string; fetchImpl?: typeof fetch }):
  Promise<{ recipe: Recipe; revision: string; source: 'remote' | 'snapshot'; warning?: string }>
```
Default `baseUrl` is `https://download.bugsee.com/sdk/wizard-recipes`. Index entry: `{ range: string; revision: string; url: string; sha256: string; engineMin: string }`.

- [ ] **Step 1:** Tests: picks the newest revision whose range includes `sdkVersion` and `engineMin ≤ engine`; rejects a body whose `sha256` differs from the index; engine too old ⇒ error message containing `npx @bugsee/wizard@latest`; unreachable host ⇒ snapshot with `source: 'snapshot'`; no covering recipe ⇒ nearest older one plus `warning` (Review Focus: offline).
- [ ] **Step 2:** Implement with `semver` (`satisfies(..., { includePrerelease: true })`) and `node:crypto`; 5 s timeout, one retry.

### Task 11: Token source, non-interactive layer, telemetry gate

**Files:** Create `src/engine/token.ts`, `src/engine/noninteractive.ts`, `src/engine/telemetry.ts`; Modify `src/cli.ts`; Test `test/engine/{token,noninteractive,telemetry}.test.ts`.

**Interfaces:** Produces:
```ts
interface TokenSource { readonly kind: 'paste' | 'env' | 'flag'; get(): Promise<string> }
normalizeToken(raw: string): string   // trims whitespace/newlines/quotes; throws on empty or inner whitespace
selectTokenSource(opts: { flag?: string; env: NodeJS.ProcessEnv; nonInteractive: boolean }): TokenSource  // flag > BUGSEE_APP_TOKEN > paste prompt; the browser source plugs in here later
type TelemetryEvent = { name: 'run' | 'step'; wizard: string; nodeMajor: number; os: 'darwin' | 'linux' | 'win32' | 'other';
  recipe?: string; step?: string; outcome?: 'applied' | 'skipped' | 'manual' | 'failed'; errorCategory?: 'parse' | 'io' | 'network' | 'install' | 'unsupported' | 'other'; runId: string }
interface TelemetrySink { send(e: TelemetryEvent): void }
createTelemetry(opts: { flag: boolean; env: NodeJS.ProcessEnv; sink?: TelemetrySink }): { enabled: boolean; emit(e: Omit<TelemetryEvent, 'runId' | 'wizard' | 'nodeMajor' | 'os'>): void }
```
CLI flags added: `--non-interactive`, `--json`, `--package <path>`, `--token <t>`, `--telemetry`, `--ignore-git-changes`; env `BUGSEE_WIZARD_*` equivalents; env overrides nothing the flag set explicitly (the reverse of Sentry, documented in `--help`).

- [ ] **Step 1:** Tests: `normalizeToken` cases (Review Focus 5); token never appears in any logger call or JSON output (spy); telemetry disabled by default and sends nothing even with a sink; enabled only via flag/env; `runId` differs per run and is never written to disk; a type-level test that `emit` rejects extra keys, and a runtime test that unknown string values for `outcome`/`errorCategory` are dropped.
- [ ] **Step 2:** Implement; `--json` prints one result object `{ ok, incomplete, steps: [{ id, outcome }] }` on stdout and everything else on stderr; non-interactive with a missing required input exits 2 with `{ ok: false, error: 'missing-input', field }`.

### Task 12: JavaScript detection and install wiring

**Files:** Create `src/web/{versions,detect,run}.ts`; Modify `src/project-kind.ts` (replace `web` with `javascript`, label `JavaScript / TypeScript`), `src/detectors/index.ts`, `src/commands/install.ts`; Test `test/web/{detect,versions,run}.test.ts`, fixtures `test/fixtures/js/*` (copies of the shapes in `samples/*`).

**Interfaces:** Consumes Tasks 6, 8, 10, 11. Produces:
```ts
interface JsDetection { packageDir: string; packageManager: PackageManagerName | null; runtimes: string[];   // e.g. ['browser'], ['node','edge']
  framework?: string; buildTool?: string; typescript: boolean; versions: Record<string, string> }
detectJavaScript(cwd: string): Promise<JsDetection | null>
SUPPORTED: Record<string, { min: string; note?: string }>   // §5 C12 table, one place
runJavaScriptRecipe(opts: WizardOptions): Promise<RunStepsResult>
```
Most specific wins (framework over bundler over `typescript`); detection never executes user files.

> **Scope note (review follow-up).** Tasks 12 and 13 resolve and bundle only the **`buildtool`** recipes (source-map
> wiring). The design (§3 goal 2, C16) also calls for a **runtime** recipe per target (install the SDK package and add
> SDK init to the entry file), and the `OpSpec` union has no op that edits an existing entry file. That part is **not
> covered by this plan**: the first PRs ship source-map wiring only, and runtime SDK install/init needs its own task
> (a runtime recipe kind in the snapshot, plus an entry-file op). The deferrals D3 and C8 (framework-specific init)
> are unchanged. Owner to schedule.

- [ ] **Step 1:** Tests: each fixture detects the expected runtime/framework/build tool; Electron fixture ⇒ `runtimes` includes `electron`; a version below `SUPPORTED[...].min` warns and continues; non-JS dir ⇒ `null`.
- [ ] **Step 2:** `runJavaScriptRecipe`: git precondition (clean tree, `--ignore-git-changes`), pick package (prompt or `--package`), resolve token, resolve recipes for the detected build tool, `executeRecipe`, write manifest, print outro with production-build test steps. Exit code: `failed` ⇒ 1, `incomplete` with `--non-interactive` ⇒ 3, else 0.
- [ ] **Step 3:** Route `web` to the JavaScript recipe in `install.ts` for the projects it supports (source-map wiring, see the scope note above). Keep the "not implemented" branch for `web` projects that need runtime SDK setup until the runtime-recipe task lands; `flutter`/`unknown` keep it.

---

## Phase 3 — Source-map recipes (PR #3 here; PR #4 in `bugsee-javascript`; PR #5 in `bugsee/specs`)

### Task 13: Recipe set and bundled snapshot

**Files:** Create in this repo `snapshot/javascript-{vite,webpack,rollup,esbuild,rspack,tsc,cli}.json`, `snapshot/index.json`, `scripts/validate-snapshot.mjs`; Test `test/web/snapshot.test.ts`.

**Interfaces:** Each recipe is `kind: 'buildtool'`, `schema: 1`, `sdk.range: '>=0.1.0-beta.5'`, `engine.min` = current wizard version. Contents:
- **vite:** `install-package` (`@bugsee/vite-plugin`, dev, tag `beta`), `add-bundler-plugin` (target `vite`, `importFrom: '@bugsee/vite-plugin'`, `importName: 'bugseeVitePlugin'`, `callArgs: '{ appToken: process.env.BUGSEE_APP_TOKEN }'`, `ensureSourcemap: true`), `write-env-var` (`.env.bugsee-build-plugin`), `ensure-gitignore`.
- **webpack:** same with `@bugsee/webpack-plugin` / `bugseeWebpackPlugin`; sets `devtool: 'source-map'` only when absent.
- **rollup:** `@bugsee/bundler-plugin-core`, `bugseeRollupPlugin`, `output.sourcemap: true`.
- **esbuild, rspack:** until JS repo issue #184 lands the plugins do **not** upload, so these recipes use the CLI script path of **cli** below (note the issue number in the recipe `notes`).
- **tsc, cli (Node/Bun/Deno, Angular, Electron, other):** `install-package` (`@bugsee/cli`, dev), `set-json-key` (`tsconfig` `sourceMap: true`, `inlineSources: true`, only for tsc), `add-package-script` (`bugsee:sourcemaps` = `bugsee-cli sourcemaps inject <out> && bugsee-cli debug-files upload <out> --type sourcemaps --version … --build …`, `chainInto: 'build'` only after a confirm), `write-env-var`, `ensure-gitignore`.

- [ ] **Step 1:** Tests: every snapshot file passes `parseRecipe`; `index.json` entries' `sha256` match the files; running each recipe through `executeRecipe` against its fixture twice gives `applied` then all `skipped`.
- [ ] **Step 2:** Author the files; `scripts/validate-snapshot.mjs` recomputes hashes (run in CI).

### Task 14: End-to-end against real projects

**Files:** Create `e2e/run.test.ts`, `e2e/fixtures.mjs` (checks out `bugsee/bugsee-javascript` at a pinned ref into a temp dir and copies `samples/*`), `.github/workflows/e2e.yml`.

- [ ] **Step 1:** For each of `react-spa` (Vite), `webpack-sourcemaps`, `vue-spa`, `svelte-spa`, `angular-spa`, `node-service`: copy to a temp dir, run `dist/cli.js --non-interactive --json --token TESTTOKEN123 --ignore-git-changes`, assert the file diff and the manifest, run the project's real build, then `bugsee-cli sourcemaps inject <out> --dry-run` and `bugsee-cli debug-files upload <out> --type sourcemaps --dry-run --version 0 --build 0` and assert both discover the maps.
- [ ] **Step 2:** Second run on each copy asserts zero changes; `uninstall` restores the original tree (compare with `git diff` on the copy).
- [ ] **Step 3:** The workflow runs the e2e matrix on `workflow_dispatch` and on PRs touching `src/`, `snapshot/` or `e2e/`; installs `@bugsee/*` from the public registry at `beta`.

### Task 15: `sdk/wizard-recipes` spec (PR in `bugsee/specs`, local `/Users/alexeykarimov/Projects/Bugsee/report-bundle-structure`)

**Files:** Create `sdk/wizard-recipes/README.md`, `sdk/wizard-recipes/recipe.md` (schema, op set, versioning).

- [ ] **Step 1:** Write the spec from §6.1: URL scheme, platform ids, immutability, index fields, `engine.min`, SDK range, integrity (`sha256`), consumer rules (vendor and diff), release gate. Follow the style of `sdk/options/README.md`. Link the JS repo issues #181–#186.
- [ ] **Step 2:** Open the PR; do not merge.

### Task 16: Recipes in `bugsee-javascript` and the vendoring check

**Files:** In `bugsee-javascript`: create `wizard-recipes/javascript-*.json` (source of truth, same content as the snapshot) and a CI check that parses them; In this repo: `scripts/sync-snapshot.mjs`, CI step.

- [ ] **Step 1:** Move authorship to `bugsee-javascript` (recipes live beside the plugins they configure); `scripts/sync-snapshot.mjs --check` here fetches the pinned ref and fails on any difference with `snapshot/` (§6.1 consumer check).
- [ ] **Step 2:** Publishing to `download.bugsee.com` stays with JS issue #186; until then the wizard resolves from the snapshot. Note this in the PR.

---

## Self-review

- **Spec coverage:** G1 Tasks 1–3; G2/G3 Tasks 12–13 (source-map toolchains; framework recipes deferred by D3); G4 Tasks 4, 8, 9; G5 Task 11; G6 Task 11; C6 Task 11; C9/C10 Task 4; C11 Tasks 6, 12; C12 Task 12; C13 Task 14; C14 Task 3; C15 Tasks 5, 13 (depends on JS issue #182); C16 Tasks 10, 12, 13; D5/D6 Tasks 10, 13; §6.1 store Task 10, spec Task 15, publish step deferred to #186; §7 improvements 1–6, 8, 9 Tasks 4–9 and 11; improvement 10 (one version table) Task 12; improvement 7 (cross-platform scripts) Task 8 (`chainInto`); the framework-specific fixes in improvement 11 belong to the later framework round.
- **Known dependencies on other repos:** `.env.bugsee-build-plugin` is only read by the plugins once #182 lands; until then the generated `callArgs` read `process.env.BUGSEE_APP_TOKEN`, which the wizard also documents in CI. The `esbuild`/`rspack` recipes switch from the CLI script to the plugin after #184.
