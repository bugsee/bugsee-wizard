import { writeFile } from 'node:fs/promises';
import path from 'node:path';
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

  describe('script newlines survive XML attribute normalization', () => {
    /** Raw `scriptText` attribute value as it sits in the file. */
    const rawScript = (xml: string) => /scriptText\s*=\s*"([^"]*)"/.exec(xml)?.[1] ?? '';
    /** What a conforming XML parser hands back for that attribute value. */
    const parsedScript = (xml: string) =>
      rawScript(xml)
        .replace(/\r\n?/g, '\n')
        .replace(/[\n\t]/g, ' ')
        .replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number(d)))
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
    /** Simulates Xcode re-saving: it writes newlines as `&#10;`. */
    const xcodeResave = (xml: string) =>
      xml.replace(
        /scriptText\s*=\s*"([^"]*)"/,
        (_m, v: string) => `scriptText = "${v.replace(/\n/g, '&#10;')}"`,
      );

    it('writes newlines as &#10; so a parser sees a multi-line script', async () => {
      fixture = await makeFixture({ [SCHEME_REL]: SAMPLE_XCSCHEME });
      const ctx = makeIosContext({
        cwd: fixture,
        schemeName: 'MyApp',
        tokens: { ios: 'TOK' },
        iosOptions: { sizeAnalysis: true, sizeAnalysisAllConfigurations: true },
      });
      await addSchemePostActionStep.apply(ctx);
      const xml = await readFixture(fixture, SCHEME_REL);
      expect(rawScript(xml)).not.toMatch(/[\n\r\t]/);
      expect(rawScript(xml)).toContain('&#10;');
      expect(parsedScript(xml).split('\n').length).toBeGreaterThan(5);
    });

    it('install -> parse -> script keeps one command per line', async () => {
      fixture = await makeFixture({ [SCHEME_REL]: SAMPLE_XCSCHEME });
      await addSchemePostActionStep.apply(
        makeIosContext({ cwd: fixture, schemeName: 'MyApp', tokens: { ios: 'TOK' } }),
      );
      const xml = await readFixture(fixture, SCHEME_REL);
      const decoded = rawScript(xml)
        .replace(/&#10;/g, '\n')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&');
      expect(decoded.split('\n')).toEqual([
        POSTACTION_SCRIPT_MARKER,
        `SCRIPT_SRC=$(find "$PROJECT_DIR" -name 'BugseeAgent' | head -1)`,
        'if [ ! "$' + '{SCRIPT_SRC}" ]; then',
        `  echo "Error: Bugsee build phase script not found. Make sure that you're including Bugsee in your project."`,
        '  exit 1',
        'fi',
        'python3 "$' + '{SCRIPT_SRC}" TOK',
      ]);
      // And the parser-visible form (what Xcode reads) is the same script.
      expect(parsedScript(xml)).toBe(decoded);
    });

    it('escapes tabs in attribute values and does not double-escape existing references', async () => {
      const ref = SAMPLE_XCSCHEME.replace(
        'BuildableName = "MyApp.app"',
        'BuildableName = "My&#9;App.app"',
      );
      fixture = await makeFixture({ [SCHEME_REL]: ref });
      await addSchemePostActionStep.apply(
        makeIosContext({ cwd: fixture, schemeName: 'MyApp', tokens: { ios: 'TOK' } }),
      );
      const xml = await readFixture(fixture, SCHEME_REL);
      // The original reference plus the one in our post-action.
      expect(xml.split('BuildableName = "My&#9;App.app"')).toHaveLength(3);
      expect(xml).not.toContain('&amp;#9;');
    });

    it('rollback removes our action after Xcode re-saved the scheme', async () => {
      fixture = await makeFixture({ [SCHEME_REL]: SAMPLE_XCSCHEME });
      const ctx = makeIosContext({ cwd: fixture, schemeName: 'MyApp', tokens: { ios: 'TOK' } });
      await addSchemePostActionStep.apply(ctx);
      await writeFile(
        path.join(fixture, SCHEME_REL),
        xcodeResave(await readFixture(fixture, SCHEME_REL)),
      );
      expect(await addSchemePostActionStep.precheck(ctx)).toEqual({ kind: 'satisfied' });
      await addSchemePostActionStep.rollback(ctx);
      expect(await readFixture(fixture, SCHEME_REL)).toBe(SAMPLE_XCSCHEME);
    });

    it('rollback removes our action even when a parser flattened it to one line', async () => {
      fixture = await makeFixture({ [SCHEME_REL]: SAMPLE_XCSCHEME });
      const ctx = makeIosContext({ cwd: fixture, schemeName: 'MyApp', tokens: { ios: 'TOK' } });
      await addSchemePostActionStep.apply(ctx);
      const xml = await readFixture(fixture, SCHEME_REL);
      // Hand-flatten: what a literal-newline file looks like after a parse + re-save.
      await writeFile(path.join(fixture, SCHEME_REL), xml.replace(/&#10;/g, ' '));
      await addSchemePostActionStep.rollback(ctx);
      expect(await readFixture(fixture, SCHEME_REL)).toBe(SAMPLE_XCSCHEME);
    });

    it('rollback removes a flattened earlier-version (unmarked) action but keeps a near match', async () => {
      const flat =
        `SCRIPT_SRC=$(find "$PROJECT_DIR" -name 'BugseeAgent' | head -1) if [ ! "$` +
        `{SCRIPT_SRC}" ]; then echo "Error: Bugsee build phase script not found. Make sure that you're including Bugsee in your project." exit 1 fi python3 "$` +
        `{SCRIPT_SRC}" OLD`;
      const make = (script: string) =>
        SAMPLE_XCSCHEME.replace(
          '   </ArchiveAction>',
          `      <PostActions>
         <ExecutionAction
            ActionType = "Xcode.IDEStandardExecutionActionsCore.ExecutionActionType.ShellScriptAction">
            <ActionContent
               title = "Bugsee Symbolication"
               scriptText = "${script.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"
               shellToInvoke = "/bin/sh">
            </ActionContent>
         </ExecutionAction>
      </PostActions>
   </ArchiveAction>`,
        );
      fixture = await makeFixture({ [SCHEME_REL]: make(flat) });
      const ctx = makeIosContext({ cwd: fixture, schemeName: 'MyApp' });
      await addSchemePostActionStep.rollback(ctx);
      expect(await readFixture(fixture, SCHEME_REL)).toBe(SAMPLE_XCSCHEME);

      const user = make(`echo hi ${flat}`);
      await writeFile(path.join(fixture, SCHEME_REL), user);
      await addSchemePostActionStep.rollback(ctx);
      expect(await readFixture(fixture, SCHEME_REL)).toBe(user);
    });
  });
});
