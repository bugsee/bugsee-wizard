import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findEntry } from '../../src/engine/entry-detect.js';
import { makeTmp } from './helpers.js';

let tmp: Awaited<ReturnType<typeof makeTmp>>;
beforeEach(async () => {
  tmp = await makeTmp();
});
afterEach(() => tmp.cleanup());

async function put(rel: string, content = ''): Promise<void> {
  const abs = join(tmp.dir, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}
const pkg = (data: object): Promise<void> => put('package.json', JSON.stringify(data));

describe('findEntry (browser)', () => {
  it('follows the module script of index.html (root-absolute src, like Vite)', async () => {
    await put(
      'index.html',
      '<html><body><script type="module" src="/src/boot.tsx"></script></body></html>',
    );
    await put('src/boot.tsx');
    await put('src/main.ts');
    expect(await findEntry(tmp.dir, 'browser')).toEqual({
      file: 'src/boot.tsx',
      via: 'index.html',
    });
  });

  it('resolves a relative script src against the html file, ignoring remote and inline scripts', async () => {
    await put(
      'src/index.html',
      '<script src="https://cdn.example.com/a.js"></script><script>inline()</script><script src="./app.js" defer></script>',
    );
    await put('src/app.js');
    expect(await findEntry(tmp.dir, 'browser')).toEqual({
      file: 'src/app.js',
      via: 'src/index.html',
    });
  });

  it('skips an html script that does not exist and falls back to the conventional names', async () => {
    await put('index.html', '<script type="module" src="/src/gone.ts"></script>');
    await put('src/index.jsx');
    expect(await findEntry(tmp.dir, 'browser')).toEqual({
      file: 'src/index.jsx',
      via: 'convention',
    });
  });

  it('prefers src/main over src/index, and ts over js', async () => {
    await put('src/index.ts');
    await put('src/main.js');
    await put('src/main.ts');
    expect(await findEntry(tmp.dir, 'browser')).toEqual({ file: 'src/main.ts', via: 'convention' });
  });

  it('finds root-level main/index and never a declaration file', async () => {
    await put('main.d.ts');
    await put('index.js');
    expect(await findEntry(tmp.dir, 'browser')).toEqual({ file: 'index.js', via: 'convention' });
  });

  it('a script that points outside the package is ignored', async () => {
    await put('index.html', '<script type="module" src="../../etc/x.js"></script>');
    expect(await findEntry(tmp.dir, 'browser')).toBeUndefined();
  });

  it('a script that is not JavaScript or TypeScript is ignored', async () => {
    await put('index.html', '<script src="/data.json"></script>');
    await put('data.json');
    expect(await findEntry(tmp.dir, 'browser')).toBeUndefined();
  });

  it('nothing to go on: undefined', async () => {
    expect(await findEntry(tmp.dir, 'browser')).toBeUndefined();
  });
});

describe('findEntry (node and bun)', () => {
  it.each([
    ['node --env-file=.env src/server.ts', 'src/server.ts'],
    ['tsx watch src/index.ts', 'src/index.ts'],
    ['nodemon --exec ts-node ./src/app.ts', 'src/app.ts'],
    ['bun run --watch src/main.ts', 'src/main.ts'],
    ['NODE_ENV=production node -r dotenv/config lib.js --port 3000', 'lib.js'],
    ['cross-env A=1 node "src/q.mjs"', 'src/q.mjs'],
  ])('reads the entry from the start script: %s', async (cmd, file) => {
    await pkg({ scripts: { start: cmd } });
    await put(file);
    expect(await findEntry(tmp.dir, 'node')).toEqual({ file, via: 'scripts.start' });
  });

  it('start wins over dev, which wins over serve', async () => {
    await pkg({ scripts: { serve: 'node c.js', dev: 'node b.js', start: 'node a.js' } });
    for (const f of ['a.js', 'b.js', 'c.js']) await put(f);
    expect((await findEntry(tmp.dir, 'node'))?.file).toBe('a.js');
    await pkg({ scripts: { serve: 'node c.js', dev: 'node b.js' } });
    expect((await findEntry(tmp.dir, 'node'))?.file).toBe('b.js');
  });

  it('a script naming a missing file is skipped', async () => {
    await pkg({ scripts: { start: 'node nowhere.js' }, main: 'real.js' });
    await put('real.js');
    expect(await findEntry(tmp.dir, 'node')).toEqual({ file: 'real.js', via: 'package.json main' });
  });

  it('maps a build output to its TypeScript source (dist/index.js -> src/index.ts)', async () => {
    await pkg({ scripts: { start: 'node dist/server.js' } });
    await put('src/server.ts');
    expect(await findEntry(tmp.dir, 'node')).toEqual({
      file: 'src/server.ts',
      via: 'scripts.start',
    });
  });

  it('maps build/out/lib outputs too, and mjs/cjs outputs to ts', async () => {
    await pkg({ main: 'build/app.cjs' });
    await put('src/app.ts');
    expect((await findEntry(tmp.dir, 'node'))?.file).toBe('src/app.ts');
    await pkg({ main: 'out/nested/x.mjs' });
    await put('src/nested/x.mts');
    expect((await findEntry(tmp.dir, 'node'))?.file).toBe('src/nested/x.mts');
  });

  it('keeps a build output when it exists and there is no source for it', async () => {
    await pkg({ main: 'dist/index.js' });
    await put('dist/index.js');
    expect((await findEntry(tmp.dir, 'node'))?.file).toBe('dist/index.js');
  });

  it('uses bin (string, then object) after main', async () => {
    await pkg({ bin: 'cli.js' });
    await put('cli.js');
    expect(await findEntry(tmp.dir, 'node')).toEqual({ file: 'cli.js', via: 'package.json bin' });
    await pkg({ bin: { tool: 'bin/tool.js' } });
    await put('bin/tool.js');
    expect((await findEntry(tmp.dir, 'node'))?.file).toBe('bin/tool.js');
  });

  it('bun also reads the package.json module field', async () => {
    await pkg({ module: 'boot.ts' });
    await put('boot.ts');
    expect(await findEntry(tmp.dir, 'bun')).toEqual({
      file: 'boot.ts',
      via: 'package.json module',
    });
    expect(await findEntry(tmp.dir, 'node')).toBeUndefined();
  });

  it('falls back to conventional names; bun prefers a root index.ts, node prefers src/', async () => {
    await put('src/index.ts');
    await put('index.ts');
    expect(await findEntry(tmp.dir, 'bun')).toEqual({ file: 'index.ts', via: 'convention' });
    expect(await findEntry(tmp.dir, 'node')).toEqual({ file: 'src/index.ts', via: 'convention' });
  });

  it('server and app names are found after index and main', async () => {
    await put('server.js');
    expect((await findEntry(tmp.dir, 'node'))?.file).toBe('server.js');
  });

  it('refuses package.json paths that leave the package, even to a file that exists', async () => {
    const pkgDir = join(tmp.dir, 'pkg');
    await put('outside.js', 'run();\n');
    await put(
      'pkg/package.json',
      JSON.stringify({ main: '../outside.js', scripts: { start: 'node ../outside.js' } }),
    );
    expect(await findEntry(pkgDir, 'node')).toBeUndefined();
  });

  it('tolerates an invalid package.json', async () => {
    await put('package.json', '{ not json');
    await put('index.mjs');
    expect((await findEntry(tmp.dir, 'node'))?.file).toBe('index.mjs');
  });

  it('ignores non-string scripts, main and bin values', async () => {
    await pkg({ scripts: { start: 5 }, main: ['x.js'], bin: { a: 1 } });
    expect(await findEntry(tmp.dir, 'node')).toBeUndefined();
  });
});
