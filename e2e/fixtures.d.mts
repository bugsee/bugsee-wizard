export interface Fixture {
  /** The sample a variant is derived from (absent: the fixture is the sample of that name). */
  base?: string;
  /** The fixture is the committed project e2e/fixtures/<name>/, not a bugsee-javascript sample. */
  synthetic?: boolean;
  /** The runtime recipe (SDK install + init) that runs first; null for a framework (not covered yet). */
  runtime: string | null;
  recipe: string;
  route: 'plugin' | 'cli';
  outDir: string | null;
}

export const PINNED_REF: string;
export const FIXTURES: Record<string, Fixture>;
export const BUGSEE_BUILD_SCRIPT_PACKAGES: readonly string[];
export function samplesRepo(ref?: string): { repo: string; ref: string };
export function sdkVersion(): string;
export function prepareFixture(
  name: string,
  dest: string,
  options?: { log?: (message: string) => void; approveBuilds?: boolean },
): string;
export function defaultWorkDir(): string;
