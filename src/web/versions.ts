import semver from 'semver';

import type { JsDetection } from './detect.js';

/**
 * The supported-version table (one place). Keys are the package names that identify a tool;
 * `node` / `bun` / `deno` are runtime floors. `min` is the lowest supported version.
 */
export const SUPPORTED: Record<string, { min: string; note?: string }> = {
  next: { min: '14.0.0', note: 'App and Pages Router' },
  nuxt: { min: '3.7.0', note: 'Nuxt 3.7+ and 4' },
  '@sveltejs/kit': { min: '2.0.0' },
  astro: { min: '5.0.0' },
  '@remix-run/react': { min: '2.0.0' },
  'react-router': { min: '7.0.0' },
  '@angular/core': { min: '17.0.0', note: 'standalone' },
  vite: { min: '5.0.0' },
  webpack: { min: '5.0.0', note: 'webpack 4 is detected but not auto-edited' },
  rollup: { min: '4.0.0' },
  esbuild: { min: '0.20.0' },
  '@rspack/core': { min: '1.0.0' },
  node: { min: '22.0.0' },
  bun: { min: '1.0.0' },
  deno: { min: '2.0.0' },
};

/** Display name and docs slug per table key (docs links are placeholders until a real table exists). */
const TOOLS: Record<string, { name: string; slug: string }> = {
  next: { name: 'Next.js', slug: 'nextjs' },
  nuxt: { name: 'Nuxt', slug: 'nuxt' },
  '@sveltejs/kit': { name: 'SvelteKit', slug: 'sveltekit' },
  astro: { name: 'Astro', slug: 'astro' },
  '@remix-run/react': { name: 'Remix', slug: 'remix' },
  'react-router': { name: 'React Router', slug: 'react-router' },
  '@angular/core': { name: 'Angular', slug: 'angular' },
  vite: { name: 'vite', slug: 'vite' },
  webpack: { name: 'webpack', slug: 'webpack' },
  rollup: { name: 'rollup', slug: 'rollup' },
  esbuild: { name: 'esbuild', slug: 'esbuild' },
  '@rspack/core': { name: 'rspack', slug: 'rspack' },
  node: { name: 'node', slug: 'node' },
  bun: { name: 'bun', slug: 'bun' },
  deno: { name: 'deno', slug: 'deno' },
};

const DOCS = 'https://docs.bugsee.com/';

/** Lowest version a range allows, or null when it is not a parseable range (catalog:, latest, ...). */
function lowest(range: string): semver.SemVer | null {
  try {
    const min = semver.minVersion(range);
    // A wildcard (`*`, `>=0`, ...) bottoms out at 0.0.0: that is "any version", not "too old".
    return min?.version === '0.0.0' ? null : min;
  } catch {
    return null;
  }
}

/** Warnings for detected tools older than the supported floor; unparseable versions pass. */
export function checkSupported(det: JsDetection): { warnings: string[] } {
  const warnings: string[] = [];
  for (const [pkg, range] of Object.entries(det.versions)) {
    const entry = SUPPORTED[pkg];
    const tool = TOOLS[pkg];
    if (!entry || !tool) continue;
    const found = lowest(range);
    if (!found || semver.gte(found, entry.min)) continue;
    const docs = `${DOCS}${tool.slug}`;
    if (pkg === 'webpack' && found.major === 4) {
      warnings.push(
        `webpack 4 is detected: Bugsee cannot edit its config automatically. Follow the manual steps at ${docs}`,
      );
    } else {
      warnings.push(
        `${tool.name} ${range} is older than the supported ${entry.min}; setup may not work. See ${docs}`,
      );
    }
  }
  return { warnings };
}
