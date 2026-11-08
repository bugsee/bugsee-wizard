import { describe, expect, it } from 'vitest';

import type { JsDetection } from '../../src/web/detect.js';
import { checkSupported, SUPPORTED } from '../../src/web/versions.js';

function det(versions: Record<string, string>): JsDetection {
  return {
    packageDir: '/x',
    packageManager: null,
    runtimes: ['node'],
    typescript: false,
    versions,
    needsPackageChoice: false,
  };
}

describe('SUPPORTED', () => {
  it('lists the documented floors', () => {
    expect(SUPPORTED.next?.min).toBe('14.0.0');
    expect(SUPPORTED.nuxt?.min).toBe('3.7.0');
    expect(SUPPORTED['@sveltejs/kit']?.min).toBe('2.0.0');
    expect(SUPPORTED.astro?.min).toBe('5.0.0');
    expect(SUPPORTED['@remix-run/react']?.min).toBe('2.0.0');
    expect(SUPPORTED['react-router']?.min).toBe('7.0.0');
    expect(SUPPORTED['@angular/core']?.min).toBe('17.0.0');
    expect(SUPPORTED.vite?.min).toBe('5.0.0');
    expect(SUPPORTED.webpack?.min).toBe('5.0.0');
    expect(SUPPORTED.rollup?.min).toBe('4.0.0');
    expect(SUPPORTED.esbuild?.min).toBe('0.20.0');
    expect(SUPPORTED['@rspack/core']?.min).toBe('1.0.0');
    expect(SUPPORTED.node?.min).toBe('22.0.0');
    expect(SUPPORTED.bun?.min).toBe('1.0.0');
    expect(SUPPORTED.deno).toBeUndefined();
  });
});

describe('checkSupported', () => {
  it('is silent when every version meets its floor', () => {
    expect(checkSupported(det({ next: '^14.2.0', vite: '5.4.1', node: '>=22' })).warnings).toEqual(
      [],
    );
  });

  it('warns with the tool, the floor and a docs link when below the minimum', () => {
    const { warnings } = checkSupported(det({ vite: '^4.5.0' }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('vite');
    expect(warnings[0]).toContain('5.0.0');
    expect(warnings[0]).toContain('https://docs.bugsee.com/vite');
  });

  it('uses the lowest version a range allows', () => {
    expect(checkSupported(det({ next: '>=13.5 <16' })).warnings).toHaveLength(1);
    expect(checkSupported(det({ next: '>=14.1 <16' })).warnings).toEqual([]);
  });

  it('treats unparseable and unresolved versions as supported', () => {
    expect(checkSupported(det({ vite: 'latest', next: 'catalog:', astro: 'workspace:*' }))).toEqual(
      {
        warnings: [],
      },
    );
  });

  it('does not treat wildcard ranges (minimum 0.0.0) as too old', () => {
    for (const range of ['*', '>=0', '', 'x', '>=0.0.0']) {
      expect(checkSupported(det({ next: range, node: range })).warnings).toEqual([]);
    }
  });

  it('still warns for a real range that starts at 0.x', () => {
    expect(checkSupported(det({ esbuild: '^0.19.0' })).warnings).toHaveLength(1);
  });

  it('ignores packages without a table entry', () => {
    expect(checkSupported(det({ react: '16.0.0' })).warnings).toEqual([]);
  });

  it('flags webpack 4 as unsupported for auto-edit, once', () => {
    const { warnings } = checkSupported(det({ webpack: '^4.46.0' }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/webpack 4/);
    expect(warnings[0]).toMatch(/auto/i);
    expect(warnings[0]).toContain('https://docs.bugsee.com/webpack');
  });

  it('accepts webpack 5', () => {
    expect(checkSupported(det({ webpack: '5.90.0' })).warnings).toEqual([]);
  });

  it('warns for runtimes below their floor', () => {
    expect(checkSupported(det({ node: '>=18' })).warnings[0]).toContain('node');
    expect(checkSupported(det({ bun: '0.6.0' })).warnings).toHaveLength(1);
  });

  it('reports every offender', () => {
    expect(
      checkSupported(det({ astro: '4.0.0', '@angular/core': '^16.2.0' })).warnings,
    ).toHaveLength(2);
  });
});
