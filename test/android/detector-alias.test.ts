import { afterEach, describe, expect, it } from 'vitest';

import { runDetectors } from '../../src/core/detect.js';
import { androidDetector } from '../../src/detectors/android.js';
import { registerAllDetectors } from '../../src/detectors/index.js';
import { discoverAndroidPaths } from '../../src/recipes/android/paths.js';
import { cleanup, makeFixture } from './helpers.js';

let fixture: string;
afterEach(async () => {
  if (fixture) await cleanup(fixture);
});

const kts = (alias: string) =>
  `plugins {\n    ${alias}\n    alias(libs.plugins.kotlin.android)\n}\n`;
const toml = (plugins: string) => `[versions]\nagp = "8.5.0"\n\n[plugins]\n${plugins}\n`;
const files = (build: string, catalog?: string, name = 'app/build.gradle.kts') => ({
  [name]: build,
  ...(catalog === undefined ? {} : { 'gradle/libs.versions.toml': catalog }),
});
const detects = async () => (await androidDetector.detect({ cwd: fixture }))?.kind === 'android';

describe('androidDetector: version-catalog aliases', () => {
  it('resolves via toml: id + version.ref, with a name that does not hint at android', async () => {
    fixture = await makeFixture(
      files(
        kts('alias(libs.plugins.agpApp)'),
        toml('agpApp = { id = "com.android.application", version.ref = "agp" }'),
      ),
    );
    expect(await detects()).toBe(true);
  });

  it('resolves the string form and dashed keys', async () => {
    fixture = await makeFixture(
      files(kts('alias(libs.plugins.my.app)'), toml('my-app = "com.android.application:8.5.0"')),
    );
    expect(await detects()).toBe(true);
  });

  it('resolves Groovy `alias libs.plugins.x`', async () => {
    fixture = await makeFixture(
      files(
        'plugins {\n    alias libs.plugins.agpApp\n}\n',
        toml('agpApp = { id = "com.android.application", version.ref = "agp" }'),
        'app/build.gradle',
      ),
    );
    expect(await detects()).toBe(true);
  });

  it('does NOT match when the catalog resolves the alias to another plugin, even with an android-application-like name', async () => {
    fixture = await makeFixture(
      files(
        kts('alias(libs.plugins.android.application)'),
        toml('android-application = { id = "com.android.library", version.ref = "agp" }'),
      ),
    );
    expect(await detects()).toBe(false);
  });

  it('ignores entries outside [plugins]', async () => {
    fixture = await makeFixture(
      files(
        kts('alias(libs.plugins.agpApp)'),
        '[libraries]\nagpApp = { id = "com.android.application" }\n',
      ),
    );
    expect(await detects()).toBe(false);
  });

  it.each(['android.application', 'androidApplication', 'android-application'])(
    'heuristic: unresolved alias named %s counts (no catalog)',
    async (n) => {
      fixture = await makeFixture(files(kts(`alias(libs.plugins.${n})`)));
      expect(await detects()).toBe(true);
    },
  );

  it('heuristic also applies when the catalog lacks the entry', async () => {
    fixture = await makeFixture(
      files(kts('alias(libs.plugins.android.application)'), toml('other = "x.y:1"')),
    );
    expect(await detects()).toBe(true);
  });

  it('unrelated unresolved alias does NOT match', async () => {
    fixture = await makeFixture(files('plugins {\n    alias(libs.plugins.kotlin.android)\n}\n'));
    expect(await detects()).toBe(false);
  });

  it('uninstall detection (runDetectors) finds the alias project', async () => {
    fixture = await makeFixture(
      files(kts('alias(libs.plugins.android.application)'), toml('x = "a.b:1"')),
    );
    registerAllDetectors();
    const found = await runDetectors({ cwd: fixture });
    expect(found.map((d) => d.kind)).toContain('android');
  });

  it('paths: the alias form classifies as plugins-dsl', async () => {
    fixture = await makeFixture({
      ...files(kts('alias(libs.plugins.android.application)')),
      'settings.gradle.kts': 'rootProject.name = "x"\n',
      'build.gradle.kts': 'plugins {\n    alias(libs.plugins.android.application) apply false\n}\n',
    });
    const paths = await discoverAndroidPaths(fixture);
    expect(paths.appBuildGradle).toContain('app/build.gradle.kts');
    expect(paths.appBuildScriptStyle).toBe('plugins-dsl');
  });
});
