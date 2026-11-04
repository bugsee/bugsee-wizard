import { afterEach, describe, expect, it, vi } from 'vitest';

import { injectAppDelegateStep } from '../../src/recipes/ios/steps/inject-app-delegate.js';
import {
  cleanup,
  makeFixture,
  makeIosContext,
  readFixture,
  SAMPLE_APP_DELEGATE_OBJC,
  SAMPLE_APP_DELEGATE_SWIFT,
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

describe('injectAppDelegateStep — Swift', () => {
  const REL = 'MyApp/AppDelegate.swift';

  it('inserts import + Bugsee.launch into didFinishLaunchingWithOptions', async () => {
    fixture = await makeFixture({ [REL]: SAMPLE_APP_DELEGATE_SWIFT });
    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: 'MyApp',
      appDelegate: { path: `${fixture}/${REL}`, language: 'swift' },
      iosOptions: { autoInjectAppDelegate: true },
      tokens: { ios: 'TOK' },
    });
    expect(await injectAppDelegateStep.precheck(ctx)).toEqual({ kind: 'pending' });
    await injectAppDelegateStep.apply(ctx);
    const updated = await readFixture(fixture, REL);
    expect(updated).toContain('import Bugsee');
    expect(updated).toContain('Bugsee.launch(token: "TOK")');
    // Bugsee.launch must land *inside* the function body, before "return true".
    const launchIdx = updated.indexOf('Bugsee.launch');
    const returnIdx = updated.indexOf('return true');
    expect(launchIdx).toBeLessThan(returnIdx);
    expect(await injectAppDelegateStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
  });

  it('rolls back to original Swift source', async () => {
    fixture = await makeFixture({ [REL]: SAMPLE_APP_DELEGATE_SWIFT });
    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: 'MyApp',
      appDelegate: { path: `${fixture}/${REL}`, language: 'swift' },
      iosOptions: { autoInjectAppDelegate: true },
    });
    const original = await readFixture(fixture, REL);
    await injectAppDelegateStep.apply(ctx);
    await injectAppDelegateStep.rollback(ctx);
    expect(await readFixture(fixture, REL)).toBe(original);
  });

  it('is satisfied when auto-inject is not selected', async () => {
    fixture = await makeFixture({});
    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: 'MyApp',
      appDelegate: null,
      iosOptions: { autoInjectAppDelegate: false },
    });
    expect(await injectAppDelegateStep.precheck(ctx)).toEqual({
      kind: 'satisfied',
      note: 'auto-inject not selected',
    });
  });

  // C5 regression: SwiftUI `@main App` projects don't have AppDelegate at all.
  // Wizard must fall back gracefully — satisfied + note rather than blocked.
  it('falls back to satisfied when auto-inject is on but no AppDelegate exists', async () => {
    fixture = await makeFixture({});
    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: 'MyApp',
      appDelegate: null,
      iosOptions: { autoInjectAppDelegate: true },
    });
    const status = await injectAppDelegateStep.precheck(ctx);
    expect(status.kind).toBe('satisfied');
    if (status.kind === 'satisfied') {
      expect(status.note).toMatch(/no AppDelegate found/);
    }
  });

  // C5 regression: a small AppDelegate adapter (e.g. for @UIApplicationDelegateAdaptor)
  // that doesn't override didFinishLaunchingWithOptions must not block the run.
  it('falls back to satisfied when AppDelegate has no didFinishLaunchingWithOptions', async () => {
    const REL = 'MyApp/AppDelegate.swift';
    fixture = await makeFixture({
      [REL]:
        'import UIKit\n\nclass AppDelegate: NSObject, UIApplicationDelegate {\n  // adapter only — no didFinishLaunching override\n}\n',
    });
    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: 'MyApp',
      appDelegate: { path: `${fixture}/${REL}`, language: 'swift' },
      iosOptions: { autoInjectAppDelegate: true },
    });
    const status = await injectAppDelegateStep.precheck(ctx);
    expect(status.kind).toBe('satisfied');
    if (status.kind === 'satisfied') {
      expect(status.note).toMatch(/didFinishLaunchingWithOptions/);
    }
  });
});

describe('injectAppDelegateStep — Objective-C', () => {
  const REL = 'MyApp/AppDelegate.m';

  it('inserts #import + [Bugsee launchWithToken:] into didFinishLaunchingWithOptions', async () => {
    fixture = await makeFixture({ [REL]: SAMPLE_APP_DELEGATE_OBJC });
    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: 'MyApp',
      appDelegate: { path: `${fixture}/${REL}`, language: 'objc' },
      iosOptions: { autoInjectAppDelegate: true },
      tokens: { ios: 'TOK' },
    });
    await injectAppDelegateStep.apply(ctx);
    const updated = await readFixture(fixture, REL);
    expect(updated).toContain('#import <Bugsee/Bugsee.h>');
    expect(updated).toContain('[Bugsee launchWithToken:@"TOK"];');
    const launchIdx = updated.indexOf('[Bugsee launchWithToken:');
    const returnIdx = updated.indexOf('return YES');
    expect(launchIdx).toBeLessThan(returnIdx);
  });

  it('rolls back to original Objective-C source', async () => {
    fixture = await makeFixture({ [REL]: SAMPLE_APP_DELEGATE_OBJC });
    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: 'MyApp',
      appDelegate: { path: `${fixture}/${REL}`, language: 'objc' },
      iosOptions: { autoInjectAppDelegate: true },
    });
    const original = await readFixture(fixture, REL);
    await injectAppDelegateStep.apply(ctx);
    await injectAppDelegateStep.rollback(ctx);
    expect(await readFixture(fixture, REL)).toBe(original);
  });
});
