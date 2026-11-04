import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findWorkspace, resolveDependencyVersion } from '../../src/engine/workspace.js';
import { makeTmp } from './helpers.js';

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir, cleanup } = await makeTmp());
});
afterEach(async () => {
  await cleanup();
});

async function pkg(rel: string, json: Record<string, unknown>): Promise<string> {
  const d = join(dir, rel);
  await mkdir(d, { recursive: true });
  await writeFile(join(d, 'package.json'), JSON.stringify(json));
  return d;
}
const text = (rel: string, body: string) => writeFile(join(dir, rel), body);

const names = (r: { packages: { name: string }[] } | null) =>
  (r?.packages ?? []).map((p) => p.name).sort();

describe('findWorkspace', () => {
  it('lists all three apps of a workspace root and never the root itself', async () => {
    await pkg('.', { name: 'root', private: true, workspaces: ['apps/*'] });
    await pkg('apps/web', { name: 'web' });
    await pkg('apps/admin', { name: 'admin' });
    await pkg('apps/docs', { name: 'docs' });
    const r = await findWorkspace(dir);
    expect(r?.root).toBe(dir);
    expect(names(r)).toEqual(['admin', 'docs', 'web']);
    expect(r?.packages.find((p) => p.name === 'web')?.dir).toBe(join(dir, 'apps', 'web'));
  });

  it('walks up from a nested package to the workspace root', async () => {
    await pkg('.', { name: 'root', workspaces: ['apps/*'] });
    const web = await pkg('apps/web', { name: 'web' });
    const r = await findWorkspace(web);
    expect(r?.root).toBe(dir);
    expect(names(r)).toEqual(['web']);
  });

  it('reads the object form { packages: [] }', async () => {
    await pkg('.', { name: 'root', workspaces: { packages: ['libs/*'] } });
    await pkg('libs/a', { name: 'a' });
    expect(names(await findWorkspace(dir))).toEqual(['a']);
  });

  it('reads pnpm-workspace.yaml with ! exclusions and skips dirs without package.json', async () => {
    await pkg('.', { name: 'root' });
    await text(
      'pnpm-workspace.yaml',
      "packages:\n  - 'apps/*'\n  - 'packages/*'\n  - '!packages/skip'\n",
    );
    await pkg('apps/web', { name: 'web' });
    await pkg('packages/ui', { name: 'ui' });
    await pkg('packages/skip', { name: 'skip' });
    await mkdir(join(dir, 'apps', 'empty'), { recursive: true });
    const r = await findWorkspace(dir);
    expect(names(r)).toEqual(['ui', 'web']);
  });

  it('supports literal paths and a trailing /** best-effort', async () => {
    await pkg('.', { name: 'root', workspaces: ['tools/cli', 'services/**'] });
    await pkg('tools/cli', { name: 'cli' });
    await pkg('services/a', { name: 'a' });
    await pkg('services/deep/b', { name: 'b' });
    expect(names(await findWorkspace(dir))).toEqual(['a', 'b', 'cli']);
  });

  it('skips packages without a name', async () => {
    await pkg('.', { name: 'root', workspaces: ['apps/*'] });
    await pkg('apps/anon', { version: '1.0.0' });
    expect(names(await findWorkspace(dir))).toEqual([]);
  });

  it('never reports the root even when a glob matches it, and ignores node_modules and empty names', async () => {
    await pkg('.', { name: 'root', workspaces: ['.', 'packages/**'] });
    await pkg('packages/a', { name: 'a' });
    await pkg('packages/a/node_modules/dep', { name: 'dep' });
    await pkg('packages/blank', { name: '' });
    expect(names(await findWorkspace(dir))).toEqual(['a']);
  });

  it('returns null when no workspace config exists', async () => {
    await pkg('.', { name: 'solo' });
    expect(await findWorkspace(dir)).toBeNull();
  });

  it('returns null for a package.json that is not valid JSON', async () => {
    await text('package.json', '{nope');
    expect(await findWorkspace(dir)).toBeNull();
  });
});

describe('resolveDependencyVersion', () => {
  it('reads plain ranges from dependencies, devDependencies and peerDependencies', async () => {
    const d = await pkg('.', {
      dependencies: { a: '^1.0.0' },
      devDependencies: { b: '~2.0.0' },
      peerDependencies: { c: '>=3' },
    });
    expect(await resolveDependencyVersion(d, 'a')).toBe('^1.0.0');
    expect(await resolveDependencyVersion(d, 'b')).toBe('~2.0.0');
    expect(await resolveDependencyVersion(d, 'c')).toBe('>=3');
    expect(await resolveDependencyVersion(d, 'zzz')).toBeUndefined();
  });

  it('returns undefined when there is no package.json', async () => {
    expect(await resolveDependencyVersion(dir, 'a')).toBeUndefined();
  });

  it('resolves catalog: and catalog:<name> from pnpm-workspace.yaml', async () => {
    await text(
      'pnpm-workspace.yaml',
      "packages:\n  - 'apps/*'\ncatalog:\n  react: ^18.2.0\ncatalogs:\n  next:\n    react: ^19.0.0\n",
    );
    const d = await pkg('apps/web', {
      dependencies: { react: 'catalog:', 'react-next': 'catalog:next', ghost: 'catalog:' },
      devDependencies: { react19: 'catalog:next' },
    });
    expect(await resolveDependencyVersion(d, 'react')).toBe('^18.2.0');
    expect(await resolveDependencyVersion(d, 'react19')).toBeUndefined(); // no such name in catalog
    expect(await resolveDependencyVersion(d, 'ghost')).toBeUndefined();
  });

  it('resolves a named catalog entry', async () => {
    await text('pnpm-workspace.yaml', 'catalogs:\n  next:\n    react: ^19.0.0\n');
    const d = await pkg('apps/web', { dependencies: { react: 'catalog:next' } });
    expect(await resolveDependencyVersion(d, 'react')).toBe('^19.0.0');
  });

  it('resolves catalog:default from the default catalog', async () => {
    await text('pnpm-workspace.yaml', 'catalog:\n  react: ^18.2.0\n');
    const d = await pkg('apps/web', { dependencies: { react: 'catalog:default' } });
    expect(await resolveDependencyVersion(d, 'react')).toBe('^18.2.0');
  });

  it('returns undefined for catalog: when there is no pnpm-workspace.yaml', async () => {
    const d = await pkg('apps/web', { dependencies: { react: 'catalog:' } });
    expect(await resolveDependencyVersion(d, 'react')).toBeUndefined();
  });

  it.each(['workspace:*', 'workspace:^', 'workspace:~', 'workspace:^1.0.0'])(
    'resolves %s to the target workspace package version',
    async (spec) => {
      await pkg('.', { name: 'root', workspaces: ['packages/*', 'apps/*'] });
      await pkg('packages/ui', { name: '@acme/ui', version: '1.4.2' });
      const app = await pkg('apps/web', { name: 'web', dependencies: { '@acme/ui': spec } });
      expect(await resolveDependencyVersion(app, '@acme/ui')).toBe('1.4.2');
    },
  );

  it('returns undefined when the workspace target does not exist or has no version', async () => {
    await pkg('.', { name: 'root', workspaces: ['packages/*', 'apps/*'] });
    await pkg('packages/nov', { name: 'nov' });
    const app = await pkg('apps/web', {
      name: 'web',
      dependencies: { nov: 'workspace:*', missing: 'workspace:*' },
    });
    expect(await resolveDependencyVersion(app, 'nov')).toBeUndefined();
    expect(await resolveDependencyVersion(app, 'missing')).toBeUndefined();
  });
});
