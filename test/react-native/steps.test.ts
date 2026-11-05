import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensureRnBugseePackageStep } from '../../src/recipes/react-native/steps/ensure-rn-bugsee-package.js';
import { injectJsEntryStep } from '../../src/recipes/react-native/steps/inject-js-entry.js';
import { runPackageInstallStep } from '../../src/recipes/react-native/steps/run-package-install.js';
import {
  cleanup,
  makeFixture,
  makeRnContext,
  readFixture,
  SAMPLE_APP_TSX,
  SAMPLE_INDEX_JS,
  SAMPLE_RN_PACKAGE_JSON,
} from './helpers.js';

vi.mock('@clack/prompts', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    step: vi.fn(),
    message: vi.fn(),
  },
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), error: vi.fn() }),
}));

// Mock the package-manager probe so precheck branches are deterministic.
let managerAvailable = true;
vi.mock('../../src/recipes/react-native/package-manager.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/recipes/react-native/package-manager.js')
  >('../../src/recipes/react-native/package-manager.js');
  return {
    ...actual,
    isManagerOnPath: () => managerAvailable,
  };
});

let fixture: string | undefined;
afterEach(async () => {
  if (fixture) {
    await cleanup(fixture);
    fixture = undefined;
  }
  managerAvailable = true;
});

describe('ensureRnBugseePackageStep', () => {
  it('adds @bugsee/react-native to dependencies when missing, at the validated range', async () => {
    fixture = await makeFixture({ 'package.json': SAMPLE_RN_PACKAGE_JSON });
    const ctx = await makeRnContext({ cwd: fixture });
    expect(await ensureRnBugseePackageStep.precheck(ctx)).toEqual({ kind: 'pending' });
    await ensureRnBugseePackageStep.apply(ctx);
    const updated = JSON.parse(await readFixture(fixture, 'package.json'));
    expect(updated.dependencies['@bugsee/react-native']).toBe('^7.0.0-beta3');
    expect(await ensureRnBugseePackageStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
  });

  it('preserves indent style', async () => {
    // 4-space indent
    const four = JSON.stringify(JSON.parse(SAMPLE_RN_PACKAGE_JSON), null, 4);
    fixture = await makeFixture({ 'package.json': `${four}\n` });
    const ctx = await makeRnContext({ cwd: fixture });
    await ensureRnBugseePackageStep.apply(ctx);
    const written = await readFixture(fixture, 'package.json');
    expect(written).toContain('    "react-native":');
    expect(written).toContain('    "@bugsee/react-native":');
  });

  it('rolls back by deleting the dependency entry', async () => {
    fixture = await makeFixture({ 'package.json': SAMPLE_RN_PACKAGE_JSON });
    const ctx = await makeRnContext({ cwd: fixture });
    await ensureRnBugseePackageStep.apply(ctx);
    await ensureRnBugseePackageStep.rollback(ctx);
    const updated = JSON.parse(await readFixture(fixture, 'package.json'));
    expect(updated.dependencies['@bugsee/react-native']).toBeUndefined();
  });

  it('rollback also removes the old react-native-bugsee an earlier wizard installed', async () => {
    const old = JSON.parse(SAMPLE_RN_PACKAGE_JSON);
    old.dependencies['react-native-bugsee'] = '^4.0.0';
    old.devDependencies['react-native-bugsee'] = '^4.0.0';
    fixture = await makeFixture({ 'package.json': JSON.stringify(old, null, 2) });
    const ctx = await makeRnContext({ cwd: fixture });
    await ensureRnBugseePackageStep.rollback(ctx);
    const updated = JSON.parse(await readFixture(fixture, 'package.json'));
    expect(updated.dependencies['react-native-bugsee']).toBeUndefined();
    expect(updated.devDependencies['react-native-bugsee']).toBeUndefined();
  });

  it('is satisfied when the dep already exists in devDependencies', async () => {
    const withDep = JSON.parse(SAMPLE_RN_PACKAGE_JSON);
    withDep.devDependencies['@bugsee/react-native'] = '^4.0.0';
    fixture = await makeFixture({ 'package.json': JSON.stringify(withDep, null, 2) });
    const ctx = await makeRnContext({ cwd: fixture });
    expect(await ensureRnBugseePackageStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
  });

  it('blocks when package.json is invalid JSON', async () => {
    fixture = await makeFixture({ 'package.json': '{ not valid json' });
    const ctx = await makeRnContext({ cwd: fixture });
    const status = await ensureRnBugseePackageStep.precheck(ctx);
    expect(status.kind).toBe('blocked');
  });
});

describe('injectJsEntryStep', () => {
  it("launches from JavaScript with a Platform check (aliased so it cannot clash with the app's own Platform import)", async () => {
    fixture = await makeFixture({
      'package.json': SAMPLE_RN_PACKAGE_JSON,
      'App.tsx': SAMPLE_APP_TSX,
    });
    const ctx = await makeRnContext({
      cwd: fixture,
      tokens: { android: 'AND', ios: 'IOS' },
    });
    await injectJsEntryStep.apply(ctx);
    const updated = await readFixture(fixture, 'App.tsx');
    expect(updated).toContain(`import Bugsee from '@bugsee/react-native'`);
    expect(updated).toContain(`import { Platform as BugseePlatform } from 'react-native'`);
    expect(updated).toContain(`Bugsee.launch(BugseePlatform.OS === 'ios' ? 'IOS' : 'AND')`);
    expect(await injectJsEntryStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
  });

  it('with one platform token it launches only that platform and writes no placeholder', async () => {
    fixture = await makeFixture({
      'package.json': SAMPLE_RN_PACKAGE_JSON,
      'App.tsx': SAMPLE_APP_TSX,
    });
    const ctx = await makeRnContext({ cwd: fixture, tokens: { ios: 'IOS' } });
    await injectJsEntryStep.apply(ctx);
    const updated = await readFixture(fixture, 'App.tsx');
    expect(updated).toContain(`if (BugseePlatform.OS === 'ios') {\n  Bugsee.launch('IOS');\n}`);
    expect(updated).not.toMatch(/<\w+_TOKEN>|ANDROID|'AND/);
    const android = await makeFixture({
      'package.json': SAMPLE_RN_PACKAGE_JSON,
      'App.tsx': SAMPLE_APP_TSX,
    });
    const actx = await makeRnContext({ cwd: android, tokens: { android: 'AND' } });
    await injectJsEntryStep.apply(actx);
    expect(await readFixture(android, 'App.tsx')).toContain(
      `if (BugseePlatform.OS === 'android') {\n  Bugsee.launch('AND');\n}`,
    );
    await cleanup(android);
  });

  it('refuses to write a launch when there is no token at all', async () => {
    fixture = await makeFixture({
      'package.json': SAMPLE_RN_PACKAGE_JSON,
      'App.tsx': SAMPLE_APP_TSX,
    });
    const ctx = await makeRnContext({ cwd: fixture, tokens: {} });
    await expect(injectJsEntryStep.apply(ctx)).rejects.toThrow(/token/);
    expect(await readFixture(fixture, 'App.tsx')).toBe(SAMPLE_APP_TSX);
  });

  it('a stale block (other token, or an old init block) is not satisfied, and is replaced on apply', async () => {
    fixture = await makeFixture({
      'package.json': SAMPLE_RN_PACKAGE_JSON,
      'App.tsx': SAMPLE_APP_TSX,
    });
    const old = await makeRnContext({ cwd: fixture, tokens: { android: 'OLDA', ios: 'OLDI' } });
    await injectJsEntryStep.apply(old);
    const legacy = `// bugsee:wizard:rn-init:begin\nBugsee.launch(;\n// bugsee:wizard:rn-init:end\n`;
    const withLegacy = legacy + (await readFixture(fixture, 'App.tsx'));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(`${fixture}/App.tsx`, withLegacy);
    const ctx = await makeRnContext({ cwd: fixture, tokens: { android: 'NEWA', ios: 'NEWI' } });
    expect(await injectJsEntryStep.precheck(ctx)).toEqual({ kind: 'pending' });
    await injectJsEntryStep.apply(ctx);
    const updated = await readFixture(fixture, 'App.tsx');
    expect(updated).toContain("'NEWI' : 'NEWA'");
    expect(updated).not.toContain('OLDI');
    expect(updated).not.toContain('rn-init');
    expect(updated.match(/rn-launch:begin/g)).toHaveLength(1);
    expect(await injectJsEntryStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
  });

  it('a launch block written for other tokens is pending, not satisfied', async () => {
    fixture = await makeFixture({
      'package.json': SAMPLE_RN_PACKAGE_JSON,
      'App.tsx': SAMPLE_APP_TSX,
    });
    await injectJsEntryStep.apply(
      await makeRnContext({ cwd: fixture, tokens: { android: 'OLDA', ios: 'OLDI' } }),
    );
    const ctx = await makeRnContext({ cwd: fixture, tokens: { android: 'NEWA', ios: 'NEWI' } });
    expect(await injectJsEntryStep.precheck(ctx)).toEqual({ kind: 'pending' });
  });

  it('never writes the old native-launch Bugsee.launch( any more', async () => {
    fixture = await makeFixture({
      'package.json': SAMPLE_RN_PACKAGE_JSON,
      'App.tsx': SAMPLE_APP_TSX,
    });
    const ctx = await makeRnContext({ cwd: fixture });
    await injectJsEntryStep.apply(ctx);
    const updated = await readFixture(fixture, 'App.tsx');
    expect(updated).not.toContain('Bugsee.initialize');
    expect(updated).toContain('Bugsee.launch(');
  });

  it('rolls back the init block an earlier wizard wrote for the native launch path', async () => {
    const legacy = `// bugsee:wizard:rn-init:begin\nimport Bugsee from 'react-native-bugsee';\n\nBugsee.launch(;\n// bugsee:wizard:rn-init:end\n`;
    fixture = await makeFixture({
      'package.json': SAMPLE_RN_PACKAGE_JSON,
      'App.tsx': `${legacy}${SAMPLE_APP_TSX}`,
    });
    const ctx = await makeRnContext({ cwd: fixture });
    await injectJsEntryStep.rollback(ctx);
    expect(await readFixture(fixture, 'App.tsx')).toBe(SAMPLE_APP_TSX);
  });

  it('injects after the last existing import', async () => {
    fixture = await makeFixture({
      'package.json': SAMPLE_RN_PACKAGE_JSON,
      'App.tsx': SAMPLE_APP_TSX,
    });
    const ctx = await makeRnContext({ cwd: fixture });
    await injectJsEntryStep.apply(ctx);
    const updated = await readFixture(fixture, 'App.tsx');
    const lastUserImport = updated.indexOf('import { SafeAreaView, Text }');
    const ourBlock = updated.indexOf('Bugsee.launch(');
    const fnDecl = updated.indexOf('function App()');
    expect(lastUserImport).toBeLessThan(ourBlock);
    expect(ourBlock).toBeLessThan(fnDecl);
  });

  it('rolls back to original (both launch and init markers stripped)', async () => {
    fixture = await makeFixture({
      'package.json': SAMPLE_RN_PACKAGE_JSON,
      'App.tsx': SAMPLE_APP_TSX,
    });
    const ctx = await makeRnContext({ cwd: fixture });
    const original = await readFixture(fixture, 'App.tsx');
    await injectJsEntryStep.apply(ctx);
    await injectJsEntryStep.rollback(ctx);
    expect(await readFixture(fixture, 'App.tsx')).toBe(original);
  });

  it('falls back to satisfied (snippet-printed) when JS entry is absent', async () => {
    fixture = await makeFixture({ 'package.json': SAMPLE_RN_PACKAGE_JSON });
    const ctx = await makeRnContext({ cwd: fixture });
    const status = await injectJsEntryStep.precheck(ctx);
    expect(status).toEqual({
      kind: 'satisfied',
      note: 'no App.tsx / index.js found — snippet will be printed at the end',
    });
  });

  it('is satisfied when auto-inject is not selected', async () => {
    fixture = await makeFixture({
      'package.json': SAMPLE_RN_PACKAGE_JSON,
      'App.tsx': SAMPLE_APP_TSX,
    });
    const ctx = await makeRnContext({ cwd: fixture, autoInjectJsEntry: false });
    expect(await injectJsEntryStep.precheck(ctx)).toEqual({
      kind: 'satisfied',
      note: 'auto-inject not selected',
    });
  });

  it('handles index.js (top-level entry) — splices after AppRegistry imports', async () => {
    fixture = await makeFixture({
      'package.json': SAMPLE_RN_PACKAGE_JSON,
      'index.js': SAMPLE_INDEX_JS,
    });
    const ctx = await makeRnContext({ cwd: fixture });
    await injectJsEntryStep.apply(ctx);
    const updated = await readFixture(fixture, 'index.js');
    expect(updated).toContain('Bugsee.launch(');
    const lastImport = updated.indexOf('import { name as appName }');
    const ourBlock = updated.indexOf('Bugsee.launch(');
    const registerCall = updated.indexOf('AppRegistry.registerComponent');
    expect(lastImport).toBeLessThan(ourBlock);
    expect(ourBlock).toBeLessThan(registerCall);
  });
});

describe('runPackageInstallStep — precheck branches', () => {
  it('is satisfied when not opted in', async () => {
    fixture = await makeFixture({
      'package.json': SAMPLE_RN_PACKAGE_JSON,
      'package-lock.json': '{}',
    });
    const ctx = await makeRnContext({ cwd: fixture, runPackageInstall: false });
    expect(await runPackageInstallStep.precheck(ctx)).toEqual({
      kind: 'satisfied',
      note: 'package install not requested',
    });
  });

  it('blocks when the detected package manager is not on PATH', async () => {
    managerAvailable = false;
    fixture = await makeFixture({
      'package.json': SAMPLE_RN_PACKAGE_JSON,
      'package-lock.json': '{}',
    });
    const ctx = await makeRnContext({ cwd: fixture, runPackageInstall: true });
    const status = await runPackageInstallStep.precheck(ctx);
    expect(status.kind).toBe('blocked');
  });

  it('is pending when opted in and manager is on PATH', async () => {
    fixture = await makeFixture({
      'package.json': SAMPLE_RN_PACKAGE_JSON,
      'package-lock.json': '{}',
    });
    const ctx = await makeRnContext({ cwd: fixture, runPackageInstall: true });
    expect(await runPackageInstallStep.precheck(ctx)).toEqual({ kind: 'pending' });
  });
});

// Apply path of runPackageInstallStep is intentionally not unit-tested —
// it spawns a real npm/yarn/pnpm/bun. Manual smoke-test against an RN
// fixture covers the happy path.
