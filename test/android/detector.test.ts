import { afterEach, describe, expect, it, vi } from 'vitest';

import { androidDetector } from '../../src/detectors/android.js';
import {
  SAMPLE_KOTLIN_APP_BUILD,
  SAMPLE_KOTLIN_SETTINGS_WITH_MAVEN,
  cleanup,
  makeFixture,
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
}));

let fixture: string | undefined;
afterEach(async () => {
  if (fixture) {
    await cleanup(fixture);
    fixture = undefined;
  }
});

describe('androidDetector', () => {
  it('detects an app/build.gradle.kts with com.android.application', async () => {
    fixture = await makeFixture({
      'settings.gradle.kts': SAMPLE_KOTLIN_SETTINGS_WITH_MAVEN,
      'app/build.gradle.kts': SAMPLE_KOTLIN_APP_BUILD,
    });
    const result = await androidDetector.detect({ cwd: fixture });
    expect(result?.kind).toBe('android');
    expect(result?.confidence).toBe('high');
  });

  it('returns null when no app build script is present', async () => {
    fixture = await makeFixture({
      'package.json': '{}',
      'index.js': 'console.log("hi")',
    });
    const result = await androidDetector.detect({ cwd: fixture });
    expect(result).toBeNull();
  });

  it('returns null when build.gradle exists but does not apply com.android.application', async () => {
    fixture = await makeFixture({
      'app/build.gradle.kts': `plugins { id("com.android.library") }`,
    });
    const result = await androidDetector.detect({ cwd: fixture });
    expect(result).toBeNull();
  });
});
