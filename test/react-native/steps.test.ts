import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensureRnBugseePackageStep } from '../../src/recipes/react-native/steps/ensure-rn-bugsee-package.js';
import { injectJsEntryStep } from '../../src/recipes/react-native/steps/inject-js-entry.js';
import { runPackageInstallStep } from '../../src/recipes/react-native/steps/run-package-install.js';
import {
  SAMPLE_APP_TSX,
  SAMPLE_INDEX_JS,
  SAMPLE_RN_PACKAGE_JSON,
  cleanup,
  makeFixture,
  makeRnContext,
  readFixture,
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
  spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
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
  it('adds react-native-bugsee to dependencies when missing', async () => {
    fixture = await makeFixture({ 'package.json': SAMPLE_RN_PACKAGE_JSON });
    const ctx = await makeRnContext({ cwd: fixture });
    expect(await ensureRnBugseePackageStep.precheck(ctx)).toEqual({ kind: 'pending' });
    await ensureRnBugseePackageStep.apply(ctx);
    const updated = JSON.parse(await readFixture(fixture, 'package.json'));
    expect(updated.dependencies['react-native-bugsee']).toBeDefined();
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
    expect(written).toContain('    "react-native-bugsee":');
  });

  it('rolls back by deleting the dependency entry', async () => {
    fixture = await makeFixture({ 'package.json': SAMPLE_RN_PACKAGE_JSON });
    const ctx = await makeRnContext({ cwd: fixture });
    await ensureRnBugseePackageStep.apply(ctx);
    await ensureRnBugseePackageStep.rollback(ctx);
    const updated = JSON.parse(await readFixture(fixture, 'package.json'));
    expect(updated.dependencies['react-native-bugsee']).toBeUndefined();
  });

  it('is satisfied when the dep already exists in devDependencies', async () => {
    const withDep = JSON.parse(SAMPLE_RN_PACKAGE_JSON);
    withDep.devDependencies['react-native-bugsee'] = '^4.0.0';
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
  it('injects Bugsee.launch with Platform check (JS launch path)', async () => {
    fixture = await makeFixture({
      'package.json': SAMPLE_RN_PACKAGE_JSON,
      'App.tsx': SAMPLE_APP_TSX,
    });
    const ctx = await makeRnContext({
      cwd: fixture,
      launchPath: 'javascript',
      tokens: { android: 'AND', ios: 'IOS' },
    });
    await injectJsEntryStep.apply(ctx);
    const updated = await readFixture(fixture, 'App.tsx');
    expect(updated).toContain(`import Bugsee from 'react-native-bugsee'`);
    expect(updated).toContain(`import { Platform } from 'react-native'`);
    expect(updated).toContain(`Bugsee.launch(Platform.OS === 'ios' ? 'IOS' : 'AND')`);
    expect(await injectJsEntryStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
  });

  it('injects Bugsee.initialize() (native launch path)', async () => {
    fixture = await makeFixture({
      'package.json': SAMPLE_RN_PACKAGE_JSON,
      'App.tsx': SAMPLE_APP_TSX,
    });
    const ctx = await makeRnContext({
      cwd: fixture,
      launchPath: 'native',
    });
    await injectJsEntryStep.apply(ctx);
    const updated = await readFixture(fixture, 'App.tsx');
    expect(updated).toContain(`import Bugsee from 'react-native-bugsee'`);
    expect(updated).toContain('Bugsee.initialize()');
    expect(updated).not.toContain('Bugsee.launch');
    expect(updated).not.toContain('Platform.OS');
  });

  it('injects after the last existing import', async () => {
    fixture = await makeFixture({
      'package.json': SAMPLE_RN_PACKAGE_JSON,
      'App.tsx': SAMPLE_APP_TSX,
    });
    const ctx = await makeRnContext({ cwd: fixture, launchPath: 'native' });
    await injectJsEntryStep.apply(ctx);
    const updated = await readFixture(fixture, 'App.tsx');
    const lastUserImport = updated.indexOf('import { SafeAreaView, Text }');
    const ourBlock = updated.indexOf('Bugsee.initialize()');
    const fnDecl = updated.indexOf('function App()');
    expect(lastUserImport).toBeLessThan(ourBlock);
    expect(ourBlock).toBeLessThan(fnDecl);
  });

  it('rolls back to original (both launch and init markers stripped)', async () => {
    fixture = await makeFixture({
      'package.json': SAMPLE_RN_PACKAGE_JSON,
      'App.tsx': SAMPLE_APP_TSX,
    });
    const ctx = await makeRnContext({ cwd: fixture, launchPath: 'native' });
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
    const ctx = await makeRnContext({ cwd: fixture, launchPath: 'native' });
    await injectJsEntryStep.apply(ctx);
    const updated = await readFixture(fixture, 'index.js');
    expect(updated).toContain('Bugsee.initialize()');
    const lastImport = updated.indexOf('import { name as appName }');
    const ourBlock = updated.indexOf('Bugsee.initialize()');
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
