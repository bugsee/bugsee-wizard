import { afterEach, describe, expect, it } from 'vitest';

import { readInstalledNativeVersions } from '../../src/recipes/react-native/native-versions.js';
import {
  MIN_REACT_NATIVE,
  readRnProjectInfo,
  usesPodsForWrapper,
} from '../../src/recipes/react-native/project-info.js';
import { cleanup, makeFixture } from './helpers.js';

let dir: string | undefined;
afterEach(async () => {
  if (dir) await cleanup(dir);
  dir = undefined;
});

const pkg = (deps: Record<string, string>, dev: Record<string, string> = {}) =>
  JSON.stringify({ name: 'app', dependencies: deps, devDependencies: dev });

describe('readRnProjectInfo', () => {
  it('flags the legacy package, in dependencies or devDependencies', async () => {
    dir = await makeFixture({
      'package.json': pkg({ 'react-native': '0.81.0', 'react-native-bugsee': '^6.0.0' }),
    });
    expect((await readRnProjectInfo(dir)).legacyPackage).toBe(true);
    await cleanup(dir);
    dir = await makeFixture({
      'package.json': pkg({ 'react-native': '0.81.0' }, { 'react-native-bugsee': '6.1.0' }),
    });
    expect((await readRnProjectInfo(dir)).legacyPackage).toBe(true);
    await cleanup(dir);
    dir = await makeFixture({ 'package.json': pkg({ 'react-native': '0.81.0' }) });
    expect((await readRnProjectInfo(dir)).legacyPackage).toBe(false);
  });

  it('notices an Expo project from its expo dependency', async () => {
    dir = await makeFixture({ 'package.json': pkg({ expo: '~55.0.0', 'react-native': '0.83.0' }) });
    expect((await readRnProjectInfo(dir)).hasExpo).toBe(true);
    await cleanup(dir);
    dir = await makeFixture({ 'package.json': pkg({ 'react-native': '0.83.0' }) });
    expect((await readRnProjectInfo(dir)).hasExpo).toBe(false);
  });

  it('notices the new package already being there', async () => {
    dir = await makeFixture({ 'package.json': pkg({ '@bugsee/react-native': '^7.0.0-beta3' }) });
    expect((await readRnProjectInfo(dir)).hasWrapper).toBe(true);
  });

  it('takes the React Native version from node_modules when installed, else from the range', async () => {
    dir = await makeFixture({
      'package.json': pkg({ 'react-native': '^0.76.0' }),
      'node_modules/react-native/package.json': JSON.stringify({ version: '0.82.1' }),
    });
    expect((await readRnProjectInfo(dir)).reactNativeVersion).toBe('0.82.1');
    await cleanup(dir);
    dir = await makeFixture({ 'package.json': pkg({ 'react-native': '^0.81.2' }) });
    expect((await readRnProjectInfo(dir)).reactNativeVersion).toBe('0.81.2');
  });

  it('leaves the version null when it cannot be known (tag, url, missing)', async () => {
    for (const range of ['latest', 'github:facebook/react-native', 'workspace:*']) {
      dir = await makeFixture({ 'package.json': pkg({ 'react-native': range }) });
      expect((await readRnProjectInfo(dir)).reactNativeVersion, range).toBeNull();
      await cleanup(dir);
    }
    dir = await makeFixture({ 'package.json': pkg({}) });
    expect((await readRnProjectInfo(dir)).reactNativeVersion).toBeNull();
  });

  it('survives an unreadable package.json', async () => {
    dir = await makeFixture({ 'package.json': '{ not json' });
    expect(await readRnProjectInfo(dir)).toEqual({
      legacyPackage: false,
      hasWrapper: false,
      hasExpo: false,
      reactNativeVersion: null,
    });
  });
});

describe('usesPodsForWrapper (React Native 0.87+ resolves the SDK through SPM)', () => {
  it('is true before 0.87, false from 0.87, and true when unknown (the safe default)', () => {
    expect(usesPodsForWrapper('0.81.0')).toBe(true);
    expect(usesPodsForWrapper('0.86.9')).toBe(true);
    expect(usesPodsForWrapper('0.87.0')).toBe(false);
    expect(usesPodsForWrapper('0.87.1')).toBe(false);
    expect(usesPodsForWrapper('1.0.0')).toBe(false);
    expect(usesPodsForWrapper(null)).toBe(true);
  });

  it('the minimum is 0.81', () => {
    expect(MIN_REACT_NATIVE).toBe('0.81.0');
  });
});

describe('readInstalledNativeVersions', () => {
  const VALID = JSON.stringify({
    android: { sdk: '7.4.2', gradlePlugin: '4.0.8' },
    ios: { sdk: '7.0.0', spmUrl: 'https://github.com/bugsee/spm' },
  });

  it('reads the pins from the installed package', async () => {
    dir = await makeFixture({ 'node_modules/@bugsee/react-native/native-versions.json': VALID });
    expect(await readInstalledNativeVersions(dir)).toEqual({
      androidSdk: '7.4.2',
      androidGradlePlugin: '4.0.8',
      iosSdk: '7.0.0',
    });
  });

  it('finds a hoisted install in a parent directory (monorepo)', async () => {
    dir = await makeFixture({
      'node_modules/@bugsee/react-native/native-versions.json': VALID,
      'apps/mobile/package.json': '{}',
    });
    expect(await readInstalledNativeVersions(`${dir}/apps/mobile`)).not.toBeNull();
  });

  it('is null when not installed, unreadable or missing a pin', async () => {
    dir = await makeFixture({ 'package.json': '{}' });
    expect(await readInstalledNativeVersions(dir)).toBeNull();
    await cleanup(dir);
    for (const body of [
      'nope',
      '{}',
      JSON.stringify({ android: { sdk: '7.4.2' }, ios: { sdk: '7' } }),
    ]) {
      dir = await makeFixture({ 'node_modules/@bugsee/react-native/native-versions.json': body });
      expect(await readInstalledNativeVersions(dir), body).toBeNull();
      await cleanup(dir);
    }
    dir = undefined;
  });
});
