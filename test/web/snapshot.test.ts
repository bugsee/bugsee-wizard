import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveRecipe } from '../../src/engine/recipe-store.js';
import { WIZARD_VERSION } from '../../src/engine/telemetry.js';
import {
  ALL_IDS,
  EXPECTED_DETECT,
  EXPECTED_NOTES,
  EXPECTED_OPS,
  expectTemplate,
  readIndex,
  readRecipeFile,
  SCRIPT_PATH,
  SDK_RANGE,
  SDK_VERSION,
  SNAPSHOT,
  scriptTemplate,
} from './recipe-cases.js';

const IDS = ALL_IDS;

const offline: typeof fetch = async () => {
  throw new TypeError('fetch failed (offline in tests)');
};

describe('the bundled recipe snapshot', () => {
  it('holds exactly one directory per JavaScript recipe and no placeholder', async () => {
    const entries = await readdir(SNAPSHOT, { withFileTypes: true });
    expect(entries.filter((e) => e.isFile()).map((e) => e.name)).toEqual([]);
    expect(
      entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort(),
    ).toEqual(IDS.map((id) => `javascript-${id}`).sort());
  });

  describe.each(IDS)('javascript-%s', (id) => {
    const platform = `javascript-${id}`;

    it('index.json: schema 1, its platform, one r1 entry with a bare file name', async () => {
      const index = await readIndex(platform);
      expect(index).toEqual({
        schema: 1,
        platform,
        entries: [
          {
            range: SDK_RANGE,
            revision: 'r1',
            url: 'r1.json',
            sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
            engineMin: WIZARD_VERSION,
          },
        ],
      });
      expect((await readdir(join(SNAPSHOT, platform))).sort()).toEqual(['index.json', 'r1.json']);
    });

    it('the index sha256 matches the recipe bytes', async () => {
      const index = await readIndex(platform);
      const { bytes } = await readRecipeFile(platform);
      expect(index.entries[0]?.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    });

    it('the recipe parses and its header agrees with the index', async () => {
      const { recipe } = await readRecipeFile(platform);
      expect(recipe).toMatchObject({
        schema: 1,
        id: platform,
        kind: 'buildtool',
        platform,
        engine: { min: '0.0.0' },
        sdk: { range: SDK_RANGE },
      });
      expect(recipe.detect).toEqual(EXPECTED_DETECT[id]);
    });

    it('has exactly the expected operations', async () => {
      const { recipe } = await readRecipeFile(platform);
      const ops = recipe.ops.map((o) =>
        o.op === 'write-file' ? { ...o, template: expectTemplate } : o,
      );
      expect(ops).toEqual(EXPECTED_OPS[id]);
    });

    it('explains itself in notes', async () => {
      const { recipe } = await readRecipeFile(platform);
      for (const re of EXPECTED_NOTES[id]) expect(recipe.notes).toMatch(re);
    });

    it('resolves offline from the real snapshot for SDK 0.1.0-beta.5', async () => {
      const r = await resolveRecipe({
        platform,
        sdkVersion: SDK_VERSION,
        engine: WIZARD_VERSION,
        baseUrl: 'http://127.0.0.1:9/',
        fetchImpl: offline,
      });
      expect(r.source).toBe('snapshot');
      expect(r.revision).toBe('r1');
      expect(r.recipe.id).toBe(platform);
    });
  });

  it('every CLI-route recipe carries the same upload script, written to scripts/', async () => {
    const cli = IDS.filter((id) => EXPECTED_OPS[id].some((o) => o.op === 'write-file'));
    const templates = await Promise.all(cli.map((id) => scriptTemplate(`javascript-${id}`)));
    for (const t of templates) expect(t).toBe(templates[0]);
    for (const id of cli) {
      const { recipe } = await readRecipeFile(`javascript-${id}`);
      expect(recipe.ops.find((o) => o.op === 'write-file')).toMatchObject({ path: SCRIPT_PATH });
    }
  });
});
