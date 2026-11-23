import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveRecipe } from '../../src/engine/recipe-store.js';
import { WIZARD_VERSION } from '../../src/engine/telemetry.js';
import {
  ALL_IDS,
  CURRENT_RANGE,
  CURRENT_REVISION,
  EXPECTED_DETECT,
  EXPECTED_FRAMEWORK_DETECT,
  EXPECTED_FRAMEWORK_NOTES,
  EXPECTED_FRAMEWORK_OPS,
  EXPECTED_NOTES,
  EXPECTED_OPS,
  EXPECTED_RUNTIME_NOTES,
  EXPECTED_RUNTIME_OPS,
  EXPECTED_VERIFY,
  expectTemplate,
  FRAMEWORK_IDS,
  isTwoRevisions,
  NEW_RANGE,
  OLD_RANGE,
  R1_NOTES,
  R1_OPS,
  RUNTIME_IDS,
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
    ).toEqual(
      [...IDS, ...RUNTIME_IDS, ...FRAMEWORK_IDS.map((f) => `framework-${f}`)]
        .map((id) => `javascript-${id}`)
        .sort(),
    );
  });

  describe.each(IDS)('javascript-%s', (id) => {
    const platform = `javascript-${id}`;
    const current = CURRENT_REVISION(id);

    it('index.json: schema 1, its platform, a bare file name per revision, newest covering the current SDK', async () => {
      const index = await readIndex(platform);
      const entry = (revision: string, range: string) => ({
        range,
        revision,
        url: `${revision}.json`,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        engineMin: WIZARD_VERSION,
      });
      const entries = isTwoRevisions(id)
        ? [entry('r1', OLD_RANGE), entry('r2', NEW_RANGE)]
        : [entry('r1', SDK_RANGE)];
      expect(index).toEqual({ schema: 1, platform, entries });
      expect((await readdir(join(SNAPSHOT, platform))).sort()).toEqual([
        'index.json',
        ...entries.map((e) => e.url),
      ]);
    });

    it('every index sha256 matches its recipe bytes', async () => {
      const index = await readIndex(platform);
      for (const e of index.entries) {
        const { bytes } = await readRecipeFile(platform, e.revision);
        expect(e.sha256, e.revision).toBe(createHash('sha256').update(bytes).digest('hex'));
      }
    });

    it('the recipe parses and its header agrees with the index', async () => {
      const { recipe } = await readRecipeFile(platform);
      expect(recipe).toMatchObject({
        schema: 1,
        id: platform,
        kind: 'buildtool',
        platform,
        engine: { min: '0.0.0' },
        sdk: { range: CURRENT_RANGE(id) },
      });
      expect(recipe.detect).toEqual(EXPECTED_DETECT[id]);
      const index = await readIndex(platform);
      expect(index.entries.find((e) => e.revision === current)?.range).toBe(CURRENT_RANGE(id));
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

    it('ends the run with how to confirm symbolication, and never points at a doctor command', async () => {
      const index = await readIndex(platform);
      for (const e of index.entries) {
        const { recipe } = await readRecipeFile(platform, e.revision);
        const verify = (recipe.verify ?? []).join('\n');
        for (const re of EXPECTED_VERIFY) expect(verify, `${e.revision} ${re}`).toMatch(re);
        expect(`${verify}\n${recipe.notes}`, e.revision).not.toMatch(/doctor/i);
      }
    });

    it.runIf(isTwoRevisions(id))(
      'r1 stays the CLI route for the SDKs whose plugin cannot upload yet',
      async () => {
        const key = id as keyof typeof R1_OPS;
        const { recipe } = await readRecipeFile(platform, 'r1');
        expect(recipe.sdk.range).toBe(OLD_RANGE);
        const ops = recipe.ops.map((o) =>
          o.op === 'write-file' ? { ...o, template: expectTemplate } : o,
        );
        expect(ops).toEqual(R1_OPS[key]);
        for (const re of R1_NOTES[key]) expect(recipe.notes).toMatch(re);
      },
    );

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

    it('resolves the current revision for SDK 0.1.0-beta.7 and 0.1.0-beta.8', async () => {
      for (const sdkVersion of ['0.1.0-beta.7', '0.1.0-beta.8']) {
        const r = await resolveRecipe({
          platform,
          sdkVersion,
          engine: WIZARD_VERSION,
          baseUrl: 'http://127.0.0.1:9/',
          fetchImpl: offline,
        });
        expect(r.revision, sdkVersion).toBe(current);
        expect(r.warning ?? '', sdkVersion).not.toMatch(/nearest older/);
      }
    });

    it.runIf(isTwoRevisions(id))(
      'resolves r1 for SDK 0.1.0-beta.6, not the plugin route',
      async () => {
        const r = await resolveRecipe({
          platform,
          sdkVersion: '0.1.0-beta.6',
          engine: WIZARD_VERSION,
          baseUrl: 'http://127.0.0.1:9/',
          fetchImpl: offline,
        });
        expect(r.revision).toBe('r1');
      },
    );
  });

  describe.each(FRAMEWORK_IDS)('javascript-framework-%s (framework recipe)', (id) => {
    const platform = `javascript-framework-${id}`;

    it('is a framework recipe covering the beta SDK, indexed with a matching hash', async () => {
      const { bytes, recipe } = await readRecipeFile(platform);
      expect(recipe).toMatchObject({
        schema: 1,
        id: platform,
        kind: 'framework',
        platform,
        engine: { min: '0.0.0' },
        sdk: { range: SDK_RANGE },
      });
      expect(recipe.detect).toEqual(EXPECTED_FRAMEWORK_DETECT[id]);
      const index = await readIndex(platform);
      expect(index.entries).toHaveLength(1);
      expect(index.entries[0]?.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    });

    it('installs the adapter at the beta tag and hands back exactly the documented wiring', async () => {
      const { recipe } = await readRecipeFile(platform);
      expect(recipe.ops).toEqual(EXPECTED_FRAMEWORK_OPS[id]);
    });

    it('git-ignores a token file before writing it, and no snippet carries a token', async () => {
      const { recipe } = await readRecipeFile(platform);
      const ignore = recipe.ops.findIndex((o) => o.op === 'ensure-gitignore');
      const write = recipe.ops.findIndex((o) => o.op === 'write-env-var');
      if (write !== -1) expect(ignore).toBeLessThan(write);
      expect(JSON.stringify(recipe)).not.toContain('{{token}}');
    });

    it('explains itself in notes', async () => {
      const { recipe } = await readRecipeFile(platform);
      for (const re of EXPECTED_FRAMEWORK_NOTES[id]) expect(recipe.notes).toMatch(re);
    });

    it('resolves offline from the real snapshot', async () => {
      const r = await resolveRecipe({
        platform,
        sdkVersion: SDK_VERSION,
        engine: WIZARD_VERSION,
        baseUrl: 'http://127.0.0.1:9/',
        fetchImpl: offline,
      });
      expect(r.source).toBe('snapshot');
      expect(r.recipe.id).toBe(platform);
    });
  });

  describe.each(RUNTIME_IDS)('javascript-%s (runtime recipe)', (id) => {
    const platform = `javascript-${id}`;

    it('is a runtime recipe covering the beta SDK, indexed with a matching hash', async () => {
      const { bytes, recipe } = await readRecipeFile(platform);
      expect(recipe).toMatchObject({
        schema: 1,
        id: platform,
        kind: 'runtime',
        platform,
        engine: { min: '0.0.0' },
        sdk: { range: SDK_RANGE },
      });
      const index = await readIndex(platform);
      expect(index.entries).toHaveLength(1);
      expect(index.entries[0]?.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    });

    it('has exactly the expected operations, installing at the beta tag', async () => {
      const { recipe } = await readRecipeFile(platform);
      expect(recipe.ops).toEqual(EXPECTED_RUNTIME_OPS[id]);
    });

    it('git-ignores the token file before writing it, and the token never reaches the code unless it is a literal', async () => {
      const { recipe } = await readRecipeFile(platform);
      const ignore = recipe.ops.findIndex((o) => o.op === 'ensure-gitignore');
      const write = recipe.ops.findIndex((o) => o.op === 'write-env-var');
      if (write !== -1) expect(ignore).toBeLessThan(write);
      expect(JSON.stringify(recipe)).not.toContain('{{token}}');
    });

    it('explains itself in notes', async () => {
      const { recipe } = await readRecipeFile(platform);
      for (const re of EXPECTED_RUNTIME_NOTES[id]) expect(recipe.notes).toMatch(re);
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
