#!/usr/bin/env node
// Validate the bundled recipe snapshot (run in CI):
//   - every index entry's sha256 matches the recipe bytes;
//   - every recipe passes the real parseRecipe;
//   - recipe id / platform agree with the directory, the index range / engineMin with the recipe;
//   - a token file written by write-env-var is covered by an EARLIER ensure-gitignore (a crash
//     in between must never leave the token un-ignored);
//   - index urls are bare file names, every recipe file is listed, nothing stray at the top level.
//
//   npm run validate:snapshot         (or: node scripts/validate-snapshot.mjs [snapshotDir])

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import semver from 'semver';
import {
  describeError,
  listSnapshot,
  loadParseRecipe,
  recipeFiles,
  sha256,
  snapshotDirFromArgv,
} from './snapshot-lib.mjs';

// `.env`, `/.env` and `./.env` ignore the same root file
const gitignoreKey = (p) => p.replace(/^(?:\.?\/)+/, '');

const dir = snapshotDirFromArgv();
const parseRecipe = await loadParseRecipe();
const problems = [];
const fail = (where, why) => problems.push(`${where}: ${why}`);

const { platforms, files } = await listSnapshot(dir);
for (const f of files)
  fail(f, 'stray file at the top of the snapshot (recipes live in <platform>/)');
if (platforms.length === 0) fail(dir, 'no recipes in the snapshot');

let checked = 0;
for (const platform of platforms) {
  const platformDir = join(dir, platform);
  let index;
  try {
    index = JSON.parse(await readFile(join(platformDir, 'index.json'), 'utf8'));
  } catch (err) {
    fail(`${platform}/index.json`, describeError(err));
    continue;
  }
  if (index.schema !== 1) fail(`${platform}/index.json`, `schema must be 1, not ${index.schema}`);
  if (index.platform !== platform)
    fail(`${platform}/index.json`, `platform "${index.platform}" is not the directory name`);
  const entries = Array.isArray(index.entries) ? index.entries : [];
  if (entries.length === 0) fail(`${platform}/index.json`, 'has no entries');
  const listed = new Set();
  for (const e of entries) {
    const where = `${platform}/${e.url}`;
    listed.add(e.url);
    if (typeof e.url !== 'string' || /[\\/]|\.\./.test(e.url)) {
      fail(`${platform}/index.json`, `url ${JSON.stringify(e.url)} must be a bare file name`);
      continue;
    }
    let bytes;
    try {
      bytes = await readFile(join(platformDir, e.url));
    } catch {
      fail(where, 'is listed in the index but missing');
      continue;
    }
    if (sha256(bytes) !== e.sha256)
      fail(where, 'sha256 does not match the index (run npm run build:snapshot)');
    let recipe;
    try {
      recipe = parseRecipe(JSON.parse(bytes.toString('utf8')));
    } catch (err) {
      fail(where, describeError(err));
      continue;
    }
    if (recipe.id !== platform) fail(where, `id "${recipe.id}" is not "${platform}"`);
    if (recipe.platform !== platform)
      fail(where, `platform "${recipe.platform}" is not "${platform}"`);
    if (e.range !== recipe.sdk.range)
      fail(where, `index range "${e.range}" is not the recipe's sdk.range "${recipe.sdk.range}"`);
    if (semver.validRange(e.range) === null)
      fail(where, `range "${e.range}" is not a semver range`);
    if (e.engineMin !== recipe.engine.min)
      fail(
        where,
        `index engineMin "${e.engineMin}" is not the recipe's engine.min "${recipe.engine.min}"`,
      );
    if (e.revision !== e.url.replace(/\.json$/, ''))
      fail(where, `revision "${e.revision}" does not match the file name`);
    const ignored = new Set();
    recipe.ops.forEach((op, i) => {
      if (op.op === 'ensure-gitignore') ignored.add(gitignoreKey(op.line));
      else if (op.op === 'write-env-var' && !ignored.has(gitignoreKey(op.file)))
        fail(
          where,
          `ops[${i}] write-env-var writes ${op.file} without an earlier ensure-gitignore for it`,
        );
    });
    checked++;
  }
  for (const f of await recipeFiles(platformDir)) {
    if (!listed.has(f)) fail(`${platform}/${f}`, 'is not listed in index.json');
  }
}

if (problems.length > 0) {
  console.error(`Recipe snapshot is invalid:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`snapshot OK: ${checked} recipe(s) in ${platforms.length} platform(s)`);
