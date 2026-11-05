import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runRollback, runSteps } from '../../src/core/step.js';
import {
  DSYM_ACTION_TITLE,
  dsymPostActionScript,
  iosXcodeSteps,
} from '../../src/recipes/react-native/steps/ios-xcode.js';
import {
  SAMPLE_XCSCHEME,
  SAMPLE_XCSCHEME_SELFCLOSING_ARCHIVE,
  SAMPLE_XCSCHEME_WITH_USER_POSTACTION,
} from '../ios/helpers.js';
import { cleanup, makeFixture, makeRnContext, SAMPLE_RN_PACKAGE_JSON } from './helpers.js';

const TOKEN = 'SECRET-IOS-TOKEN-1234';
const PBX = 'ios/MyApp.xcodeproj/project.pbxproj';
const SCHEME = 'ios/MyApp.xcodeproj/xcshareddata/xcschemes/MyApp.xcscheme';

// RN 0.74-0.75 template: unquoted invocation.
const SCRIPT_074 =
  'set -e\\n\\nWITH_ENVIRONMENT=\\"$REACT_NATIVE_PATH/scripts/xcode/with-environment.sh\\"\\nREACT_NATIVE_XCODE=\\"$REACT_NATIVE_PATH/scripts/react-native-xcode.sh\\"\\n\\n/bin/sh -c \\"$WITH_ENVIRONMENT $REACT_NATIVE_XCODE\\"\\n';
// RN 0.76+ template: quoted invocation.
const SCRIPT_076 =
  'set -e\\n\\nWITH_ENVIRONMENT=\\"$REACT_NATIVE_PATH/scripts/xcode/with-environment.sh\\"\\nREACT_NATIVE_XCODE=\\"$REACT_NATIVE_PATH/scripts/react-native-xcode.sh\\"\\n\\n/bin/sh -c \\"\\\\\\"$WITH_ENVIRONMENT\\\\\\" \\\\\\"$REACT_NATIVE_XCODE\\\\\\"\\"\\n';
// RN 0.71-0.72 template: relative paths, no REACT_NATIVE_PATH.
const SCRIPT_072 =
  'set -e\\n\\nWITH_ENVIRONMENT=\\"../node_modules/react-native/scripts/xcode/with-environment.sh\\"\\nREACT_NATIVE_XCODE=\\"../node_modules/react-native/scripts/react-native-xcode.sh\\"\\n\\n/bin/sh -c \\"$WITH_ENVIRONMENT $REACT_NATIVE_XCODE\\"\\n';

function pbx(scripts: string[], name = 'Bundle React Native code and images'): string {
  const phases = scripts
    .map(
      (s, i) => `\t\t00DD1BFF1BD5951E006B06B${i} /* ${name} */ = {
\t\t\tisa = PBXShellScriptBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t);
\t\t\tinputPaths = (
\t\t\t\t"$(SRCROOT)/.xcode.env.local",
\t\t\t\t"$(SRCROOT)/.xcode.env",
\t\t\t);
\t\t\tname = "${name}";
\t\t\toutputPaths = (
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t\tshellPath = /bin/sh;
\t\t\tshellScript = "${s}";
\t\t};
\t\t00EEFC60759A1932668264C${i} /* [CP] Embed Pods Frameworks */ = {
\t\t\tisa = PBXShellScriptBuildPhase;
\t\t\tname = "[CP] Embed Pods Frameworks";
\t\t\tshellPath = /bin/sh;
\t\t\tshellScript = "\\"\${PODS_ROOT}/Pods-frameworks.sh\\"\\n";
\t\t};
`,
    )
    .join('');
  return `// !$*UTF8*$!
{
\tobjects = {

/* Begin PBXShellScriptBuildPhase section */
${phases}/* End PBXShellScriptBuildPhase section */
\t};
}
`;
}

const base = { 'package.json': SAMPLE_RN_PACKAGE_JSON };

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map(cleanup));
  dirs = [];
});

async function setup(
  files: Record<string, string>,
  opts: { tokens?: Record<string, string>; dryRun?: boolean } = {},
) {
  const dir = await makeFixture({ ...base, ...files });
  dirs.push(dir);
  const ctx = await makeRnContext({ cwd: dir, tokens: opts.tokens ?? { ios: TOKEN } });
  return { dir, ctx: opts.dryRun ? { ...ctx, dryRun: true } : ctx };
}

const read = (dir: string, rel: string) => readFile(path.join(dir, rel), 'utf8');
const readOr = async (dir: string, rel: string) => {
  try {
    return await read(dir, rel);
  } catch {
    return null;
  }
};

const step = (id: string) => {
  const s = iosXcodeSteps.find((x) => x.id === id);
  if (!s) throw new Error(id);
  return s;
};

const full = (script = SCRIPT_074) => ({
  [PBX]: pbx([script]),
  [SCHEME]: SAMPLE_XCSCHEME,
});

describe('iosXcodeSteps', () => {
  it('exports the four steps in order', () => {
    expect(iosXcodeSteps.map((s) => s.id)).toEqual([
      'rn.ios.bundle-phase',
      'rn.ios.dsym-postaction',
      'rn.ios.xcode-env-gitignore',
      'rn.ios.xcode-env-token',
    ]);
  });

  describe('skips', () => {
    it('is satisfied everywhere without an iOS token', async () => {
      const { ctx, dir } = await setup(full(), { tokens: { android: 'A' } });
      for (const s of iosXcodeSteps) {
        expect(await s.precheck(ctx)).toEqual({ kind: 'satisfied', note: expect.any(String) });
      }
      const before = await read(dir, PBX);
      await runSteps(iosXcodeSteps, ctx);
      expect(await read(dir, PBX)).toBe(before);
      expect(await readOr(dir, 'ios/.xcode.env.local')).toBeNull();
    });

    it('is satisfied everywhere without an ios directory', async () => {
      const { ctx } = await setup({});
      for (const s of iosXcodeSteps) {
        expect(await s.precheck(ctx)).toEqual({ kind: 'satisfied', note: 'No ios/ directory' });
      }
    });

    it('is satisfied (with a note) when ios/ has no xcodeproj', async () => {
      const { ctx } = await setup({ 'ios/Podfile': '' });
      for (const id of ['rn.ios.bundle-phase', 'rn.ios.dsym-postaction']) {
        expect((await step(id).precheck(ctx)).kind).toBe('satisfied');
      }
    });
  });

  describe('bundle phase', () => {
    it.each([
      ['0.74 (unquoted invocation)', SCRIPT_074],
      ['0.76 (quoted invocation)', SCRIPT_076],
    ])('rewrites the RN %s template and rolls back byte-exact', async (_n, script) => {
      const { ctx, dir } = await setup(full(script));
      const original = await read(dir, PBX);
      const s = step('rn.ios.bundle-phase');
      expect((await s.precheck(ctx)).kind).toBe('pending');
      expect(await s.apply(ctx)).toBeUndefined();
      const after = await read(dir, PBX);
      expect(after).toContain(
        'REACT_NATIVE_XCODE=\\"${SRCROOT}/../node_modules/@bugsee/react-native/scripts/bugsee-xcode.sh\\"',
      );
      expect(after).not.toMatch(
        /REACT_NATIVE_XCODE=\\"\$REACT_NATIVE_PATH\/scripts\/react-native-xcode/,
      );
      expect(after).toContain(
        '/bin/sh -c \\"\\\\\\"$WITH_ENVIRONMENT\\\\\\" \\\\\\"$REACT_NATIVE_XCODE\\\\\\"\\"',
      );
      // untouched neighbours
      expect(after).toContain('[CP] Embed Pods Frameworks');
      expect(after).toContain(
        'set -e\\n\\nWITH_ENVIRONMENT=\\"$REACT_NATIVE_PATH/scripts/xcode/with-environment.sh\\"',
      );
      expect((await s.precheck(ctx)).kind).toBe('satisfied');
      await s.rollback(ctx);
      expect(await read(dir, PBX)).toBe(original);
    });

    it('is idempotent: a second apply changes nothing', async () => {
      const { ctx, dir } = await setup(full());
      const s = step('rn.ios.bundle-phase');
      await s.apply(ctx);
      const once = await read(dir, PBX);
      await s.apply(ctx);
      expect(await read(dir, PBX)).toBe(once);
    });

    it('treats a hand-edited bugsee-xcode.sh phase as satisfied and leaves it alone on rollback', async () => {
      const handmade = SCRIPT_076.replace('react-native-xcode.sh', 'bugsee-xcode.sh');
      const { ctx, dir } = await setup(full(handmade));
      const s = step('rn.ios.bundle-phase');
      expect((await s.precheck(ctx)).kind).toBe('satisfied');
      const before = await read(dir, PBX);
      await s.rollback(ctx);
      expect(await read(dir, PBX)).toBe(before);
    });

    it('keeps the user lines and rewrites every matching phase (several targets)', async () => {
      const custom = SCRIPT_074.replace('set -e', 'set -e\\nexport FOO=bar');
      const { ctx, dir } = await setup(full(custom));
      const content = pbx([custom, SCRIPT_076]);
      await (await import('node:fs/promises')).writeFile(path.join(dir, PBX), content);
      const s = step('rn.ios.bundle-phase');
      await s.apply(ctx);
      const after = await read(dir, PBX);
      expect(after.match(/bugsee-xcode\.sh/g)?.length).toBe(2);
      expect(after).toContain('export FOO=bar');
      await s.rollback(ctx);
      expect(await read(dir, PBX)).toBe(content);
    });

    it('returns a manual snippet (no token) for RN templates without REACT_NATIVE_PATH', async () => {
      const { ctx, dir } = await setup(full(SCRIPT_072));
      const before = await read(dir, PBX);
      const res = await step('rn.ios.bundle-phase').apply(ctx);
      expect(res?.manual?.file).toContain('project.pbxproj');
      expect(res?.manual?.code).toContain('bugsee-xcode.sh');
      expect(JSON.stringify(res)).not.toContain(TOKEN);
      expect(await read(dir, PBX)).toBe(before);
    });

    it('returns manual for an unrecognised script shape', async () => {
      const { ctx } = await setup(full('echo custom\\n'));
      const res = await step('rn.ios.bundle-phase').apply(ctx);
      expect(res?.manual).toBeDefined();
    });

    it('returns manual when the phase is missing', async () => {
      const { ctx } = await setup({
        [PBX]: pbx([SCRIPT_074], 'Something else'),
        [SCHEME]: SAMPLE_XCSCHEME,
      });
      const s = step('rn.ios.bundle-phase');
      expect((await s.precheck(ctx)).kind).toBe('pending');
      const res = await s.apply(ctx);
      expect(res?.manual?.title).toContain('phase not found');
    });

    it('ignores other phases that merely mention react-native-xcode.sh', async () => {
      const content = pbx([SCRIPT_074], 'Other phase');
      const { ctx, dir } = await setup({ [PBX]: content, [SCHEME]: SAMPLE_XCSCHEME });
      await step('rn.ios.bundle-phase').apply(ctx);
      expect(await read(dir, PBX)).toBe(content);
    });
  });

  describe('scheme post-action', () => {
    const s = step('rn.ios.dsym-postaction');

    it.each([
      ['empty ArchiveAction', SAMPLE_XCSCHEME],
      ['existing user post-action', SAMPLE_XCSCHEME_WITH_USER_POSTACTION],
    ])('adds the action to a scheme with %s and rolls back byte-exact', async (_n, scheme) => {
      const { ctx, dir } = await setup({ [PBX]: pbx([SCRIPT_074]), [SCHEME]: scheme });
      expect((await s.precheck(ctx)).kind).toBe('pending');
      await s.apply(ctx);
      const after = await read(dir, SCHEME);
      expect(after).toContain(`title = "${DSYM_ACTION_TITLE}"`);
      expect(after).toContain('xcode post-action');
      expect(after).toContain('BlueprintIdentifier = "AAAA1111BBBB2222CCCC3333"');
      expect(after).not.toContain(TOKEN);
      expect(after.match(/<PostActions>/g)?.length).toBe(1);
      expect((await s.precheck(ctx)).kind).toBe('satisfied');
      await s.rollback(ctx);
      expect(await read(dir, SCHEME)).toBe(scheme);
    });

    it('the script exits 0 before running bugsee-cli without a real token', () => {
      const script = dsymPostActionScript();
      const guard = script.indexOf('TOKEN_CHECK=');
      expect(guard).toBeGreaterThan(-1);
      expect(script.indexOf('exit 0', guard)).toBeLessThan(script.indexOf('run_cli "$'));
      expect(script).toContain('the app token is the placeholder');
      expect(script).toContain('BUGSEE_TOKEN_IOS');
      expect(script).toContain('.xcode.env.local');
    });

    it('is idempotent', async () => {
      const { ctx, dir } = await setup(full());
      await s.apply(ctx);
      const once = await read(dir, SCHEME);
      expect((await s.precheck(ctx)).kind).toBe('satisfied');
      await runSteps([s], ctx);
      expect(await read(dir, SCHEME)).toBe(once);
    });

    it('recognises the Expo-plugin / example dSYM action as already done and keeps it on rollback', async () => {
      const theirs = SAMPLE_XCSCHEME_WITH_USER_POSTACTION.replace(
        'title = "User Custom Script"',
        'title = "Upload dSYMs"',
      ).replace('echo &quot;hello&quot;', 'node cli xcode post-action');
      const { ctx, dir } = await setup({ [PBX]: pbx([SCRIPT_074]), [SCHEME]: theirs });
      expect((await s.precheck(ctx)).kind).toBe('satisfied');
      await s.rollback(ctx);
      expect(await read(dir, SCHEME)).toBe(theirs);
    });

    it('does not collide with the native iOS recipe action (different title)', async () => {
      const native = SAMPLE_XCSCHEME_WITH_USER_POSTACTION.replace(
        'title = "User Custom Script"',
        'title = "Bugsee Symbolication"',
      ).replace('echo &quot;hello&quot;', 'python3 BugseeAgent');
      const { ctx, dir } = await setup({ [PBX]: pbx([SCRIPT_074]), [SCHEME]: native });
      expect((await s.precheck(ctx)).kind).toBe('pending');
      await s.apply(ctx);
      expect(await read(dir, SCHEME)).toContain('Bugsee Symbolication');
      await s.rollback(ctx);
      expect(await read(dir, SCHEME)).toBe(native);
    });

    it('returns manual (no token) for a self-closing ArchiveAction', async () => {
      const { ctx, dir } = await setup({
        [PBX]: pbx([SCRIPT_074]),
        [SCHEME]: SAMPLE_XCSCHEME_SELFCLOSING_ARCHIVE,
      });
      const res = await s.apply(ctx);
      expect(res?.manual?.file).toContain('.xcscheme');
      expect(res?.manual?.code).toContain('xcode post-action');
      expect(JSON.stringify(res)).not.toContain(TOKEN);
      expect(await read(dir, SCHEME)).toBe(SAMPLE_XCSCHEME_SELFCLOSING_ARCHIVE);
    });

    it('returns manual when the scheme has no .app reference', async () => {
      const noApp = SAMPLE_XCSCHEME.replace('MyApp.app', 'MyApp.framework');
      const { ctx } = await setup({ [PBX]: pbx([SCRIPT_074]), [SCHEME]: noApp });
      expect((await s.apply(ctx))?.manual).toBeDefined();
    });
  });

  describe('token + gitignore', () => {
    const tokenStep = step('rn.ios.xcode-env-token');
    const ignoreStep = step('rn.ios.xcode-env-gitignore');

    it('creates .xcode.env.local with the token and deletes it on rollback', async () => {
      const { ctx, dir } = await setup(full());
      expect((await tokenStep.precheck(ctx)).kind).toBe('pending');
      await tokenStep.apply(ctx);
      const content = await read(dir, 'ios/.xcode.env.local');
      expect(content).toContain(`export BUGSEE_TOKEN_IOS=${TOKEN}`);
      expect((await tokenStep.precheck(ctx)).kind).toBe('satisfied');
      await tokenStep.rollback(ctx);
      expect(await readOr(dir, 'ios/.xcode.env.local')).toBeNull();
    });

    it.each(['export NODE_BINARY=/x\n', 'export NODE_BINARY=/x'])(
      'keeps existing content %j and restores it exactly',
      async (existing) => {
        const { ctx, dir } = await setup({ ...full(), 'ios/.xcode.env.local': existing });
        await tokenStep.apply(ctx);
        const after = await read(dir, 'ios/.xcode.env.local');
        expect(after.startsWith(existing)).toBe(true);
        expect(after).toContain(TOKEN);
        await tokenStep.rollback(ctx);
        expect(await read(dir, 'ios/.xcode.env.local')).toBe(existing);
      },
    );

    it('replaces our block when the token changed, without duplicating', async () => {
      const { ctx, dir } = await setup({ ...full(), 'ios/.xcode.env.local': 'A=1\n' });
      await tokenStep.apply(ctx);
      const ctx2 = { ...ctx, tokens: { ios: 'OTHER-TOKEN' } };
      expect((await tokenStep.precheck(ctx2)).kind).toBe('pending');
      await tokenStep.apply(ctx2);
      const after = await read(dir, 'ios/.xcode.env.local');
      expect(after).toContain('OTHER-TOKEN');
      expect(after).not.toContain(TOKEN);
      expect(after.match(/BUGSEE_TOKEN_IOS/g)?.length).toBe(1);
      await tokenStep.rollback(ctx2);
      expect(await read(dir, 'ios/.xcode.env.local')).toBe('A=1\n');
    });

    it("leaves the user's own token export alone", async () => {
      const own = 'export BUGSEE_APP_TOKEN=mine\n';
      const { ctx, dir } = await setup({ ...full(), 'ios/.xcode.env.local': own });
      expect((await tokenStep.precheck(ctx)).kind).toBe('satisfied');
      await tokenStep.rollback(ctx);
      expect(await read(dir, 'ios/.xcode.env.local')).toBe(own);
    });

    it('quotes a token with shell metacharacters', async () => {
      const { ctx, dir } = await setup(full(), { tokens: { ios: "a b'c" } });
      await tokenStep.apply(ctx);
      expect(await read(dir, 'ios/.xcode.env.local')).toContain(
        "export BUGSEE_TOKEN_IOS='a b'\\''c'",
      );
    });

    it('adds the git-ignore entry when missing, appending to an existing file', async () => {
      const { ctx, dir } = await setup({ ...full(), 'ios/.gitignore': 'build/\nPods/' });
      expect((await ignoreStep.precheck(ctx)).kind).toBe('pending');
      await ignoreStep.apply(ctx);
      const after = await read(dir, 'ios/.gitignore');
      expect(after.startsWith('build/\nPods/\n')).toBe(true);
      expect(after).toContain('.xcode.env.local');
      expect((await ignoreStep.precheck(ctx)).kind).toBe('satisfied');
      await ignoreStep.rollback(ctx);
      expect(await read(dir, 'ios/.gitignore')).toBe('build/\nPods/');
    });

    it('creates ios/.gitignore when absent and removes it on rollback', async () => {
      const { ctx, dir } = await setup(full());
      await ignoreStep.apply(ctx);
      expect(await read(dir, 'ios/.gitignore')).toContain('.xcode.env.local');
      await ignoreStep.rollback(ctx);
      expect(await readOr(dir, 'ios/.gitignore')).toBeNull();
    });

    it.each([
      ['ios/.gitignore', '# Xcode\n.xcode.env.local\n'],
      ['.gitignore', 'node_modules\nios/.xcode.env.local\n'],
    ])('is satisfied when %s already ignores it', async (file, content) => {
      const { ctx } = await setup({ ...full(), [file]: content });
      expect(await ignoreStep.precheck(ctx)).toEqual({
        kind: 'satisfied',
        note: '.xcode.env.local is already git-ignored',
      });
    });

    it('rollbacks are no-ops when nothing was written', async () => {
      const { ctx } = await setup({});
      await tokenStep.rollback(ctx);
      await ignoreStep.rollback(ctx);
      const { ctx: c2 } = await setup(full());
      for (const s of iosXcodeSteps) await s.rollback(c2);
    });
  });

  describe('whole flow', () => {
    it('applies, is a no-op the second time, and rolls everything back byte-exact', async () => {
      const { ctx, dir } = await setup({
        ...full(SCRIPT_076),
        'ios/.gitignore': 'Pods/\n',
        'ios/.xcode.env.local': 'export NODE_BINARY=/n\n',
      });
      const files = [PBX, SCHEME, 'ios/.gitignore', 'ios/.xcode.env.local'];
      const originals = await Promise.all(files.map((f) => read(dir, f)));
      const first = await runSteps(iosXcodeSteps, ctx);
      expect(first.failed).toBe(false);
      expect(first.incomplete).toBe(false);
      expect(first.results.map((r) => r.outcome)).toEqual([
        'applied',
        'applied',
        'applied',
        'applied',
      ]);
      const afterFirst = await Promise.all(files.map((f) => read(dir, f)));
      const second = await runSteps(iosXcodeSteps, ctx);
      expect(second.results.every((r) => r.outcome === 'skipped')).toBe(true);
      expect(await Promise.all(files.map((f) => read(dir, f)))).toEqual(afterFirst);
      const rb = await runRollback(iosXcodeSteps, ctx);
      expect(rb.failed).toBe(false);
      expect(await Promise.all(files.map((f) => read(dir, f)))).toEqual(originals);
    });

    it('dry-run writes nothing', async () => {
      const { ctx, dir } = await setup(full(), { dryRun: true });
      const before = await read(dir, PBX);
      await runSteps(iosXcodeSteps, ctx);
      expect(await read(dir, PBX)).toBe(before);
      expect(await read(dir, SCHEME)).toBe(SAMPLE_XCSCHEME);
      expect(await readOr(dir, 'ios/.xcode.env.local')).toBeNull();
      expect(await readOr(dir, 'ios/.gitignore')).toBeNull();
    });

    it('the token only ever lands in .xcode.env.local', async () => {
      const { ctx, dir } = await setup(full());
      await runSteps(iosXcodeSteps, ctx);
      for (const f of [PBX, SCHEME, 'ios/.gitignore']) {
        expect(await read(dir, f)).not.toContain(TOKEN);
      }
      expect(await read(dir, 'ios/.xcode.env.local')).toContain(TOKEN);
    });

    it('a manual bundle phase does not stop the other steps and reports a snippet', async () => {
      const { ctx } = await setup(full('echo custom\\n'));
      const res = await runSteps(iosXcodeSteps, ctx);
      expect(res.incomplete).toBe(true);
      expect(res.results[0]?.outcome).toBe('manual');
      expect(res.results[0]?.snippet?.code).not.toContain(TOKEN);
      expect(res.results.slice(1).every((r) => r.outcome === 'applied')).toBe(true);
    });
  });
});
