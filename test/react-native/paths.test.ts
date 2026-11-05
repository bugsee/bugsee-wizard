import { afterEach, describe, expect, it, vi } from 'vitest';

import { discoverJsEntry, discoverRnPaths } from '../../src/recipes/react-native/paths.js';
import { cleanup, makeFixture, SAMPLE_APP_TSX, SAMPLE_INDEX_JS } from './helpers.js';

vi.mock('@clack/prompts', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    step: vi.fn(),
    message: vi.fn(),
  },
}));

let fixture: string | undefined;
afterEach(async () => {
  if (fixture) {
    await cleanup(fixture);
    fixture = undefined;
  }
});

describe('discoverJsEntry', () => {
  it('prefers App.tsx over App.jsx / App.js', async () => {
    fixture = await makeFixture({
      'App.tsx': SAMPLE_APP_TSX,
      'App.js': '// stub',
      'index.js': SAMPLE_INDEX_JS,
    });
    const entry = await discoverJsEntry(fixture);
    expect(entry?.language).toBe('tsx');
    expect(entry?.kind).toBe('app-component');
    expect(entry?.path.endsWith('App.tsx')).toBe(true);
  });

  it('prefers App.jsx over index files when no App.tsx', async () => {
    fixture = await makeFixture({ 'App.jsx': SAMPLE_APP_TSX, 'index.js': SAMPLE_INDEX_JS });
    const entry = await discoverJsEntry(fixture);
    expect(entry?.language).toBe('jsx');
    expect(entry?.kind).toBe('app-component');
  });

  it('falls back to index.js as a top-level entry', async () => {
    fixture = await makeFixture({ 'index.js': SAMPLE_INDEX_JS });
    const entry = await discoverJsEntry(fixture);
    expect(entry?.language).toBe('js');
    expect(entry?.kind).toBe('top-level');
  });

  it('returns null when neither App.* nor index.* is present', async () => {
    fixture = await makeFixture({ 'package.json': '{}' });
    const entry = await discoverJsEntry(fixture);
    expect(entry).toBeNull();
  });
});

describe('discoverRnPaths', () => {
  it('reports presence of android/ and ios/ subdirs and the JS entry', async () => {
    fixture = await makeFixture({
      'package.json': '{}',
      'App.tsx': SAMPLE_APP_TSX,
      'android/build.gradle': '// stub',
      'ios/AwesomeProject.xcodeproj/project.pbxproj': '// stub',
    });
    const paths = await discoverRnPaths(fixture);
    expect(paths.androidPath?.endsWith('/android')).toBe(true);
    expect(paths.iosPath?.endsWith('/ios')).toBe(true);
    expect(paths.jsEntry?.kind).toBe('app-component');
    expect(paths.packageJson.endsWith('/package.json')).toBe(true);
  });

  it('an ios/ directory without an Xcode project (a Podfile only) is not a platform', async () => {
    fixture = await makeFixture({
      'package.json': '{}',
      'android/build.gradle': '// stub',
      'ios/Podfile': "platform :ios, '15.1'\n",
    });
    const paths = await discoverRnPaths(fixture);
    expect(paths.androidPath?.endsWith('/android')).toBe(true);
    expect(paths.iosPath).toBeNull();
  });

  it('reports null platform paths when subdirs are missing', async () => {
    fixture = await makeFixture({ 'package.json': '{}' });
    const paths = await discoverRnPaths(fixture);
    expect(paths.androidPath).toBeNull();
    expect(paths.iosPath).toBeNull();
    expect(paths.jsEntry).toBeNull();
  });
});
