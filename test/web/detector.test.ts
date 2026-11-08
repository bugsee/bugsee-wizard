import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { getDetectors, runDetectors } from '../../src/core/detect.js';
import { androidDetector } from '../../src/detectors/android.js';
import { registerAllDetectors } from '../../src/detectors/index.js';
import { iosDetector } from '../../src/detectors/ios.js';
import { javascriptDetector } from '../../src/detectors/javascript.js';
import { reactNativeDetector } from '../../src/detectors/react-native.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'js');
const fx = (n: string): string => path.join(FIXTURES, n);

describe('javascriptDetector', () => {
  it('is the javascript kind', () => {
    expect(javascriptDetector.kind).toBe('javascript');
  });

  it('is high confidence when a framework or build tool is identified, with evidence', async () => {
    const r = await javascriptDetector.detect({ cwd: fx('nextjs-app') });
    expect(r?.kind).toBe('javascript');
    expect(r?.confidence).toBe('high');
    expect(r?.evidence.map((e) => e.path)).toContain('package.json');
    expect(r?.evidence.map((e) => e.path)).toContain('next.config.mjs');
    const v = await javascriptDetector.detect({ cwd: fx('vite-react-spa') });
    expect(v?.confidence).toBe('high');
    expect(v?.evidence.map((e) => e.path)).toEqual(
      expect.arrayContaining([
        'package.json',
        'vite.config.ts',
        'tsconfig.json',
        'package-lock.json',
      ]),
    );
  });

  it('is high confidence for a framework whose build tool is the generic cli (Angular)', async () => {
    expect((await javascriptDetector.detect({ cwd: fx('angular-spa') }))?.confidence).toBe('high');
  });

  it('is medium confidence when only a generic runtime is guessed', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bugsee-js-plain-'));
    try {
      await writeFile(path.join(dir, 'package.json'), '{"name":"x"}');
      const r = await javascriptDetector.detect({ cwd: dir });
      expect(r?.confidence).toBe('medium');
      expect(r?.evidence.map((e) => e.path)).toContain('package.json');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is null for non-JS and for React Native, which the RN detector still owns', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bugsee-js-nonjs-'));
    try {
      expect(await javascriptDetector.detect({ cwd: dir })).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(await javascriptDetector.detect({ cwd: fx('react-native-app') })).toBeNull();
    const rn = await reactNativeDetector.detect({ cwd: fx('react-native-app') });
    expect(rn?.kind).toBe('react-native');
    expect(await androidDetector.detect({ cwd: fx('react-native-app') })).toBeNull();
    expect(await iosDetector.detect({ cwd: fx('react-native-app') })).toBeNull();
  });

  it('the non-js fixture is null without any temp dir', async () => {
    expect(await javascriptDetector.detect({ cwd: fx('non-js') })).toBeNull();
  });

  it('caps confidence at medium and says so in the evidence when the project was found above cwd', async () => {
    const start = path.join(fx('vite-react-spa'), 'src');
    const r = await javascriptDetector.detect({ cwd: start });
    expect(r?.confidence).toBe('medium');
    expect(r?.evidence.map((e) => e.note ?? '').join(' ')).toMatch(/above the current directory/);
  });

  it('an iOS project under a package.json ancestor yields only the iOS result', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bugsee-js-ios-'));
    try {
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'tools', devDependencies: { vite: '5.0.0' } }),
      );
      const app = path.join(dir, 'ios-app');
      await cp(
        path.join(FIXTURES, '..', 'ios', 'MinimalApp.xcodeproj'),
        path.join(app, 'MinimalApp.xcodeproj'),
        {
          recursive: true,
        },
      );
      registerAllDetectors();
      const results = await runDetectors({ cwd: app });
      expect(results.map((r) => r.kind)).toEqual(['ios']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('the ios fixture (under the repo package.json) yields only the iOS result', async () => {
    registerAllDetectors();
    const results = await runDetectors({ cwd: path.join(FIXTURES, '..', 'ios') });
    expect(results.map((r) => r.kind)).toEqual(['ios']);
  });

  it('notes the workspace for a monorepo root', async () => {
    const r = await javascriptDetector.detect({ cwd: fx('pnpm-monorepo') });
    expect(r?.confidence).toBe('medium');
    expect(r?.evidence.map((e) => e.note ?? '').join(' ')).toMatch(/workspace/);
  });

  it('is registered after react-native', () => {
    registerAllDetectors();
    const kinds = getDetectors().map((d) => d.kind);
    expect(kinds.indexOf('javascript')).toBeGreaterThan(kinds.indexOf('react-native'));
  });
});
