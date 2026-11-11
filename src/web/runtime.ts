import type { WizardOptions } from '../core/context.js';
import type { SdkRuntime } from '../engine/sdk-init-ast.js';
import type { JsDetection } from './detect.js';
import type { Prompts } from './prompts.js';

/** The runtime recipe a run applies, or why none is. */
export type RuntimeChoice = { runtime: SdkRuntime; platform: string } | { skip: string };

const SUPPORTED: readonly SdkRuntime[] = ['browser', 'node', 'bun'];
const LABEL: Record<SdkRuntime, string> = {
  browser: 'browser (a web page)',
  node: 'Node.js',
  bun: 'Bun',
};

function platformFor(runtime: SdkRuntime, det: JsDetection): string {
  // Vite reads VITE_-prefixed variables from .env files, so its browser recipe can keep the token out of the code
  return runtime === 'browser' && det.buildTool === 'vite'
    ? 'javascript-browser-vite'
    : `javascript-${runtime}`;
}

/**
 * Which plain runtime to install and initialise the SDK for. Frameworks and the runtimes without a
 * recipe yet are skipped (the build-tool recipe still runs). A project that is both a web page and a
 * server is a question for the user: a non-interactive run skips rather than guess.
 */
export async function chooseRuntime(
  det: JsDetection,
  opts: WizardOptions,
  prompts: Prompts,
): Promise<RuntimeChoice> {
  if (det.framework !== undefined) {
    return {
      skip: `${det.framework} projects: installing and initialising the SDK for a framework is not automated yet.`,
    };
  }
  const found = SUPPORTED.filter((r) => det.runtimes.includes(r));
  // a front end built with bun as its package manager reports bun too, but runs in the browser
  const candidates =
    found.includes('browser') && !found.includes('node') ? ['browser' as const] : found;
  const [first, ...rest] = candidates;
  if (first === undefined) {
    return {
      skip: `the ${det.runtimes.join(', ')} runtime is not automated yet (only browser, Node.js and Bun are).`,
    };
  }
  if (rest.length === 0) return { runtime: first, platform: platformFor(first, det) };
  // a server on Bun reports node as well: bun is the more specific answer
  if (!candidates.includes('browser') && candidates.includes('bun')) {
    return { runtime: 'bun', platform: platformFor('bun', det) };
  }
  const names = candidates.map((r) => LABEL[r]).join(' and ');
  if (opts.nonInteractive) {
    return {
      skip: `this project runs in both ${names}; choose one by running the wizard interactively.`,
    };
  }
  const answer = await prompts.select(
    'This project runs in several runtimes. Which one should the SDK be set up for?',
    candidates.map((r) => ({ value: r, label: LABEL[r] })),
  );
  const runtime = candidates.find((r) => r === answer) ?? first;
  return { runtime, platform: platformFor(runtime, det) };
}
