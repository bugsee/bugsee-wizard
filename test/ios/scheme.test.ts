import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  addSchemePostActionStep,
  POSTACTION_SCRIPT_MARKER,
} from '../../src/recipes/ios/steps/add-scheme-postaction.js';
import {
  cleanup,
  makeFixture,
  makeIosContext,
  readFixture,
  SAMPLE_XCSCHEME,
  SAMPLE_XCSCHEME_SELFCLOSING_ARCHIVE,
  SAMPLE_XCSCHEME_WITH_USER_POSTACTION,
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

const SCHEME_REL = 'MyApp.xcodeproj/xcshareddata/xcschemes/MyApp.xcscheme';

describe('addSchemePostActionStep', () => {
  it('adds a post-action with Bugsee Symbolication title', async () => {
    fixture = await makeFixture({ [SCHEME_REL]: SAMPLE_XCSCHEME });
    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: 'MyApp',
      tokens: { ios: 'TOK' },
    });
    expect(await addSchemePostActionStep.precheck(ctx)).toEqual({ kind: 'pending' });
    await addSchemePostActionStep.apply(ctx);
    const updated = await readFixture(fixture, SCHEME_REL);
    expect(updated).toContain('<PostActions>');
    expect(updated).toContain('title = "Bugsee Symbolication"');
    expect(updated).toContain('python3');
    // Token should appear in the script text (XML-escaped is identical for plain alphanum)
    expect(updated).toContain('TOK');
    expect(await addSchemePostActionStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
  });

  it('emits BUGSEE_SIZE_ANALYSIS_ENABLED when sizeAnalysis is on', async () => {
    fixture = await makeFixture({ [SCHEME_REL]: SAMPLE_XCSCHEME });
    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: 'MyApp',
      iosOptions: { sizeAnalysis: true },
    });
    await addSchemePostActionStep.apply(ctx);
    const updated = await readFixture(fixture, SCHEME_REL);
    expect(updated).toContain('BUGSEE_SIZE_ANALYSIS_ENABLED=1');
    expect(updated).not.toContain('BUGSEE_SIZE_ANALYSIS_ALL_CONFIGURATIONS=1');
  });

  it('emits BUGSEE_SIZE_ANALYSIS_ALL_CONFIGURATIONS when opted in', async () => {
    fixture = await makeFixture({ [SCHEME_REL]: SAMPLE_XCSCHEME });
    const ctx = makeIosContext({
      cwd: fixture,
      schemeName: 'MyApp',
      iosOptions: { sizeAnalysis: true, sizeAnalysisAllConfigurations: true },
    });
    await addSchemePostActionStep.apply(ctx);
    const updated = await readFixture(fixture, SCHEME_REL);
    expect(updated).toContain('BUGSEE_SIZE_ANALYSIS_ENABLED=1');
    expect(updated).toContain('BUGSEE_SIZE_ANALYSIS_ALL_CONFIGURATIONS=1');
  });

  it('embeds BuildableReference identifiers from the existing BuildAction', async () => {
    fixture = await makeFixture({ [SCHEME_REL]: SAMPLE_XCSCHEME });
    const ctx = makeIosContext({ cwd: fixture, schemeName: 'MyApp' });
    await addSchemePostActionStep.apply(ctx);
    const updated = await readFixture(fixture, SCHEME_REL);
    // Sample's BlueprintIdentifier is "AAAA1111BBBB2222CCCC3333"; check that the
    // post-action's EnvironmentBuildable reuses it so $PROJECT_DIR etc. resolve.
    const envBuildable = /<EnvironmentBuildable>[\s\S]*?<\/EnvironmentBuildable>/.exec(updated);
    expect(envBuildable).not.toBeNull();
    expect(envBuildable?.[0]).toContain('AAAA1111BBBB2222CCCC3333');
    expect(envBuildable?.[0]).toContain('MyApp.app');
  });

  it('rolls back to original scheme XML', async () => {
    fixture = await makeFixture({ [SCHEME_REL]: SAMPLE_XCSCHEME });
    const ctx = makeIosContext({ cwd: fixture, schemeName: 'MyApp' });
    const original = await readFixture(fixture, SCHEME_REL);
    await addSchemePostActionStep.apply(ctx);
    await addSchemePostActionStep.rollback(ctx);
    const restored = await readFixture(fixture, SCHEME_REL);
    expect(restored).toBe(original);
  });

  // B2 regression: self-closing <ArchiveAction/> must be expanded before splice.
  it('handles a self-closing <ArchiveAction /> tag', async () => {
    fixture = await makeFixture({ [SCHEME_REL]: SAMPLE_XCSCHEME_SELFCLOSING_ARCHIVE });
    const ctx = makeIosContext({ cwd: fixture, schemeName: 'MyApp' });
    expect(await addSchemePostActionStep.precheck(ctx)).toEqual({ kind: 'pending' });
    await addSchemePostActionStep.apply(ctx);
    const updated = await readFixture(fixture, SCHEME_REL);
    expect(updated).toContain('<PostActions>');
    expect(updated).toContain('title = "Bugsee Symbolication"');
    // Self-closing form was replaced with paired form.
    expect(updated).not.toMatch(/<ArchiveAction\b[^>]*\/>/);
    expect(updated).toContain('</ArchiveAction>');
  });

  // B1 regression: rollback must NOT touch a user's pre-existing PostAction.
  it('preserves user PostActions on rollback', async () => {
    fixture = await makeFixture({ [SCHEME_REL]: SAMPLE_XCSCHEME_WITH_USER_POSTACTION });
    const ctx = makeIosContext({ cwd: fixture, schemeName: 'MyApp' });
    const original = await readFixture(fixture, SCHEME_REL);
    await addSchemePostActionStep.apply(ctx);
    const afterApply = await readFixture(fixture, SCHEME_REL);
    expect(afterApply).toContain('User Custom Script');
    expect(afterApply).toContain('Bugsee Symbolication');
    await addSchemePostActionStep.rollback(ctx);
    const afterRollback = await readFixture(fixture, SCHEME_REL);
    expect(afterRollback).toContain('User Custom Script');
    expect(afterRollback).not.toContain('Bugsee Symbolication');
    // The user's PostAction wrapper is intact.
    expect(afterRollback).toContain('<PostActions>');
    expect(afterRollback).toContain('</PostActions>');
    // And the XML structure is well-formed (no orphaned tags).
    expect(afterRollback).toBe(original);
  });

  // B1 regression: idempotency check must also be scoped — re-running over
  // a scheme that already has our post-action should report satisfied.
  it('precheck recognizes our own post-action after apply (round-trip)', async () => {
    fixture = await makeFixture({ [SCHEME_REL]: SAMPLE_XCSCHEME_WITH_USER_POSTACTION });
    const ctx = makeIosContext({ cwd: fixture, schemeName: 'MyApp' });
    await addSchemePostActionStep.apply(ctx);
    expect(await addSchemePostActionStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
  });

  describe('rollback only removes the action this wizard wrote', () => {
    const LEGACY_SCRIPT = [
      `SCRIPT_SRC=$(find "$PROJECT_DIR" -name 'BugseeAgent' | head -1)`,
      'if [ ! "$' + '{SCRIPT_SRC}" ]; then',
      `  echo "Error: Bugsee build phase script not found. Make sure that you're including Bugsee in your project."`,
      '  exit 1',
      'fi',
      'python3 "$' + '{SCRIPT_SRC}" OLDTOKEN',
    ].join('\n');
    const esc = (t: string) =>
      t.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const withAction = (script: string, newline: string) =>
      SAMPLE_XCSCHEME.replace(
        '   </ArchiveAction>',
        `      <PostActions>
         <ExecutionAction
            ActionType = "Xcode.IDEStandardExecutionActionsCore.ExecutionActionType.ShellScriptAction">
            <ActionContent
               title = "Bugsee Symbolication"
               scriptText = "${esc(script).replace(/\n/g, newline)}"
               shellToInvoke = "/bin/sh">
            </ActionContent>
         </ExecutionAction>
      </PostActions>
   </ArchiveAction>`,
      );

    it('writes a wizard marker into the script', async () => {
      fixture = await makeFixture({ [SCHEME_REL]: SAMPLE_XCSCHEME });
      await addSchemePostActionStep.apply(makeIosContext({ cwd: fixture, schemeName: 'MyApp' }));
      expect(await readFixture(fixture, SCHEME_REL)).toContain(POSTACTION_SCRIPT_MARKER);
    });

    it('keeps a user action that merely shares the title', async () => {
      const userScheme = withAction('echo "my own symbolication"', '\n');
      fixture = await makeFixture({ [SCHEME_REL]: userScheme });
      await addSchemePostActionStep.rollback(makeIosContext({ cwd: fixture, schemeName: 'MyApp' }));
      expect(await readFixture(fixture, SCHEME_REL)).toBe(userScheme);
    });

    it('keeps a same-title user action ending in our python call but with extra content', async () => {
      const userScheme = withAction(`echo "pre-step"\n${LEGACY_SCRIPT}`, '\n');
      fixture = await makeFixture({ [SCHEME_REL]: userScheme });
      await addSchemePostActionStep.rollback(makeIosContext({ cwd: fixture, schemeName: 'MyApp' }));
      expect(await readFixture(fixture, SCHEME_REL)).toBe(userScheme);
    });

    it('keeps a same-title user action whose script only resembles ours', async () => {
      const userScheme = withAction(`${LEGACY_SCRIPT}\necho extra`, '\n');
      fixture = await makeFixture({ [SCHEME_REL]: userScheme });
      await addSchemePostActionStep.rollback(makeIosContext({ cwd: fixture, schemeName: 'MyApp' }));
      expect(await readFixture(fixture, SCHEME_REL)).toBe(userScheme);
    });

    it.each(['\n', '&#10;'])(
      'removes an unmarked action written by the earlier version (newline %j)',
      async (nl) => {
        fixture = await makeFixture({ [SCHEME_REL]: withAction(LEGACY_SCRIPT, nl) });
        await addSchemePostActionStep.rollback(
          makeIosContext({ cwd: fixture, schemeName: 'MyApp' }),
        );
        expect(await readFixture(fixture, SCHEME_REL)).toBe(SAMPLE_XCSCHEME);
      },
    );

    it('removes an unmarked earlier-version action with size-analysis exports', async () => {
      const script = LEGACY_SCRIPT.replace(
        'python3',
        'export BUGSEE_SIZE_ANALYSIS_ENABLED=1\nexport BUGSEE_SIZE_ANALYSIS_ALL_CONFIGURATIONS=1\npython3',
      );
      fixture = await makeFixture({ [SCHEME_REL]: withAction(script, '\n') });
      await addSchemePostActionStep.rollback(makeIosContext({ cwd: fixture, schemeName: 'MyApp' }));
      expect(await readFixture(fixture, SCHEME_REL)).toBe(SAMPLE_XCSCHEME);
    });
  });
});
