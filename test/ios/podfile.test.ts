import { afterEach, describe, expect, it, vi } from 'vitest';

import { findTargetBlock } from '../../src/recipes/ios/podfile.js';
import { addPodStep } from '../../src/recipes/ios/steps/add-pod.js';
import {
  cleanup,
  makeFixture,
  makeIosContext,
  readFixture,
  SAMPLE_RN_PODFILE,
  SAMPLE_SIMPLE_PODFILE,
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

describe('findTargetBlock', () => {
  it('locates a simple top-level target', () => {
    const block = findTargetBlock(SAMPLE_SIMPLE_PODFILE, 'MyApp');
    expect(block).not.toBeNull();
    if (!block) return;
    const body = SAMPLE_SIMPLE_PODFILE.slice(block.bodyStart, block.bodyEnd);
    expect(body).toContain("pod 'SomeOtherPod'");
  });

  it('handles nested do/end (RN-style)', () => {
    const block = findTargetBlock(SAMPLE_RN_PODFILE, 'AwesomeProject');
    expect(block).not.toBeNull();
    if (!block) return;
    const body = SAMPLE_RN_PODFILE.slice(block.bodyStart, block.bodyEnd);
    // The body should include the inner test target *and* its end token.
    expect(body).toContain("target 'AwesomeProjectTests'");
    expect(body).toContain('inherit! :complete');
    // The matched end is the *outer* one, so bodyEnd should be near the end of the file.
    expect(SAMPLE_RN_PODFILE.length - block.end).toBeLessThan(5);
  });

  it('returns null when target name does not exist', () => {
    expect(findTargetBlock(SAMPLE_SIMPLE_PODFILE, 'Nope')).toBeNull();
  });

  it('ignores `do` keywords appearing inside strings/comments', () => {
    const src = `target 'X' do
  # do something here
  pod 'A', :git => "https://example.com/do-something.git"
  pod 'B'
end
`;
    const block = findTargetBlock(src, 'X');
    expect(block).not.toBeNull();
    if (!block) return;
    expect(src.slice(block.bodyStart, block.bodyEnd)).toContain("pod 'B'");
  });
});

describe('findTargetBlock with Ruby blocks', () => {
  const span = (src: string) => {
    const b = findTargetBlock(src, 'App');
    if (!b) throw new Error('target not found');
    return b;
  };

  it('does not close the target on the end of an inner if', () => {
    const src = `target 'App' do
  use_frameworks!
  if ENV['FOO'] == '1'
    pod 'Optional'
  end
  pod 'Other'
end
`;
    const b = span(src);
    expect(src.slice(b.bodyStart, b.bodyEnd)).toContain("pod 'Other'");
    expect(src.slice(b.end)).toBe('\n');
  });

  it('handles unless/case/begin/def/while/until/for, incl. loops with do', () => {
    const src = `target 'App' do
  unless ENV['A']
    pod 'A'
  end
  case ENV['B']
  when 'x'
    pod 'B'
  end
  begin
    pod 'C'
  rescue StandardError
    nil
  end
  def helper
    1
  end
  while false do
    pod 'W'
  end
  until true
    pod 'U'
  end
  for i in 1..2 do
    pod 'F'
  end
  x = if ENV['Z'] then 1 else 2 end
  pod 'Last'
end
`;
    const b = span(src);
    expect(src.slice(b.bodyStart, b.bodyEnd)).toContain("pod 'Last'");
    expect(src.slice(b.end)).toBe('\n');
  });

  it('does not count modifier forms or keywords in comments/strings', () => {
    const src = `target 'App' do
  pod 'A' if ENV['A']
  pod 'B' unless ENV['B']
  # if this were counted we would never close
  pod 'C', :path => "if/while"
end
`;
    const b = span(src);
    expect(src.slice(b.bodyStart, b.bodyEnd)).toContain("pod 'C'");
    expect(src.slice(b.end)).toBe('\n');
  });
});

let fixture: string | undefined;
afterEach(async () => {
  if (fixture) {
    await cleanup(fixture);
    fixture = undefined;
  }
});

describe('addPodStep', () => {
  it('adds pod line into the matching target block (simple Podfile)', async () => {
    fixture = await makeFixture({ Podfile: SAMPLE_SIMPLE_PODFILE });
    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: 'MyApp',
      podfilePath: `${fixture}/Podfile`,
      iosOptions: { distribution: 'cocoapods' },
    });
    expect(await addPodStep.precheck(ctx)).toEqual({ kind: 'pending' });
    await addPodStep.apply(ctx);
    const updated = await readFixture(fixture, 'Podfile');
    expect(updated).toContain("pod 'Bugsee'");
    expect(await addPodStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
  });

  it('adds pod into outer target only (RN-style nested test target)', async () => {
    fixture = await makeFixture({ Podfile: SAMPLE_RN_PODFILE });
    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: 'AwesomeProject',
      podfilePath: `${fixture}/Podfile`,
      iosOptions: { distribution: 'cocoapods' },
    });
    await addPodStep.apply(ctx);
    const updated = await readFixture(fixture, 'Podfile');
    // Pod lands in AwesomeProject body, not inside AwesomeProjectTests.
    const podIdx = updated.indexOf("pod 'Bugsee'");
    const innerTargetIdx = updated.indexOf("target 'AwesomeProjectTests'");
    const innerEndIdx = updated.indexOf('end', innerTargetIdx);
    // Pod should be either before the inner test target, or after its `end`.
    if (podIdx > innerTargetIdx) {
      expect(podIdx).toBeGreaterThan(innerEndIdx);
    }
  });

  it('inserts after an inner if block and re-run precheck is satisfied', async () => {
    const podfile = `target 'App' do
  use_frameworks!
  if ENV['FOO'] == '1'
    pod 'Optional'
  end
  pod 'Other'
end
`;
    fixture = await makeFixture({ Podfile: podfile });
    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: 'App',
      podfilePath: `${fixture}/Podfile`,
      iosOptions: { distribution: 'cocoapods' },
    });
    expect(await addPodStep.precheck(ctx)).toEqual({ kind: 'pending' });
    await addPodStep.apply(ctx);
    const updated = await readFixture(fixture, 'Podfile');
    expect(updated.indexOf("pod 'Bugsee'")).toBeGreaterThan(updated.indexOf("pod 'Other'"));
    expect(await addPodStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
    await addPodStep.rollback(ctx);
    expect(await readFixture(fixture, 'Podfile')).toBe(podfile);
  });

  it('rolls back to original Podfile', async () => {
    fixture = await makeFixture({ Podfile: SAMPLE_SIMPLE_PODFILE });
    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: 'MyApp',
      podfilePath: `${fixture}/Podfile`,
      iosOptions: { distribution: 'cocoapods' },
    });
    const original = await readFixture(fixture, 'Podfile');
    await addPodStep.apply(ctx);
    await addPodStep.rollback(ctx);
    const restored = await readFixture(fixture, 'Podfile');
    expect(restored).toBe(original);
  });

  it('is satisfied when distribution is SPM (no Podfile work)', async () => {
    fixture = await makeFixture({});
    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: 'MyApp',
      podfilePath: null,
      iosOptions: { distribution: 'spm' },
    });
    expect(await addPodStep.precheck(ctx)).toEqual({
      kind: 'satisfied',
      note: 'CocoaPods not selected',
    });
  });

  it('blocks when target name is not found', async () => {
    fixture = await makeFixture({ Podfile: SAMPLE_SIMPLE_PODFILE });
    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: 'NotMyApp',
      podfilePath: `${fixture}/Podfile`,
      iosOptions: { distribution: 'cocoapods' },
    });
    const status = await addPodStep.precheck(ctx);
    expect(status.kind).toBe('blocked');
  });
});
