import { mkdir, writeFile } from 'node:fs/promises';
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

  it('skips node_modules, build output and .git, and is bounded in file size', async () => {
    await put('node_modules/x/index.js', "import '@bugsee/bugsee';\n");
    await put('dist/main.js', "import '@bugsee/bugsee';\n");
    await put('.git/hooks/x.js', "import '@bugsee/bugsee';\n");
    await put('src/huge.ts', `${'x'.repeat(600_000)}\nimport '@bugsee/bugsee';\n`);
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
});
