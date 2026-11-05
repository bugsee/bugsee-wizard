import { afterEach, describe, expect, it, vi } from 'vitest';

import { iosDetector } from '../../src/detectors/ios.js';
import { cleanup, makeFixture } from './helpers.js';

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

describe('iosDetector', () => {
  it('detects an .xcodeproj at the project root', async () => {
    fixture = await makeFixture({ 'MyApp.xcodeproj/project.pbxproj': '// stub' });
    const result = await iosDetector.detect({ cwd: fixture });
    expect(result?.kind).toBe('ios');
    expect(result?.confidence).toBe('high');
  });

  it("does NOT detect a nested ios/ layout — that is the RN detector's job", async () => {
    fixture = await makeFixture({
      'ios/AwesomeProject.xcodeproj/project.pbxproj': '// stub',
    });
    const result = await iosDetector.detect({ cwd: fixture });
    // iosDetector now only matches cwd-level .xcodeproj; the RN root
    // case is handled by reactNativeDetector + the RN recipe overlaying
    // cwd to `<root>/ios` before delegating to the iOS recipe.
    expect(result).toBeNull();
  });

  it('returns null when no xcodeproj is present', async () => {
    fixture = await makeFixture({ 'README.md': '' });
    const result = await iosDetector.detect({ cwd: fixture });
    expect(result).toBeNull();
  });
});
