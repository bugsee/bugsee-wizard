#!/usr/bin/env node
// Regenerate every snapshot/<platform>/index.json from the recipe files next to it, so the
// sha256 values (and range / engineMin / revision) are never edited by hand.
//
//   npm run build:snapshot            (or: node scripts/build-snapshot.mjs [snapshotDir])

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  describeError,
  listSnapshot,
  loadParseRecipe,
  RECIPE_FILE_RE,
  recipeFiles,
  sha256,
  snapshotDirFromArgv,
} from './snapshot-lib.mjs';

const dir = snapshotDirFromArgv();
const parseRecipe = await loadParseRecipe();
const problems = [];

for (const platform of (await listSnapshot(dir)).platforms) {
  const platformDir = join(dir, platform);
  const entries = [];
  const before = problems.length;
  for (const file of await recipeFiles(platformDir)) {
    const bytes = await readFile(join(platformDir, file));
    let recipe;
    try {
      recipe = parseRecipe(JSON.parse(bytes.toString('utf8')));
    } catch (err) {
      problems.push(`${platform}/${file}: ${describeError(err)}`);
      continue;
    }
    entries.push({
      range: recipe.sdk.range,
      revision: `r${RECIPE_FILE_RE.exec(file)[1]}`,
      url: file,
      sha256: sha256(bytes),
      engineMin: recipe.engine.min,
    });
  }
  if (problems.length > before) continue;
  const index = { schema: 1, platform, entries };
  await writeFile(join(platformDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  console.log(`${platform}: ${entries.length} recipe(s) indexed`);
}

if (problems.length > 0) {
  console.error(`Not indexed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
