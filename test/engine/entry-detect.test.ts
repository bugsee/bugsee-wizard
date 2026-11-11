import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findEntry, hasViteClientTypes } from '../../src/engine/entry-detect.js';
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
      '<script src="https://cdn.example.com/a.js"></script><script>inline()</script><script type="module" src="./app.js" defer></script>',
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

  it('prefers ts over js of the same name', async () => {
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

  it('never picks generated output, even when it exists and has no source to map to', async () => {
    await pkg({ main: 'dist/index.js', scripts: { start: 'node build/server.js' } });
    await put('dist/index.js');
    await put('build/server.js');
    expect(await findEntry(tmp.dir, 'node')).toBeUndefined();
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

  it('conventional names: a single candidate is used; several different ones are ambiguous (no guess)', async () => {
    await put('index.ts');
    expect(await findEntry(tmp.dir, 'bun')).toEqual({ file: 'index.ts', via: 'convention' });
    expect(await findEntry(tmp.dir, 'node')).toEqual({ file: 'index.ts', via: 'convention' });
    await put('src/index.ts');
    expect(await findEntry(tmp.dir, 'bun')).toBeUndefined();
    expect(await findEntry(tmp.dir, 'node')).toBeUndefined();
    expect(await findEntry(tmp.dir, 'browser')).toBeUndefined();
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

describe('findEntry (review follow-ups)', () => {
  it('only a module script of index.html is an entry (a classic script cannot take an import)', async () => {
    await put('index.html', '<script src="/src/classic.js"></script>');
    await put('src/classic.js');
    expect(await findEntry(tmp.dir, 'browser')).toBeUndefined();
    await put(
      'index.html',
      '<script src="/src/classic.js"></script><script type="module" src="/src/app.js"></script>',
    );
    await put('src/app.js');
    expect(await findEntry(tmp.dir, 'browser')).toEqual({ file: 'src/app.js', via: 'index.html' });
  });

  it('never picks generated output: a build-dir script maps to its source or is skipped', async () => {
    await put('index.html', '<script type="module" src="dist/bundle.js"></script>');
    await put('dist/bundle.js');
    await put('src/index.js');
    expect(await findEntry(tmp.dir, 'browser')).toEqual({
      file: 'src/index.js',
      via: 'convention',
    });
    await put('index.html', '<script type="module" src="dist/main.js"></script>');
    await put('dist/main.js');
    await put('src/main.ts');
    expect(await findEntry(tmp.dir, 'browser')).toEqual({ file: 'src/main.ts', via: 'index.html' });
  });

  it('a flag value is not the entry (--import ./register.mjs)', async () => {
    await pkg({ scripts: { start: 'node --import ./register.mjs src/app.mjs' } });
    await put('register.mjs');
    await put('src/app.mjs');
    expect((await findEntry(tmp.dir, 'node'))?.file).toBe('src/app.mjs');
    await pkg({ scripts: { start: 'node -r ./pre.cjs --env-file .env.local server.js' } });
    await put('pre.cjs');
    await put('server.js');
    expect((await findEntry(tmp.dir, 'node'))?.file).toBe('server.js');
  });

  it('in a chained command the last command is the app', async () => {
    await pkg({ scripts: { start: 'node scripts/migrate.js && node src/server.js' } });
    await put('scripts/migrate.js');
    await put('src/server.js');
    expect((await findEntry(tmp.dir, 'node'))?.file).toBe('src/server.js');
    await pkg({ scripts: { start: 'node a.js; node b.js | tee log' } });
    await put('a.js');
    await put('b.js');
    expect((await findEntry(tmp.dir, 'node'))?.file).toBe('b.js');
  });

  it('Vite client types are found in tsconfig.app.json and other tsconfig.*.json files', async () => {
    expect(await hasViteClientTypes(tmp.dir)).toBe(false);
    await put(
      'tsconfig.json',
      '{ "files": [], "references": [{ "path": "./tsconfig.app.json" }] }',
    );
    await put('tsconfig.app.json', '{ "compilerOptions": { "types": ["vite/client"] } }');
    expect(await hasViteClientTypes(tmp.dir)).toBe(true);
  });

  it('only the last command of a chain is the app: an unresolved one does not fall back to an earlier one', async () => {
    await pkg({ scripts: { start: 'node scripts/migrate.js && node dist/server.js' } });
    await put('scripts/migrate.js');
    expect(await findEntry(tmp.dir, 'node')).toBeUndefined();
    await pkg({
      scripts: { start: 'node scripts/migrate.js && node dist/server.js | tee log' },
      main: 'real.js',
    });
    await put('real.js');
    expect(await findEntry(tmp.dir, 'node')).toEqual({ file: 'real.js', via: 'package.json main' });
  });

  describe('what is not an app entry', () => {
    const cases: Array<[string, string[], string | undefined]> = [
      ['pm2 start ecosystem.config.js', ['ecosystem.config.js'], undefined],
      ['rollup -c rollup.config.mjs -w', ['rollup.config.mjs'], undefined],
      ['webpack serve --config webpack.config.js', ['webpack.config.js'], undefined],
      [
        'vite-node --config vite.config.ts src/main.ts',
        ['vite.config.ts', 'src/main.ts'],
        'src/main.ts',
      ],
      ['node --test test/a.test.js', ['test/a.test.js'], undefined],
      ['node --test-reporter spec --test test/a.test.js', ['test/a.test.js'], undefined],
      ['node src/server.test.js', ['src/server.test.js'], undefined],
      ['node tests/run.js', ['tests/run.js'], undefined],
      ['node __tests__/x.js', ['__tests__/x.js'], undefined],
      ['jest src/a.spec.ts', ['src/a.spec.ts'], undefined],
      [
        'tsc -p tsconfig.json && node dist/index.js',
        ['dist/index.js', 'src/index.ts'],
        'src/index.ts',
      ],
      // esbuild is a tool, not a runner: the script says nothing, the one conventional file does
      ['esbuild src/index.ts --bundle --outfile=dist/out.js', ['src/index.ts'], 'src/index.ts'],
      ['tsx watch --tsconfig tsconfig.dev.json src/index.ts', ['src/index.ts'], 'src/index.ts'],
      ['npx tsx src/main.ts', ['src/main.ts'], 'src/main.ts'],
      ['bun run --hot src/main.ts', ['src/main.ts'], 'src/main.ts'],
      ['nodemon -c nodemon.json src/app.js', ['src/app.js'], 'src/app.js'],
      // a tool, not a runner: its file arguments are input, not the app (the convention decides)
      ['esbuild src/other.ts --bundle', ['src/other.ts', 'src/index.ts'], 'src/index.ts'],
      ['node --test checks/a.js', ['checks/a.js'], undefined],
    ];
    it.each(cases)('%s', async (command, files, expected) => {
      await pkg({ scripts: { start: command } });
      for (const f of files) await put(f);
      const found = await findEntry(tmp.dir, 'node');
      expect(found?.file).toBe(expected);
    });

    it('package.json main pointing at a config or test file is not an entry either', async () => {
      await pkg({ main: 'vite.config.ts' });
      await put('vite.config.ts');
      expect(await findEntry(tmp.dir, 'node')).toBeUndefined();
    });

    it('conventional candidates exclude config and test names', async () => {
      await put('index.config.js');
      await put('index.test.js');
      expect(await findEntry(tmp.dir, 'node')).toBeUndefined();
    });
  });

  describe('index.html scripts', () => {
    it('ignores commented-out scripts', async () => {
      await put(
        'index.html',
        '<!-- <script type="module" src="/src/old.ts"></script> --><script type="module" src="/src/main.ts"></script>',
      );
      await put('src/old.ts');
      await put('src/main.ts');
      expect((await findEntry(tmp.dir, 'browser'))?.file).toBe('src/main.ts');
    });

    it('an unterminated comment hides the rest of the page, like a browser', async () => {
      await put(
        'index.html',
        '<script type="module" src="/src/a.ts"></script><!-- <script type="module" src="/src/b.ts"></script>',
      );
      await put('src/a.ts');
      await put('src/b.ts');
      expect((await findEntry(tmp.dir, 'browser'))?.file).toBe('src/a.ts');
      await put('index.html', '<!-- never closed <script type="module" src="/src/b.ts"></script>');
      expect(await findEntry(tmp.dir, 'browser')).toBeUndefined();
    });

    it('text left over from one comment never forms another (no re-scan of the result)', async () => {
      await put('index.html', '<!<!-- x -->-- <script type="module" src="/src/b.ts"></script> -->');
      await put('src/b.ts');
      expect((await findEntry(tmp.dir, 'browser'))?.file).toBe('src/b.ts');
    });

    it.each([
      ['import "./src/app.ts";'],
      ["import './src/app.ts'"],
      ["import { start } from '/src/app.ts'; start();"],
      ['  import  app  from  "./src/app.ts"'],
    ])('follows an inline module script (%s) to the file it imports', async (body) => {
      await put('index.html', `<script type="module">${body}</script>`);
      await put('src/app.ts');
      await put('src/main.ts');
      expect(await findEntry(tmp.dir, 'browser')).toEqual({
        file: 'src/app.ts',
        via: 'index.html',
      });
    });

    it('an inline module script that imports only packages, or nothing local, is not an entry', async () => {
      await put('index.html', '<script type="module">import "lit"; console.log(1)</script>');
      await put('src/main.ts');
      expect(await findEntry(tmp.dir, 'browser')).toEqual({
        file: 'src/main.ts',
        via: 'convention',
      });
    });

    it('a closing tag with stray attributes or whitespace still closes the script', async () => {
      await put(
        'index.html',
        '<script type="module">import "./src/a.ts"</script\t\n bar><script type="module" src="/src/b.ts"></script>',
      );
      await put('src/a.ts');
      await put('src/b.ts');
      expect((await findEntry(tmp.dir, 'browser'))?.file).toBe('src/a.ts');
    });

    it('skips service-worker and worker registration scripts', async () => {
      await put(
        'index.html',
        '<script type="module" src="/src/register-sw.ts"></script><script type="module" src="/src/registerSW.js"></script><script type="module" src="/src/service-worker.ts"></script><script type="module" src="/src/main.tsx"></script>',
      );
      for (const f of ['register-sw.ts', 'registerSW.js', 'service-worker.ts', 'main.tsx']) {
        await put(`src/${f}`);
      }
      expect((await findEntry(tmp.dir, 'browser'))?.file).toBe('src/main.tsx');
    });
  });

  it('the Vite types of tsconfig.node.json (the config files project) say nothing about the app', async () => {
    await put('tsconfig.json', '{ "files": [], "references": [] }');
    await put('tsconfig.node.json', '{ "compilerOptions": { "types": ["vite/client"] } }');
    expect(await hasViteClientTypes(tmp.dir)).toBe(false);
    await put('tsconfig.app.json', '{ "compilerOptions": { "types": ["vite/client"] } }');
    expect(await hasViteClientTypes(tmp.dir)).toBe(true);
  });

  it('imports inside comments of an inline module script are not the entry', async () => {
    await put(
      'index.html',
      '<script type="module">/*\nimport "./unused.ts";\n*/\n// import "./also-unused.ts"\nimport "./actual.ts"</script>',
    );
    for (const f of ['unused', 'also-unused', 'actual']) await put(`src/${f}.ts`);
    await put('unused.ts');
    await put('also-unused.ts');
    await put('actual.ts');
    expect((await findEntry(tmp.dir, 'browser'))?.file).toBe('actual.ts');
  });

  it('hostile html stays fast: thousands of unclosed script tags, and long attribute runs', async () => {
    await put('index.html', '<script type="module">import "./a"\n'.repeat(20_000));
    await put('src/main.ts');
    const t0 = Date.now();
    await findEntry(tmp.dir, 'browser');
    expect(Date.now() - t0).toBeLessThan(1500);
    await put('index.html', `<script ${'type '.repeat(30_000)}`);
    const t1 = Date.now();
    await findEntry(tmp.dir, 'browser');
    expect(Date.now() - t1).toBeLessThan(1500);
  });
});
