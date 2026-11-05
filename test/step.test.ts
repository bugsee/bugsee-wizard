import * as clack from '@clack/prompts';
import { describe, expect, it, vi } from 'vitest';

import type { WizardContext } from '../src/core/context.js';
import { createLogger } from '../src/core/logger.js';
import { runRollback, runSteps, type Step } from '../src/core/step.js';

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

function makeContext(overrides: Partial<WizardContext> = {}): WizardContext {
  return {
    cwd: '/tmp',
    debug: false,
    dryRun: false,
    nonInteractive: false,
    json: false,
    ignoreGitChanges: false,
    yes: false,
    kind: 'unknown',
    tokens: {},
    log: createLogger({ debug: false }),
    ...overrides,
  };
}

interface Trace {
  readonly calls: string[];
}

function makeStep(id: string, trace: Trace, overrides: Partial<Step> = {}): Step {
  return {
    id,
    title: `Step ${id}`,
    precheck: async () => ({ kind: 'pending' }),
    apply: async () => {
      trace.calls.push(`apply:${id}`);
    },
    rollback: async () => {
      trace.calls.push(`rollback:${id}`);
    },
    ...overrides,
  };
}

describe('runSteps', () => {
  it('skips satisfied steps and applies pending ones in order', async () => {
    const trace: Trace = { calls: [] };
    const a = makeStep('a', trace, {
      precheck: async () => ({ kind: 'satisfied' }),
    });
    const b = makeStep('b', trace);

    const result = await runSteps([a, b], makeContext());

    expect(result.failed).toBe(false);
    expect(trace.calls).toEqual(['apply:b']);
    expect(result.results.map((r) => r.outcome)).toEqual(['skipped', 'applied']);
  });

  it('rolls back applied steps in reverse on apply failure', async () => {
    const trace: Trace = { calls: [] };
    const a = makeStep('a', trace);
    const b = makeStep('b', trace);
    const c = makeStep('c', trace, {
      apply: async () => {
        throw new Error('boom');
      },
    });

    const result = await runSteps([a, b, c], makeContext());

    expect(result.failed).toBe(true);
    expect(trace.calls).toEqual(['apply:a', 'apply:b', 'rollback:b', 'rollback:a']);
  });

  it('halts and rolls back when a step is blocked', async () => {
    const trace: Trace = { calls: [] };
    const a = makeStep('a', trace);
    const b = makeStep('b', trace, {
      precheck: async () => ({ kind: 'blocked', reason: 'no Xcode project' }),
    });

    const result = await runSteps([a, b], makeContext());

    expect(result.failed).toBe(true);
    expect(trace.calls).toEqual(['apply:a', 'rollback:a']);
    const blocked = result.results.find((r) => r.outcome === 'blocked');
    expect(blocked?.note).toBe('no Xcode project');
  });

  it('does not call apply or rollback in dry-run', async () => {
    const trace: Trace = { calls: [] };
    const a = makeStep('a', trace);

    const result = await runSteps([a], makeContext({ dryRun: true }));

    expect(result.failed).toBe(false);
    expect(trace.calls).toEqual([]);
    expect(result.results).toEqual([{ id: 'a', outcome: 'planned' }]);
  });
});

describe('runSteps manual outcome', () => {
  const snippet = { file: 'App.tsx', title: 'Add init', code: 'Bugsee.launch()' };

  it('records manual, does not roll it back, continues, and marks incomplete', async () => {
    const trace: Trace = { calls: [] };
    const a = makeStep('a', trace);
    const m = makeStep('m', trace, { apply: async () => ({ manual: snippet }) });
    const c = makeStep('c', trace);
    const result = await runSteps([a, m, c], makeContext());
    expect(result.failed).toBe(false);
    expect(result.incomplete).toBe(true);
    expect(result.results).toEqual([
      { id: 'a', outcome: 'applied' },
      { id: 'm', outcome: 'manual', snippet },
      { id: 'c', outcome: 'applied' },
    ]);
    expect(trace.calls).toEqual(['apply:a', 'apply:c']);
  });

  it('a later throw rolls back applied steps but not manual ones', async () => {
    const trace: Trace = { calls: [] };
    const a = makeStep('a', trace);
    const m = makeStep('m', trace, { apply: async () => ({ manual: snippet }) });
    const bad = makeStep('bad', trace, {
      apply: async () => {
        throw new Error('boom');
      },
    });
    const result = await runSteps([a, m, bad], makeContext());
    expect(result.failed).toBe(true);
    expect(trace.calls).toEqual(['apply:a', 'rollback:a']);
    expect(result.results.map((r) => `${r.id}:${r.outcome}`)).toEqual([
      'a:applied',
      'm:manual',
      'bad:failed',
      'a:rolled-back',
    ]);
  });

  it('a manual result flagged applied stays rollback-covered but keeps outcome manual', async () => {
    const trace: Trace = { calls: [] };
    const m = makeStep('m', trace, { apply: async () => ({ manual: snippet, applied: true }) });
    const bad = makeStep('bad', trace, {
      apply: async () => {
        throw new Error('boom');
      },
    });
    const ok = await runSteps([m], makeContext());
    expect(ok.incomplete).toBe(true);
    expect(ok.results).toEqual([{ id: 'm', outcome: 'manual', snippet }]);
    const result = await runSteps([m, bad], makeContext());
    expect(trace.calls).toContain('rollback:m');
    expect(result.results.map((r) => `${r.id}:${r.outcome}`)).toEqual([
      'm:manual',
      'bad:failed',
      'm:rolled-back',
    ]);
  });

  it('incomplete is false when nothing is manual', async () => {
    const trace: Trace = { calls: [] };
    const result = await runSteps([makeStep('a', trace)], makeContext());
    expect(result.incomplete).toBe(false);
  });

  it('never calls apply under dry-run, even for a manual-returning step', async () => {
    const apply = vi.fn(async () => ({ manual: snippet }));
    const m = makeStep('m', { calls: [] }, { apply });
    const result = await runSteps([m], makeContext({ dryRun: true }));
    expect(apply).not.toHaveBeenCalled();
    expect(result.incomplete).toBe(false);
  });
});

describe('runRollback', () => {
  it('calls rollback on each step in reverse order', async () => {
    const trace: Trace = { calls: [] };
    const steps = [makeStep('a', trace), makeStep('b', trace), makeStep('c', trace)];
    const result = await runRollback(steps, makeContext());
    expect(result.failed).toBe(false);
    expect(trace.calls).toEqual(['rollback:c', 'rollback:b', 'rollback:a']);
    expect(result.results.map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });

  it('continues on rollback errors and reports failed=true', async () => {
    const trace: Trace = { calls: [] };
    const steps = [
      makeStep('a', trace),
      makeStep('b', trace, {
        rollback: async () => {
          throw new Error('boom');
        },
      }),
      makeStep('c', trace),
    ];
    const result = await runRollback(steps, makeContext());
    expect(result.failed).toBe(true);
    // c rolled back, b failed (noted), a still rolled back.
    expect(trace.calls).toEqual(['rollback:c', 'rollback:a']);
    const failed = result.results.find((r) => r.outcome === 'failed');
    expect(failed?.id).toBe('b');
  });

  it('skips rollback in dry-run', async () => {
    const trace: Trace = { calls: [] };
    const steps = [makeStep('a', trace), makeStep('b', trace)];
    vi.mocked(clack.log.success).mockClear();
    vi.mocked(clack.log.step).mockClear();
    const ctx = makeContext({ dryRun: true });
    const result = await runRollback(steps, ctx);
    expect(trace.calls).toEqual([]);
    expect(result.results.map((r) => r.outcome)).toEqual(['planned', 'planned']);
    expect(clack.log.success).not.toHaveBeenCalled();
    expect(clack.log.step).toHaveBeenCalledWith(expect.stringContaining('dry-run'));
  });
});
