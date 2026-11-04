import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scriptTemplate } from './recipe-cases.js';

/**
 * The generated scripts/bugsee-sourcemaps.mjs, EXECUTED against a stand-in `npx` that records its
 * argv and the token it was given. The script is chained into the user's `build`, so what it does
 * when something is missing decides whether the user's build breaks.
 */

const STUB = `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ args: process.argv.slice(2), token: process.env.BUGSEE_APP_TOKEN }) + '\\n');
process.exit(Number(process.env.STUB_EXIT || 0));
`;

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bugsee-script-'));
  await mkdir(join(root, 'bin'));
  await mkdir(join(root, 'project', 'scripts'), { recursive: true });
  await writeFile(join(root, 'bin', 'npx'), STUB);
  await chmod(join(root, 'bin', 'npx'), 0o755);
  await writeFile(join(root, 'project', 'package.json'), JSON.stringify({ version: '2.3.4' }));
  await writeFile(
    join(root, 'project', 'scripts', 'bugsee-sourcemaps.mjs'),
    await scriptTemplate('javascript-cli'),
  );
});
afterEach(() => rm(root, { recursive: true, force: true }));

function run(args: string[] = [], env: Record<string, string> = {}, cwd = join(root, 'project')) {
  const r = spawnSync(process.execPath, ['scripts/bugsee-sourcemaps.mjs', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: `${join(root, 'bin')}:${process.env.PATH}`,
      STUB_LOG: join(root, 'log'),
      HOME: root,
      ...env,
    },
  });
  return r;
}
const calls = async (): Promise<{ args: string[]; token: string }[]> =>
  (await readFile(join(root, 'log'), 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const out = (name = 'dist') => mkdir(join(root, 'project', name), { recursive: true });

describe.skipIf(process.platform === 'win32')('generated scripts/bugsee-sourcemaps.mjs', () => {
  it('is syntactically valid JavaScript', () => {
    const r = spawnSync(process.execPath, ['--check', 'scripts/bugsee-sourcemaps.mjs'], {
      cwd: join(root, 'project'),
      encoding: 'utf8',
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('injects, then uploads, with the version, a build number and the token from the environment only', async () => {
    await out();
    const r = run([], { BUGSEE_APP_TOKEN: 'tok123', BUGSEE_BUILD: '77' });
    expect(r.status).toBe(0);
    expect(await calls()).toEqual([
      { args: ['--no-install', 'bugsee-cli', 'sourcemaps', 'inject', 'dist'], token: 'tok123' },
      {
        args: [
          '--no-install',
          'bugsee-cli',
          'debug-files',
          'upload',
          'dist',
          '--type',
          'sourcemaps',
          '--version',
          '2.3.4',
          '--build',
          '77',
        ],
        token: 'tok123',
      },
    ]);
    expect(JSON.stringify(await calls()).match(/tok123/g)).toHaveLength(2); // only as env, never in argv
  });

  it('reads the token from .env.bugsee-build-plugin the way the wizard writes it (export, spaces, quotes)', async () => {
    await out();
    for (const line of [
      'BUGSEE_APP_TOKEN=abc',
      'export BUGSEE_APP_TOKEN=abc',
      'BUGSEE_APP_TOKEN = abc',
      'BUGSEE_APP_TOKEN="abc"',
      "BUGSEE_APP_TOKEN='abc'",
    ]) {
      await rm(join(root, 'log'), { force: true });
      await writeFile(join(root, 'project', '.env.bugsee-build-plugin'), `OTHER=1\n${line}\n`);
      expect(run().status, line).toBe(0);
      expect((await calls())[0]?.token, line).toBe('abc');
    }
  });

  it('the environment beats the env file', async () => {
    await out();
    await writeFile(
      join(root, 'project', '.env.bugsee-build-plugin'),
      'BUGSEE_APP_TOKEN=fromfile\n',
    );
    run([], { BUGSEE_APP_TOKEN: 'fromenv' });
    expect((await calls())[0]?.token).toBe('fromenv');
  });

  it('without a token it skips with a warning and exits 0, so a clone or fork CI build does not break', async () => {
    await out();
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/BUGSEE_APP_TOKEN/);
    expect(r.stderr).toMatch(/skip/i);
    expect(await calls()).toEqual([]);
  });

  it('passes a failing upload through as a failing build', async () => {
    await out();
    const r = run([], { BUGSEE_APP_TOKEN: 't', STUB_EXIT: '10' });
    expect(r.status).toBe(10);
    expect((await calls()).length).toBe(1); // inject failed, upload never ran
  });

  it('an explicit directory that does not exist is an error', async () => {
    const r = run(['nope'], { BUGSEE_APP_TOKEN: 't' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/"nope" not found/);
  });

  it('a default directory that does not exist is skipped with a warning, not a failed build', async () => {
    const r = run([], { BUGSEE_APP_TOKEN: 't' });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/dist/);
    expect(await calls()).toEqual([]);
  });

  it('takes the directory from BUGSEE_SOURCEMAPS_DIR, then tsconfig outDir, then dist', async () => {
    await out('lib');
    await out('build');
    await writeFile(
      join(root, 'project', 'tsconfig.json'),
      '{ // comment\n "compilerOptions": { "outDir": "./build/" } }',
    );
    run([], { BUGSEE_APP_TOKEN: 't', BUGSEE_SOURCEMAPS_DIR: 'lib' });
    expect((await calls())[0]?.args.at(-1)).toBe('lib');
    await rm(join(root, 'log'));
    run([], { BUGSEE_APP_TOKEN: 't' });
    expect((await calls())[0]?.args.at(-1)).toBe('./build');
  });

  it('works in a project with no package.json (version falls back)', async () => {
    await out();
    await rm(join(root, 'project', 'package.json'));
    const r = run([], { BUGSEE_APP_TOKEN: 't' });
    expect(r.status).toBe(0);
    expect((await calls())[1]?.args).toContain('0.0.0');
  });
});
