// e2e fixture: a build script on esbuild's JavaScript API. A project that followed the wizard's snippet
// for this step already has the plugin below (the marker comment is how the wizard recognises it).
import { build } from 'esbuild';
import { bugseeEsbuildPlugin } from '@bugsee/bundler-plugin-core'; // bugsee-wizard

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outdir: 'dist',
  sourcemap: 'external',
  plugins: [bugseeEsbuildPlugin({ appToken: process.env.BUGSEE_APP_TOKEN })],
});
