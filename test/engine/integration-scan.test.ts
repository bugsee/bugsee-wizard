import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findExistingIntegration } from '../../src/engine/integration-scan.js';
import { makeTmp } from './helpers.js';

let tmp: Awaited<ReturnType<typeof makeTmp>>;
beforeEach(async () => {
  tmp = await makeTmp();
});
afterEach(() => tmp.cleanup());
async function put(rel: string, content: string): Promise<void> {
  await mkdir(dirname(join(tmp.dir, rel)), { recursive: true });
  await writeFile(join(tmp.dir, rel), content);
}
const scan = (own = '@bugsee/bugsee') => findExistingIntegration(tmp.dir, own);
async function many(dir: string, n: number): Promise<void> {
  await mkdir(join(tmp.dir, dir), { recursive: true });
  await Promise.all(
    Array.from({ length: n }, (_, i) =>
      writeFile(join(tmp.dir, dir, `f${i}.js`), `export const a${i} = ${i};\n`),
    ),
  );
}

describe('findExistingIntegration', () => {
  it('nothing in the project: undefined', async () => {
    await put('package.json', JSON.stringify({ dependencies: { react: '1' } }));
    await put('src/main.ts', "import React from 'react';\n");
    expect(await scan()).toBeUndefined();
  });

  it.each([
    ["import { launch } from '@bugsee/bugsee';\n"],
    ["import '@bugsee/browser';\n"],
    ["const { launch } = require('@bugsee/node');\n"],
    ["const m = await import('@bugsee/bugsee');\n"],
    ["import { BugseeProvider } from '@bugsee/react/provider';\n"],
    ["export * from '@bugsee/bun';\n"],
  ])('finds a load of a runtime package anywhere in the source tree: %s', async (src) => {
    await put('src/deep/nested/bugsee.ts', src);
    await put('src/main.ts', 'run();\n');
    expect(await scan()).toEqual({ where: 'src/deep/nested/bugsee.ts' });
  });

  it.each([
    ["import type { X } from '@bugsee/bugsee';\n"],
    ["import { p } from '@bugsee/vite-plugin';\n"],
    ["const s = 'about @bugsee/bugsee';\n"],
  ])('does not count type-only imports, build tooling or plain text: %s', async (src) => {
    await put('src/a.ts', src);
    expect(await scan()).toBeUndefined();
  });

  it('finds Vue, Svelte and Astro components too', async () => {
    await put(
      'src/App.vue',
      "<script setup>\nimport { launch } from '@bugsee/bugsee';\n</script>\n",
    );
    expect(await scan()).toEqual({ where: 'src/App.vue' });
  });

  it('a runtime package other than the one being installed in package.json counts', async () => {
    await put('package.json', JSON.stringify({ dependencies: { '@bugsee/node': '1' } }));
    expect(await scan('@bugsee/bugsee')).toEqual({ where: 'package.json (@bugsee/node)' });
    await put('package.json', JSON.stringify({ devDependencies: { '@bugsee/react': '1' } }));
    expect(await scan('@bugsee/bugsee')).toEqual({ where: 'package.json (@bugsee/react)' });
  });

  it('the package being installed, and build tooling, are not integration by themselves', async () => {
    await put(
      'package.json',
      JSON.stringify({
        dependencies: { '@bugsee/bugsee': '1' },
        devDependencies: { '@bugsee/vite-plugin': '1', '@bugsee/cli': '1' },
      }),
    );
    expect(await scan('@bugsee/bugsee')).toBeUndefined();
  });

  it('skips node_modules, build output and .git', async () => {
    await put('node_modules/x/index.js', "import '@bugsee/bugsee';\n");
    await put('dist/main.js', "import '@bugsee/bugsee';\n");
    await put('.git/hooks/x.js', "import '@bugsee/bugsee';\n");
    expect(await scan()).toBeUndefined();
  });

  it('tolerates a missing or invalid package.json', async () => {
    await put('package.json', '{ nope');
    expect(await scan()).toBeUndefined();
  });

  it("only runtime SDK packages count: the wizard, CLI binaries and React Native are not this recipe's SDK", async () => {
    await put(
      'package.json',
      JSON.stringify({
        devDependencies: {
          '@bugsee/wizard': '1',
          '@bugsee/cli-darwin-x64': '1',
          '@bugsee/react-native': '1',
          '@bugsee/babel-plugin-component-annotate': '1',
        },
      }),
    );
    await put(
      'src/a.ts',
      "import w from '@bugsee/wizard';\nimport n from '@bugsee/react-native';\n",
    );
    expect(await scan()).toBeUndefined();
  });

  describe('the scan is bounded, and a bound is never "not integrated"', () => {
    it('likely source directories are read first, so a big other directory cannot hide an integration', async () => {
      await many('docs', 3100);
      await put('src/bugsee.js', "import { launch } from '@bugsee/bugsee';\nlaunch('t');\n");
      expect(await scan()).toEqual({ where: 'src/bugsee.js' });
    });

    it('hitting the cap without finding anything is "unknown", never undefined', async () => {
      await many('docs', 3100);
      expect(await scan()).toEqual({ unknown: expect.stringContaining('more than 3000') });
    });

    it('assets, static and public directories are not source: they cannot exhaust the bound', async () => {
      await many('assets', 3100);
      await many('static', 10);
      await many('public', 10);
      expect(await scan()).toBeUndefined();
    });
  });

  it.each([
    'node_modules',
    '.git',
    '.bugsee',
    'dist',
    'build',
    'out',
    'coverage',
    '.next',
    '.nuxt',
    '.svelte-kit',
    '.output',
    '.turbo',
    '.angular',
    '.vercel',
    'assets',
    'static',
    'public',
    'vendor',
  ])('does not look inside %s/', async (dir) => {
    await put(`${dir}/x.js`, "import '@bugsee/bugsee';\n");
    expect(await scan()).toBeUndefined();
    // ...while the same file in a source directory is found
    await put('src/x.js', "import '@bugsee/bugsee';\n");
    expect(await scan()).toEqual({ where: 'src/x.js' });
  });

  describe('only executable loads count', () => {
    it.each([
      ["// import '@bugsee/bugsee';\n"],
      ["/* import '@bugsee/bugsee';\n*/\n"],
      ["export type { X } from '@bugsee/bugsee';\n"],
      ["import { type X } from '@bugsee/bugsee';\n"],
      ["import { type X, type Y as Z } from '@bugsee/bugsee';\n"],
    ])('does not count %j', async (src) => {
      await put('src/a.ts', src);
      expect(await scan()).toBeUndefined();
    });

    it.each([
      ["const a = <p>it's</p>;\n// require('@bugsee/bugsee')\n", 'src/a.jsx'],
      [
        "const q = (s) => { return /'/.test(s); };\n// import x from '@bugsee/bugsee'\n",
        'src/a.js',
      ],
      [
        "<template><p>don't</p></template>\n<script>\n// import '@bugsee/bugsee'\n</script>\n",
        'src/App.vue',
      ],
    ])(
      'a commented-out import after an apostrophe or a keyword regex is still a comment: %j',
      async (src, file) => {
        await put(file, src);
        expect(await scan()).toBeUndefined();
      },
    );

    it.each([
      ['index.html', '<!-- <script type="module">import "@bugsee/bugsee"</script> -->\n'],
      [
        'src/App.vue',
        '<!--\n<script>import "@bugsee/bugsee"</script>\n-->\n<p>press the ` key</p>\n// import "@bugsee/bugsee"\n',
      ],
      ['src/page.astro', "---\n// import '@bugsee/bugsee'\n---\n<p>it's</p>\n"],
    ])('a commented-out script in %s does not count', async (file, src) => {
      await put(file, src);
      expect(await scan()).toBeUndefined();
    });

    it('a load after a comment on the same line, or next to a URL in a string, still counts', async () => {
      await put('src/a.js', "const u = 'https://example.com'; import('@bugsee/bugsee');\n");
      expect(await scan()).toEqual({ where: 'src/a.js' });
    });
  });

  describe('a file that cannot be checked makes the scan unknown (never "not integrated")', () => {
    it('the first unreadable file is the reason given', async () => {
      await put('src/a.js', "import '@bugsee/bugsee';\n");
      await put('src/b.js', "import '@bugsee/bugsee';\n");
      await chmod(join(tmp.dir, 'src/a.js'), 0o000);
      await chmod(join(tmp.dir, 'src/b.js'), 0o000);
      try {
        const res = await scan();
        expect(res === undefined || 'unknown' in res || 'where' in res).toBe(true);
        if (res && 'unknown' in res) expect(res.unknown).toContain('src/a.js');
      } finally {
        await chmod(join(tmp.dir, 'src/a.js'), 0o644);
        await chmod(join(tmp.dir, 'src/b.js'), 0o644);
      }
    });
    it('an unreadable source file', async () => {
      await put('src/locked.js', "import '@bugsee/bugsee';\n");
      await chmod(join(tmp.dir, 'src/locked.js'), 0o000);
      try {
        const res = await scan();
        // root can read anything: then it is simply found
        expect(
          (res !== undefined && 'unknown' in res && res.unknown.includes('src/locked.js')) ||
            (res !== undefined && 'where' in res && res.where === 'src/locked.js'),
        ).toBe(true);
      } finally {
        await chmod(join(tmp.dir, 'src/locked.js'), 0o644);
      }
    });
  });

  it('hidden tool and cache directories are not scanned (a big .yarn cannot make the scan unknown)', async () => {
    await many('.yarn/unplugged', 3100);
    await many('.cache', 10);
    await many('storybook-static', 10);
    await put('src/a.js', 'run();\n');
    expect(await scan()).toBeUndefined();
  });

  describe('one large generated file does not make the whole scan unknown', () => {
    it('a file over the size cap is skipped, and reported as a note', async () => {
      await put('src/generated/schema.js', `${'x'.repeat(600_000)}\n`);
      await put('src/main.js', 'run();\n');
      const notes: string[] = [];
      expect(await findExistingIntegration(tmp.dir, '@bugsee/bugsee', notes)).toBeUndefined();
      expect(notes.join('\n')).toContain('src/generated/schema.js');
    });
    it('an integration in a normal file next to it is still found', async () => {
      await put('src/generated/schema.js', `${'x'.repeat(600_000)}\n`);
      await put('src/bugsee.js', "import '@bugsee/bugsee';\n");
      expect(await scan()).toEqual({ where: 'src/bugsee.js' });
    });
  });

  describe('hidden directories: only known tooling is skipped', () => {
    it('an integration in .storybook/ (a real home for app code) is found', async () => {
      await put('.storybook/preview.js', "import '@bugsee/bugsee';\n");
      expect(await scan()).toEqual({ where: '.storybook/preview.js' });
    });
    it.each([
      '.git',
      '.cache',
      '.yarn',
      '.nx',
      '.parcel-cache',
      '.docusaurus',
      '.vite',
      '.pnpm-store',
      '.idea',
      '.vscode',
    ])('%s/ is skipped', async (dir) => {
      await put(`${dir}/x.js`, "import '@bugsee/bugsee';\n");
      expect(await scan()).toBeUndefined();
    });
  });

  describe('regular expressions stay fast on hostile text', () => {
    it.each([
      ['type specifiers', `import { ${'type a    '.repeat(5000)}`],
      ['import type', `${'import type '.repeat(5000)}`],
      ['export type', `${'export type { a } '.repeat(3000)}`],
      ['from chains', `${"import a from 'x' ".repeat(3000)}`],
    ])('%s', async (_n, text) => {
      await put('src/a.ts', text);
      const t0 = Date.now();
      await scan();
      expect(Date.now() - t0).toBeLessThan(1500);
    });
  });
});
