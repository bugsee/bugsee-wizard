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

  it('returns null for the non-js fixture (requirements.txt: no walk-up into the repo package.json)', async () => {
    expect(await detectJavaScript(fx('non-js'))).toBeNull();
  });

  it('returns null for a directory with no package.json anywhere up the tree', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bugsee-js-nonjs-'));
    try {
      await writeFile(path.join(dir, 'requirements.txt'), 'flask\n');
      expect(await detectJavaScript(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a deno.json-only project is not a supported JavaScript project (Deno support was dropped)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bugsee-js-deno-'));
    try {
      await writeFile(path.join(dir, 'deno.json'), '{}');
      await writeFile(path.join(dir, 'deno.lock'), '{}');
      expect(await detectJavaScript(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('walks up from a subdirectory to the nearest package.json and reports startedIn', async () => {
    const start = path.join(fx('pnpm-monorepo'), 'apps', 'web', 'src');
    const det = await detectJavaScript(start);
    expect(det?.packageDir).toBe(path.join(fx('pnpm-monorepo'), 'apps', 'web'));
    expect(det?.startedIn).toBe(start);
    expect(det?.buildTool).toBe('vite');
    expect(det?.workspace?.root).toBe(fx('pnpm-monorepo'));
  });

  it('does not set startedIn when cwd itself is the project', async () => {
    expect((await detectJavaScript(fx('vite-react-spa')))?.startedIn).toBeUndefined();
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

  it('deno files add no runtime: a package.json project stays node', async () => {
    const dir = await project({ 'package.json': { name: 'x' }, 'deno.jsonc': '{}' });
    expect((await detectJavaScript(dir))?.runtimes).toEqual(['node']);
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

  it('bun alongside a UI library does not add node', async () => {
    const ui = await project({
      'package.json': { name: 'x', dependencies: { react: '18.0.0' } },
      'bunfig.toml': '',
    });
    expect((await detectJavaScript(ui))?.runtimes).toEqual(['browser', 'bun']);
  });

  it('a tooling-only workspace root (vite, typescript, rollup, esbuild) is a package choice', async () => {
    const dir = await project({
      'package.json': {
        name: 'root',
        workspaces: ['apps/*', 'packages/*'],
        devDependencies: { vite: '5.0.0', typescript: '5.5.0', rollup: '4.0.0', esbuild: '0.21.0' },
      },
      'apps/a/package.json': { name: 'a' },
    });
    const det = await detectJavaScript(dir);
    expect(det?.needsPackageChoice).toBe(true);
    expect(det?.buildTool).toBeUndefined();
    expect(det?.workspace?.root).toBe(dir);
  });

  it('a workspace root with react in dependencies is an app', async () => {
    const dir = await project({
      'package.json': {
        name: 'root',
        workspaces: ['packages/*'],
        dependencies: { react: '18.0.0' },
        devDependencies: { vite: '5.0.0' },
      },
      'packages/a/package.json': { name: 'a' },
    });
    const det = await detectJavaScript(dir);
    expect(det?.needsPackageChoice).toBe(false);
    expect(det?.buildTool).toBe('vite');
  });

  it('a workspace root with a framework or server dep is an app', async () => {
    for (const dep of ['next', 'express', 'electron']) {
      const dir = await project({
        'package.json': {
          name: 'root',
          workspaces: ['packages/*'],
          devDependencies: { [dep]: '1.0.0' },
        },
        'packages/a/package.json': { name: 'a' },
      });
      expect((await detectJavaScript(dir))?.needsPackageChoice).toBe(false);
    }
  });

  it('hoisted react in devDependencies makes the root an app only with an index.html entry', async () => {
    const files = {
      'package.json': {
        name: 'root',
        workspaces: ['packages/*'],
        devDependencies: { react: '18.0.0' },
      },
      'packages/a/package.json': { name: 'a' },
    };
    const tooling = await project(files);
    expect((await detectJavaScript(tooling))?.needsPackageChoice).toBe(true);
    const app = await project({ ...files, 'index.html': '<html></html>' });
    expect((await detectJavaScript(app))?.needsPackageChoice).toBe(false);
    const srcApp = await project({ ...files, 'src/index.html': '<html></html>' });
    expect((await detectJavaScript(srcApp))?.needsPackageChoice).toBe(false);
  });

  it('walks up at most 10 levels', async () => {
    const dir = await project({ 'package.json': { name: 'x' } });
    const deep = (n: number): string =>
      path.join(dir, ...Array.from({ length: n }, (_, i) => `d${i}`));
    await mkdir(deep(10), { recursive: true });
    expect((await detectJavaScript(deep(10)))?.packageDir).toBe(dir);
    await mkdir(deep(11), { recursive: true });
    expect(await detectJavaScript(deep(11))).toBeNull();
  });

  it('stops at the first project: a malformed package.json is not skipped for a parent', async () => {
    const dir = await project({
      'package.json': { name: 'parent', dependencies: { express: '4.0.0' } },
      'sub/package.json': '{ nope',
    });
    expect(await detectJavaScript(path.join(dir, 'sub'))).toBeNull();
  });

  it('stops at a react-native package instead of walking to a parent project', async () => {
    const dir = await project({
      'package.json': { name: 'parent' },
      'rn/package.json': { name: 'rn', dependencies: { 'react-native': '0.74.0' } },
      'rn/src/index.js': '',
    });
    expect(await detectJavaScript(path.join(dir, 'rn', 'src'))).toBeNull();
  });

  it.each([
    ['MinimalApp.xcodeproj/project.pbxproj'],
    ['App.xcworkspace/contents.xcworkspacedata'],
    ['build.gradle'],
    ['build.gradle.kts'],
    ['settings.gradle'],
    ['settings.gradle.kts'],
    ['Podfile'],
    ['pubspec.yaml'],
    ['Cargo.toml'],
    ['go.mod'],
    ['pyproject.toml'],
    ['requirements.txt'],
  ])(
    'does not walk up from a directory holding native/other-language marker %s',
    async (marker) => {
      const dir = await project({
        'package.json': { name: 'parent', devDependencies: { vite: '5.0.0' } },
        [`app/${marker}`]: '',
      });
      expect(await detectJavaScript(path.join(dir, 'app'))).toBeNull();
    },
  );

  it('still detects a project that holds its own package.json beside a native marker', async () => {
    const dir = await project({ 'package.json': { name: 'x' }, Podfile: '' });
    expect((await detectJavaScript(dir))?.packageDir).toBe(dir);
  });

  it('stops at the git root: a package.json above it is ignored', async () => {
    const dir = await project({
      'package.json': { name: 'outer' },
      'repo/.git/HEAD': 'ref: refs/heads/main',
      'repo/sub/deep/file.txt': '',
    });
    expect(await detectJavaScript(path.join(dir, 'repo', 'sub', 'deep'))).toBeNull();
  });

  it('examines the directory that holds .git before stopping', async () => {
    const dir = await project({
      'repo/.git/HEAD': 'x',
      'repo/package.json': { name: 'root' },
      'repo/sub/file.txt': '',
    });
    const det = await detectJavaScript(path.join(dir, 'repo', 'sub'));
    expect(det?.packageDir).toBe(path.join(dir, 'repo'));
  });

  it('the git probe is injectable', async () => {
    const dir = await project({ 'package.json': { name: 'outer' }, 'a/b/file.txt': '' });
    const start = path.join(dir, 'a', 'b');
    expect(
      await detectJavaScript(start, { hasGit: async (d) => d === path.join(dir, 'a') }),
    ).toBeNull();
    expect((await detectJavaScript(start, { hasGit: async () => false }))?.packageDir).toBe(dir);
  });

  it('never accepts the home directory (or anything above it) as the package dir when walking up', async () => {
    const dir = await project({
      'home/package.json': { name: 'home-pkg' },
      'home/proj/src/file.txt': '',
      'package.json': { name: 'above-home' },
    });
    const home = path.join(dir, 'home');
    expect(await detectJavaScript(path.join(home, 'proj', 'src'), { homeDir: home })).toBeNull();
    // cwd itself being a project is always fine, even when it is the home directory
    expect((await detectJavaScript(home, { homeDir: home }))?.packageDir).toBe(home);
    // without the injection the home package is a normal walk-up target
    expect(
      (await detectJavaScript(path.join(home, 'proj', 'src'), { homeDir: '/nonexistent' }))
        ?.packageDir,
    ).toBe(home);
  });

  it('never examines the filesystem root when walking up (injectable root)', async () => {
    const dir = await project({
      'fakeroot/package.json': { name: 'root-pkg' },
      'fakeroot/a/b/file.txt': '',
    });
    const root = path.join(dir, 'fakeroot');
    const start = path.join(root, 'a', 'b');
    expect(await detectJavaScript(start, { rootDir: root })).toBeNull();
    // a project strictly below the root is still found
    await writeFile(path.join(root, 'a', 'package.json'), JSON.stringify({ name: 'a' }));
    expect((await detectJavaScript(start, { rootDir: root }))?.packageDir).toBe(
      path.join(root, 'a'),
    );
    // the same tree without the injection treats fakeroot as an ordinary directory
    await rm(path.join(root, 'a', 'package.json'));
    expect((await detectJavaScript(start))?.packageDir).toBe(root);
  });

  it('a cwd that is itself the root still checks only cwd', async () => {
    const dir = await project({ 'fakeroot/package.json': { name: 'root-pkg' } });
    const root = path.join(dir, 'fakeroot');
    expect((await detectJavaScript(root, { rootDir: root }))?.packageDir).toBe(root);
  });

  it('never executes or imports user files', async () => {
    const dir = await project({
      'package.json': { name: 'x', devDependencies: { vite: '5.0.0' } },
      'vite.config.js': "throw new Error('executed');",
    });
    await expect(detectJavaScript(dir)).resolves.toMatchObject({ buildTool: 'vite' });
  });

  describe('runtime signals', () => {
    it('no signal at all is flagged: node stays the reported runtime but the guess is marked', async () => {
      const det = await detectJavaScript(await project({ 'package.json': { name: 'x' } }));
      expect(det?.runtimes).toEqual(['node']);
      expect(det?.runtimeUnknown).toBe(true);
    });

    it('a real signal is not flagged', async () => {
      const det = await detectJavaScript(
        await project({ 'package.json': { name: 'x', engines: { node: '>=22' } } }),
      );
      expect(det?.runtimeUnknown).toBeUndefined();
    });

    it.each([
      ['public/index.html'],
      ['index.html'],
      ['src/index.html'],
      ['public/app.html'],
      ['src/pages/home.html'],
    ])('a bundled project with %s is a browser app', async (html) => {
      const det = await detectJavaScript(
        await project({
          'package.json': { name: 'x', devDependencies: { webpack: '5.0.0' } },
          [html]: '<html></html>',
        }),
      );
      expect(det?.runtimes).toEqual(['browser']);
      expect(det?.runtimeUnknown).toBeUndefined();
    });

    it.each([['@bugsee/browser'], ['@bugsee/replay'], ['@bugsee/replay-canvas']])(
      'a dependency on %s (a browser-only package) is a browser signal, even with a node dev script',
      async (dep) => {
        const det = await detectJavaScript(
          await project({
            'package.json': {
              name: 'x',
              scripts: { dev: 'node esbuild.config.mjs --watch' },
              dependencies: { [dep]: 'beta' },
              devDependencies: { esbuild: '0.20.0' },
            },
          }),
        );
        expect(det?.runtimes).toEqual(['browser']);
      },
    );
  });

  describe('bundled browser apps are never Node (type / engines.node are not server signals)', () => {
    const wp = { webpack: '5', 'webpack-cli': '5' };

    it('webpack + html-webpack-plugin + "type": no html file on disk, still a browser app', async () => {
      const det = await detectJavaScript(
        await project({
          'package.json': {
            name: 'a',
            type: 'module',
            devDependencies: { ...wp, 'html-webpack-plugin': '5' },
          },
          'src/index.ts': 'x();',
        }),
      );
      expect(det?.runtimes).toEqual(['browser']);
    });

    it('webpack + engines.node + static/index.html: the html under static/ is found', async () => {
      const det = await detectJavaScript(
        await project({
          'package.json': { name: 'a', engines: { node: '>=18' }, devDependencies: wp },
          'static/index.html': '<html></html>',
        }),
      );
      expect(det?.runtimes).toEqual(['browser']);
    });

    it.each([
      ['HtmlWebpackPlugin', 'new HtmlWebpackPlugin()', 'webpack.config.js'],
      ['HtmlRspackPlugin', 'new rspack.HtmlRspackPlugin()', 'rspack.config.js'],
      ['target web', "target: 'web'", 'webpack.config.js'],
    ])(
      'a bundler config that says it builds for a page (%s) is a browser signal',
      async (_n, text, file) => {
        const dep = file.startsWith('rspack') ? { '@rspack/core': '1' } : { webpack: '5' };
        const det = await detectJavaScript(
          await project({
            'package.json': { name: 'a', type: 'module', devDependencies: dep },
            [file]: `export default { plugins: [${text}] };`,
          }),
        );
        expect(det?.runtimes).toEqual(['browser']);
      },
    );

    it.each([['webpack-dev-server'], ['parcel'], ['css-loader'], ['mini-css-extract-plugin']])(
      'a dependency on %s (page tooling) is a browser signal',
      async (dep) => {
        const det = await detectJavaScript(
          await project({
            'package.json': {
              name: 'a',
              type: 'module',
              devDependencies: { webpack: '5', [dep]: '1' },
            },
          }),
        );
        expect(det?.runtimes).toEqual(['browser']);
      },
    );

    it('a bundler with nothing but "type" or engines.node says nothing: unknown, not node', async () => {
      for (const extra of [{ type: 'module' }, { engines: { node: '>=20' } }]) {
        const det = await detectJavaScript(
          await project({ 'package.json': { name: 'a', ...extra, devDependencies: wp } }),
        );
        expect(det?.runtimeUnknown).toBe(true);
      }
    });

    it('a real server dependency next to the bundler still means node', async () => {
      const det = await detectJavaScript(
        await project({
          'package.json': { name: 'a', dependencies: { express: '4' }, devDependencies: wp },
        }),
      );
      expect(det?.runtimes).toEqual(['node']);
    });

    it('without a bundler, type / engines.node still mark a Node project', async () => {
      const det = await detectJavaScript(
        await project({ 'package.json': { name: 'a', type: 'module', engines: { node: '>=20' } } }),
      );
      expect(det?.runtimes).toEqual(['node']);
      expect(det?.runtimeUnknown).toBeUndefined();
    });
  });
});
