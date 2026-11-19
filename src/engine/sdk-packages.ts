/**
 * The npm packages that ARE the Bugsee SDK at run time (the platform builds, the umbrella, the
 * add-ons and the framework adapters). An allow-list, not "anything in the @bugsee scope": the scope
 * also holds build tooling and the wizard itself, and a project that merely depends on those has not
 * set the SDK up. One place, so the file check and the project scan cannot drift apart.
 */
const RUNTIME_SDK_PACKAGES = new Set([
  'bugsee',
  'bun',
  'node',
  'browser',
  'webworker',
  'cloudflare',
  'vercel-edge',
  'electron',
  'webview',
  'replay',
  'replay-canvas',
  'performance',
  'opentelemetry',
  'react',
  'vue',
  'svelte',
  'solid',
  'angular',
  'nextjs',
  'nuxt',
  'remix',
  'sveltekit',
  'astro',
  'express',
  'fastify',
  'nestjs',
  'hono',
  'koa',
  'hapi',
  'elysia',
]);

/** `@bugsee/<name>` with an optional sub-path (`@bugsee/react/provider`), or a bare package name. */
export function isRuntimeSdkPackage(specifier: string | undefined): boolean {
  if (specifier === undefined) return false;
  const m = /^@bugsee\/([\w.-]+)(?:\/.*)?$/.exec(specifier);
  return m?.[1] !== undefined && RUNTIME_SDK_PACKAGES.has(m[1]);
}
