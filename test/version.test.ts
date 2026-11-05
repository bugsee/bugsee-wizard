import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { createBaseProgram } from '../src/cli-program.js';
import { WIZARD_VERSION as telemetryVersion } from '../src/engine/telemetry.js';
import { WIZARD_VERSION } from '../src/version.js';

const pkgVersion = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string })
  .version;

describe('the wizard version has one source: package.json', () => {
  it('WIZARD_VERSION is the version in package.json', () => {
    expect(WIZARD_VERSION).toBe(pkgVersion);
  });

  it('telemetry, the CLI and the recipe store all use it', () => {
    expect(telemetryVersion).toBe(pkgVersion);
    expect(createBaseProgram().version()).toBe(pkgVersion);
    // the recipe store compares engineMin against it: no second copy of the literal
    const store = readFileSync('src/engine/recipe-store.ts', 'utf8');
    expect(store).not.toMatch(/WIZARD_VERSION\s*=\s*'/);
    expect(store).toMatch(/from '\.\.\/version\.js'/);
  });

  it('the published bundle carries it too (no import of package.json at runtime)', () => {
    // tsup inlines the JSON import; the file list of the package need not ship package.json twice
    expect(readFileSync('src/version.ts', 'utf8')).toContain('package.json');
  });
});
