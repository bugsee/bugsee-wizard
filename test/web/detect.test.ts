import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { detectJavaScript } from '../../src/web/detect.js';
import { checkSupported } from '../../src/web/versions.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'js');
const fx = (name: string): string => path.join(FIXTURES, name);

interface Expected {
  runtimes: string[];
  framework?: string;
  buildTool: string;
  typescript: boolean;
  packageManager: string;
}

const CASES: Record<string, Expected> = {
  'vite-react-spa': {
    runtimes: ['browser'],
    buildTool: 'vite',
    typescript: true,
    packageManager: 'npm',
  },
  'webpack-app': {
    runtimes: ['browser'],
    buildTool: 'webpack',
    typescript: false,
    packageManager: 'yarn',
  },
  'rollup-lib': {
    runtimes: ['node'],
    buildTool: 'rollup',
    typescript: false,
    packageManager: 'npm',
  },
  'esbuild-node': {
    runtimes: ['node'],
    buildTool: 'esbuild',
    typescript: false,
    packageManager: 'npm',
  },
  'rspack-app': {
    runtimes: ['browser'],
    buildTool: 'rspack',
    typescript: false,
    packageManager: 'pnpm',
  },
  'tsc-node': { runtimes: ['node'], buildTool: 'tsc', typescript: true, packageManager: 'npm' },
  'angular-spa': {
    runtimes: ['browser'],
    framework: 'angular',
    buildTool: 'cli',
    typescript: true,
    packageManager: 'npm',
  },
  'nextjs-app': {
    runtimes: ['browser', 'node'],
    framework: 'nextjs',
    buildTool: 'webpack',
    typescript: true,
    packageManager: 'npm',
  },
  'nuxt-app': {
    runtimes: ['browser', 'node'],
    framework: 'nuxt',
    buildTool: 'vite',
    typescript: true,
    packageManager: 'pnpm',
  },
  'sveltekit-app': {
    runtimes: ['browser', 'node'],
    framework: 'sveltekit',
    buildTool: 'vite',
    typescript: false,
    packageManager: 'npm',
  },
  'astro-site': {
    runtimes: ['browser', 'node'],
    framework: 'astro',
    buildTool: 'vite',
    typescript: true,
    packageManager: 'npm',
  },
  'electron-app': {
    runtimes: ['electron'],
    framework: 'electron',
    buildTool: 'vite',
    typescript: false,
    packageManager: 'npm',
  },
  'bun-service': {
    runtimes: ['node', 'bun'],
    buildTool: 'tsc',
    typescript: true,
    packageManager: 'bun',
  },
  'deno-app': {
    runtimes: ['node', 'deno'],
    buildTool: 'cli',
    typescript: false,
    packageManager: 'deno',
  },
  'cloudflare-worker': {
    runtimes: ['edge'],
    buildTool: 'tsc',
    typescript: true,
    packageManager: 'npm',
  },
};

describe('detectJavaScript fixtures', () => {
  for (const [name, want] of Object.entries(CASES)) {
    it(`${name}`, async () => {
      const det = await detectJavaScript(fx(name));
      expect(det).not.toBeNull();
      expect(det?.packageDir).toBe(fx(name));
      expect(det?.runtimes).toEqual(want.runtimes);
      expect(det?.framework).toBe(want.framework);
      expect(det?.buildTool).toBe(want.buildTool);
      expect(det?.typescript).toBe(want.typescript);
      expect(det?.packageManager).toBe(want.packageManager);
      expect(det?.needsPackageChoice).toBe(false);
      expect(det?.workspace).toBeUndefined();
    });
  }

  it('records the resolved versions of identifying packages', async () => {
    const det = await detectJavaScript(fx('nextjs-app'));
    expect(det?.versions).toEqual({
      next: '^14.2.5',
      react: '^18.3.1',
      'react-dom': '^18.3.1',
      typescript: '^5.5.0',
      vitest: '^2.0.0',
    });
  });

  it('does not let a stray vite dependency override a framework-owned build tool', async () => {
    // nextjs-app ships vitest, not vite; the angular/next/nuxt tool is fixed by the framework.
    expect((await detectJavaScript(fx('nextjs-app')))?.buildTool).toBe('webpack');
  });

  it('Electron reports only the electron runtime', async () => {
    expect((await detectJavaScript(fx('electron-app')))?.runtimes).toEqual(['electron']);
  });

  it('returns null for a directory with no package.json', async () => {
    expect(await detectJavaScript(fx('non-js'))).toBeNull();
  });

  it('returns null for React Native (the RN recipe owns it)', async () => {
    expect(await detectJavaScript(fx('react-native-app'))).toBeNull();
  });
});

describe('detectJavaScript monorepo', () => {
  it('at the workspace root asks for a package choice and lists the apps', async () => {
    const root = fx('pnpm-monorepo');
    const det = await detectJavaScript(root);
    expect(det?.needsPackageChoice).toBe(true);
    expect(det?.packageDir).toBe(root);
    expect(det?.packageManager).toBe('pnpm');
    expect(det?.workspace?.root).toBe(root);
    expect(det?.workspace?.packages).toEqual([
      { dir: path.join(root, 'apps', 'api'), name: 'api' },
      { dir: path.join(root, 'apps', 'docs'), name: 'docs' },
      { dir: path.join(root, 'apps', 'web'), name: 'web' },
    ]);
    expect(det?.workspace?.packages.some((p) => p.dir === root)).toBe(false);
    expect(det?.framework).toBeUndefined();
  });

  it('inside a workspace package detects that package and keeps the workspace', async () => {
    const dir = path.join(fx('pnpm-monorepo'), 'apps', 'web');
    const det = await detectJavaScript(dir);
    expect(det?.needsPackageChoice).toBe(false);
    expect(det?.packageDir).toBe(dir);
    expect(det?.buildTool).toBe('vite');
    expect(det?.runtimes).toEqual(['browser']);
    expect(det?.packageManager).toBe('pnpm');
    expect(det?.workspace?.root).toBe(fx('pnpm-monorepo'));
    expect(det?.workspace?.packages).toHaveLength(3);
  });

  it('detects the other apps individually', async () => {
    const api = await detectJavaScript(path.join(fx('pnpm-monorepo'), 'apps', 'api'));
    expect(api?.runtimes).toEqual(['node']);
    expect(api?.framework).toBeUndefined();
    const docs = await detectJavaScript(path.join(fx('pnpm-monorepo'), 'apps', 'docs'));
    expect(docs?.framework).toBe('astro');
  });
});

describe('detectJavaScript rules (synthetic projects)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function project(files: Record<string, string | object>): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'bugsee-js-detect-'));
    dirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      const p = path.join(dir, rel);
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, typeof content === 'string' ? content : JSON.stringify(content));
    }
    return dir;
  }

  it('defaults to node when nothing identifies the project', async () => {
    const dir = await project({ 'package.json': { name: 'x' } });
    const det = await detectJavaScript(dir);
    expect(det?.runtimes).toEqual(['node']);
    expect(det?.buildTool).toBe('cli');
    expect(det?.typescript).toBe(false);
    expect(det?.versions).toEqual({});
  });

  it('returns null on malformed package.json', async () => {
    const dir = await project({ 'package.json': '{ nope' });
    expect(await detectJavaScript(dir)).toBeNull();
  });

  it('an edge signal adds edge to a meta-framework', async () => {
    const dir = await project({
      'package.json': { name: 'x', dependencies: { next: '14.0.0' } },
      'wrangler.jsonc': '{}',
    });
    expect((await detectJavaScript(dir))?.runtimes).toEqual(['browser', 'node', 'edge']);
  });

  it('@vercel/edge is an edge signal', async () => {
    const dir = await project({
      'package.json': { name: 'x', dependencies: { '@vercel/edge': '1.0.0' } },
    });
    expect((await detectJavaScript(dir))?.runtimes).toEqual(['edge']);
  });

  it('bun is detected from @types/bun and from bunfig.toml alone', async () => {
    const a = await project({
      'package.json': { name: 'x', devDependencies: { '@types/bun': '1' } },
    });
    expect((await detectJavaScript(a))?.runtimes).toEqual(['node', 'bun']);
    const b = await project({ 'package.json': { name: 'x' }, 'bunfig.toml': '' });
    expect((await detectJavaScript(b))?.runtimes).toEqual(['node', 'bun']);
  });

  it('deno is detected from deno.jsonc', async () => {
    const dir = await project({ 'package.json': { name: 'x' }, 'deno.jsonc': '{}' });
    expect((await detectJavaScript(dir))?.runtimes).toEqual(['node', 'deno']);
  });

  it('a bin field or a server dependency means node alongside a UI library', async () => {
    const dir = await project({
      'package.json': { name: 'x', bin: 'cli.js', dependencies: { react: '18.0.0' } },
    });
    expect((await detectJavaScript(dir))?.runtimes).toEqual(['browser', 'node']);
    const srv = await project({
      'package.json': { name: 'x', dependencies: { react: '18.0.0', express: '4.0.0' } },
    });
    expect((await detectJavaScript(srv))?.runtimes).toEqual(['browser', 'node']);
  });

  it('engines.node alone is node, but does not add node to a UI app', async () => {
    const lib = await project({ 'package.json': { name: 'x', engines: { node: '>=22' } } });
    const det = await detectJavaScript(lib);
    expect(det?.runtimes).toEqual(['node']);
    expect(det?.versions.node).toBe('>=22');
    const ui = await project({
      'package.json': { name: 'x', engines: { node: '>=22' }, dependencies: { vue: '3.4.0' } },
    });
    expect((await detectJavaScript(ui))?.runtimes).toEqual(['browser']);
  });

  it('a bundler with an index.html under src/ is a browser project; without one it is not', async () => {
    const withHtml = await project({
      'package.json': { name: 'x', devDependencies: { esbuild: '0.21.0' } },
      'src/index.html': '<html></html>',
    });
    expect((await detectJavaScript(withHtml))?.runtimes).toEqual(['browser']);
    const without = await project({
      'package.json': { name: 'x', devDependencies: { esbuild: '0.21.0' } },
    });
    expect((await detectJavaScript(without))?.runtimes).toEqual(['node']);
  });

  it('a vite.config file selects vite even without the dependency; webpack/rollup/rspack configs likewise', async () => {
    for (const [file, tool] of [
      ['vite.config.mts', 'vite'],
      ['rspack.config.ts', 'rspack'],
      ['webpack.config.cjs', 'webpack'],
      ['rollup.config.js', 'rollup'],
    ] as const) {
      const dir = await project({ 'package.json': { name: 'x' }, [file]: '' });
      expect((await detectJavaScript(dir))?.buildTool).toBe(tool);
    }
  });

  it('prefers vite over webpack/rollup when several are present', async () => {
    const dir = await project({
      'package.json': {
        name: 'x',
        devDependencies: { webpack: '5.0.0', rollup: '4.0.0', vite: '5.0.0' },
      },
    });
    expect((await detectJavaScript(dir))?.buildTool).toBe('vite');
  });

  it('remix is detected from @remix-run/* or react-router', async () => {
    const a = await project({
      'package.json': { name: 'x', dependencies: { '@remix-run/node': '2.0.0' } },
    });
    const da = await detectJavaScript(a);
    expect(da?.framework).toBe('remix');
    expect(da?.versions['@remix-run/node']).toBe('2.0.0');
    const b = await project({
      'package.json': { name: 'x', dependencies: { 'react-router': '7.0.0' } },
    });
    expect((await detectJavaScript(b))?.framework).toBe('remix');
  });

  it('typescript comes from a tsconfig.json alone', async () => {
    const dir = await project({ 'package.json': { name: 'x' }, 'tsconfig.json': '{}' });
    expect((await detectJavaScript(dir))?.typescript).toBe(true);
  });

  it('a workspace root with its own app dependencies is a normal project', async () => {
    const dir = await project({
      'package.json': {
        name: 'root',
        workspaces: ['packages/*'],
        dependencies: { express: '4.0.0' },
      },
      'packages/a/package.json': { name: 'a' },
    });
    const det = await detectJavaScript(dir);
    expect(det?.needsPackageChoice).toBe(false);
    expect(det?.runtimes).toEqual(['node']);
    expect(det?.workspace?.packages).toEqual([{ dir: path.join(dir, 'packages', 'a'), name: 'a' }]);
  });

  it('an empty workspace root is not a package choice', async () => {
    const dir = await project({ 'package.json': { name: 'root', workspaces: ['packages/*'] } });
    const det = await detectJavaScript(dir);
    expect(det?.needsPackageChoice).toBe(false);
  });

  it('a package.json beside (not inside) an unrelated workspace is standalone', async () => {
    const dir = await project({
      'package.json': { name: 'root', workspaces: ['packages/*'] },
      'packages/a/package.json': { name: 'a' },
      'other/package.json': { name: 'other', dependencies: { express: '4.0.0' } },
    });
    const det = await detectJavaScript(path.join(dir, 'other'));
    expect(det?.workspace).toBeUndefined();
    expect(det?.needsPackageChoice).toBe(false);
  });

  it('detection returns the version of a below-minimum tool and the check warns', async () => {
    const dir = await project({
      'package.json': { name: 'x', devDependencies: { vite: '^4.5.0' } },
    });
    const det = await detectJavaScript(dir);
    expect(det?.buildTool).toBe('vite');
    expect(det).not.toBeNull();
    if (det) expect(checkSupported(det).warnings).toHaveLength(1);
  });

  it('webpack 4 is detected and flagged as unsupported for auto-edit', async () => {
    const dir = await project({
      'package.json': { name: 'x', devDependencies: { webpack: '^4.46.0' } },
    });
    const det = await detectJavaScript(dir);
    expect(det?.buildTool).toBe('webpack');
    if (det) expect(checkSupported(det).warnings[0]).toMatch(/webpack 4/);
  });

  it('a workspace root with only tooling (typescript, vitest) is still a package choice', async () => {
    const dir = await project({
      'package.json': {
        name: 'root',
        workspaces: ['packages/*'],
        devDependencies: { typescript: '5.5.0', vitest: '2.0.0' },
      },
      'packages/a/package.json': { name: 'a' },
    });
    expect((await detectJavaScript(dir))?.needsPackageChoice).toBe(true);
  });

  it('the typescript dependency alone (no tsconfig) is typescript but not a tsc build', async () => {
    const dir = await project({
      'package.json': { name: 'x', devDependencies: { typescript: '5.5.0' } },
    });
    const det = await detectJavaScript(dir);
    expect(det?.typescript).toBe(true);
    expect(det?.buildTool).toBe('cli');
  });

  it('vite wins over rspack when both are present', async () => {
    const dir = await project({
      'package.json': { name: 'x', devDependencies: { '@rspack/core': '1.0.0', vite: '5.0.0' } },
    });
    expect((await detectJavaScript(dir))?.buildTool).toBe('vite');
  });

  it('bun is detected from a lockfile in the workspace root above the package', async () => {
    const dir = await project({
      'package.json': { name: 'root', workspaces: ['packages/*'] },
      'bun.lock': '{}',
      'packages/a/package.json': { name: 'a' },
    });
    expect((await detectJavaScript(path.join(dir, 'packages', 'a')))?.runtimes).toEqual([
      'node',
      'bun',
    ]);
  });

  it('bun or deno alongside a UI library or an edge target does not add node', async () => {
    const ui = await project({
      'package.json': { name: 'x', dependencies: { react: '18.0.0' } },
      'bunfig.toml': '',
    });
    expect((await detectJavaScript(ui))?.runtimes).toEqual(['browser', 'bun']);
    const edge = await project({
      'package.json': { name: 'x' },
      'deno.json': '{}',
      'wrangler.toml': '',
    });
    expect((await detectJavaScript(edge))?.runtimes).toEqual(['deno', 'edge']);
  });

  it('never executes or imports user files', async () => {
    const dir = await project({
      'package.json': { name: 'x', devDependencies: { vite: '5.0.0' } },
      'vite.config.js': "throw new Error('executed');",
    });
    await expect(detectJavaScript(dir)).resolves.toMatchObject({ buildTool: 'vite' });
  });
});
