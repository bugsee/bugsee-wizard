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

describe('injectAppDelegateStep — existing launch with a different token', () => {
  it.each([
    ['swift', 'MyApp/AppDelegate.swift', SAMPLE_APP_DELEGATE_SWIFT],
    ['objc', 'MyApp/AppDelegate.m', SAMPLE_APP_DELEGATE_OBJC],
  ] as const)('warns (%s) but stays satisfied', async (language, rel, source) => {
    fixture = await makeFixture({ [rel]: source });
    const make = (token: string) =>
      makeIosContext({
        cwd: fixture as string,
        schemeName: 'MyApp',
        appDelegate: { path: `${fixture}/${rel}`, language },
        iosOptions: { autoInjectAppDelegate: true },
        tokens: { ios: token },
      });
    await injectAppDelegateStep.apply(make('OLD'));
    const warn = vi.mocked((await import('@clack/prompts')).log.warn);
    warn.mockClear();

    expect(await injectAppDelegateStep.precheck(make('OLD'))).toEqual({ kind: 'satisfied' });
    expect(warn).not.toHaveBeenCalled();

    expect(await injectAppDelegateStep.precheck(make('NEW'))).toEqual({ kind: 'satisfied' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/different token/i);
  });
});

describe('injectAppDelegateStep — launch must be active code inside didFinishLaunching', () => {
  const SWIFT_COMMENT = `import UIKit
import Bugsee

class AppDelegate: UIResponder, UIApplicationDelegate {
    // TODO: Bugsee.launch(token: "OLD")
    /* Bugsee.launch(token: "OLD") */
    let note = "Bugsee.launch(token: \\"OLD\\")"
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        return true
    }
}
`;
  const SWIFT_OTHER_METHOD = `import UIKit
import Bugsee

class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        return true
    }
    func applicationDidBecomeActive(_ application: UIApplication) {
        Bugsee.launch(token: "OLD")
    }
}
`;
  const OBJC_COMMENT = `#import "AppDelegate.h"
#import <Bugsee/Bugsee.h>

@implementation AppDelegate
// [Bugsee launchWithToken:@"OLD"];
- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
    /* [Bugsee launchWithToken:@"OLD"]; */
    return YES;
}
@end
`;
  const OBJC_OTHER_METHOD = `#import "AppDelegate.h"
#import <Bugsee/Bugsee.h>

@implementation AppDelegate
- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
    return YES;
}
- (void)applicationDidBecomeActive:(UIApplication *)application {
    [Bugsee launchWithToken:@"OLD"];
}
@end
`;
  // Comments and strings INSIDE the body, carrying a call and a stray brace:
  // the brace must not end the body early and the call must not count.
  const SWIFT_BODY_COMMENT = `import UIKit
import Bugsee

class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Bugsee.launch(token: "OLD") }
        /* Bugsee.launch(token: "OLD") } */
        let s = "Bugsee.launch(token: 1) }"
        let open = "{"
        let q = "\\" Bugsee.launch(token: 1)"
        return true
    }
    func applicationDidBecomeActive(_ application: UIApplication) {
        Bugsee.launch(token: "OLD")
    }
}
`;
  const OBJC_BODY_COMMENT = `#import "AppDelegate.h"
#import <Bugsee/Bugsee.h>

@implementation AppDelegate
- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
    // [Bugsee launchWithToken:@"OLD"]; }
    /* [Bugsee launchWithToken:@"OLD"]; } */
    NSString *s = @"[Bugsee launchWithToken:@\\"OLD\\"]; }";
    char c = '{';
    return YES;
}
- (void)applicationDidBecomeActive:(UIApplication *)application {
    [Bugsee launchWithToken:@"OLD"];
}
@end
`;
  const cases = [
    ['swift comment/string in body', 'swift', 'MyApp/AppDelegate.swift', SWIFT_BODY_COMMENT],
    ['objc comment/string in body', 'objc', 'MyApp/AppDelegate.m', OBJC_BODY_COMMENT],
    ['swift comment/string only', 'swift', 'MyApp/AppDelegate.swift', SWIFT_COMMENT],
    ['swift other method', 'swift', 'MyApp/AppDelegate.swift', SWIFT_OTHER_METHOD],
    ['objc comment only', 'objc', 'MyApp/AppDelegate.m', OBJC_COMMENT],
    ['objc other method', 'objc', 'MyApp/AppDelegate.m', OBJC_OTHER_METHOD],
  ] as const;

  it.each(cases)(
    '%s: precheck pending, apply injects into didFinishLaunching',
    async (_n, language, rel, source) => {
      fixture = await makeFixture({ [rel]: source });
      const ctx = makeIosContext({
        cwd: fixture,
        schemeName: 'MyApp',
        appDelegate: { path: `${fixture}/${rel}`, language },
        iosOptions: { autoInjectAppDelegate: true },
        tokens: { ios: 'NEW' },
      });
      expect(await injectAppDelegateStep.precheck(ctx)).toEqual({ kind: 'pending' });
      await injectAppDelegateStep.apply(ctx);
      const updated = await readFixture(fixture, rel);
      const call =
        language === 'swift' ? 'Bugsee.launch(token: "NEW")' : '[Bugsee launchWithToken:@"NEW"];';
      const funcIdx = updated.indexOf('didFinishLaunchingWithOptions');
      const callIdx = updated.indexOf(call);
      expect(callIdx).toBeGreaterThan(funcIdx);
      expect(updated.indexOf('return', funcIdx)).toBeGreaterThan(callIdx);
      expect(await injectAppDelegateStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
      await injectAppDelegateStep.rollback(ctx);
      expect(await readFixture(fixture, rel)).toBe(source);
    },
  );

  it.each([
    [
      'swift',
      'MyApp/AppDelegate.swift',
      SAMPLE_APP_DELEGATE_SWIFT.replace(
        'return true',
        'if true { }\n        Bugsee.launch(token: "HAND")\n        return true',
      ).replace('import UIKit', 'import UIKit\nimport Bugsee'),
    ],
    [
      'objc',
      'MyApp/AppDelegate.m',
      SAMPLE_APP_DELEGATE_OBJC.replace(
        'return YES',
        'if (YES) { }\n    [Bugsee launchWithToken:@"HAND"];\n    return YES',
      ).replace('#import "AppDelegate.h"', '#import "AppDelegate.h"\n#import <Bugsee/Bugsee.h>'),
    ],
  ] as const)(
    '%s: a hand-written launch inside the method stays satisfied',
    async (language, rel, source) => {
      fixture = await makeFixture({ [rel]: source });
      const ctx = makeIosContext({
        cwd: fixture,
        schemeName: 'MyApp',
        appDelegate: { path: `${fixture}/${rel}`, language },
        iosOptions: { autoInjectAppDelegate: true },
        tokens: { ios: 'HAND' },
      });
      expect(await injectAppDelegateStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
    },
  );

  it('marker block fast path: satisfied even when the method cannot be located', async () => {
    const rel = 'MyApp/AppDelegate.swift';
    fixture = await makeFixture({
      [rel]: `import UIKit
import Bugsee
// bugsee:wizard:launch:begin
Bugsee.launch(token: "X")
// bugsee:wizard:launch:end
`,
    });
    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: 'MyApp',
      appDelegate: { path: `${fixture}/${rel}`, language: 'swift' },
      iosOptions: { autoInjectAppDelegate: true },
      tokens: { ios: 'X' },
    });
    expect(await injectAppDelegateStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
  });
});
