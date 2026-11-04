import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTelemetry,
  type TelemetryEvent,
  type TelemetrySink,
  WIZARD_VERSION,
} from '../../src/engine/telemetry.js';

function sink(): { s: TelemetrySink; sent: TelemetryEvent[] } {
  const sent: TelemetryEvent[] = [];
  return { s: { send: (e) => sent.push(e) }, sent };
}

afterEach(() => vi.restoreAllMocks());

describe('telemetry gate', () => {
  it('is disabled by default, even with a sink', () => {
    const { s, sent } = sink();
    const t = createTelemetry({ flag: false, env: {}, sink: s });
    expect(t.enabled).toBe(false);
    t.emit({ name: 'run' });
    expect(sent).toEqual([]);
  });
  it('enabled via flag', () => {
    const { s, sent } = sink();
    const t = createTelemetry({ flag: true, env: {}, sink: s });
    expect(t.enabled).toBe(true);
    t.emit({ name: 'run' });
    expect(sent).toHaveLength(1);
  });
  it.each(['1', 'true', 'yes'])('enabled via env %s', (v) => {
    const { s, sent } = sink();
    const t = createTelemetry({ flag: false, env: { BUGSEE_WIZARD_TELEMETRY: v }, sink: s });
    expect(t.enabled).toBe(true);
    t.emit({ name: 'run' });
    expect(sent).toHaveLength(1);
  });
  it.each(['0', 'false', '', 'on'])('not enabled by env %s', (v) => {
    expect(createTelemetry({ flag: false, env: { BUGSEE_WIZARD_TELEMETRY: v } }).enabled).toBe(
      false,
    );
  });
  it('enabled with no sink sends nothing and does not throw', () => {
    const t = createTelemetry({ flag: true, env: {} });
    expect(t.enabled).toBe(true);
    expect(() => t.emit({ name: 'run' })).not.toThrow();
  });
});

describe('event shape', () => {
  it('fills wizard, nodeMajor, os and runId; keeps vocabulary fields', () => {
    const { s, sent } = sink();
    const t = createTelemetry({ flag: true, env: {}, sink: s });
    t.emit({
      name: 'step',
      recipe: 'javascript',
      step: 'install-sdk',
      outcome: 'failed',
      errorCategory: 'network',
    });
    const e = sent[0] as TelemetryEvent;
    expect(e.wizard).toBe(WIZARD_VERSION);
    expect(e.nodeMajor).toBe(Number(process.versions.node.split('.')[0]));
    expect(['darwin', 'linux', 'win32', 'other']).toContain(e.os);
    expect(e.runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(e).toMatchObject({
      name: 'step',
      recipe: 'javascript',
      step: 'install-sdk',
      outcome: 'failed',
      errorCategory: 'network',
    });
  });
  it('os maps the platform, unknown platforms to other', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    try {
      for (const [p, want] of [
        ['darwin', 'darwin'],
        ['linux', 'linux'],
        ['win32', 'win32'],
        ['freebsd', 'other'],
      ] as const) {
        Object.defineProperty(process, 'platform', { value: p });
        const { s, sent } = sink();
        createTelemetry({ flag: true, env: {}, sink: s }).emit({ name: 'run' });
        expect(sent[0]?.os).toBe(want);
      }
    } finally {
      if (original) Object.defineProperty(process, 'platform', original);
    }
  });
  it('runId is stable within one telemetry and differs across createTelemetry calls', () => {
    const a = sink();
    const b = sink();
    const ta = createTelemetry({ flag: true, env: {}, sink: a.s });
    const tb = createTelemetry({ flag: true, env: {}, sink: b.s });
    ta.emit({ name: 'run' });
    ta.emit({ name: 'step' });
    tb.emit({ name: 'run' });
    expect(a.sent[0]?.runId).toBe(a.sent[1]?.runId);
    expect(a.sent[0]?.runId).not.toBe(b.sent[0]?.runId);
  });
  it('omits optional fields that were not given', () => {
    const { s, sent } = sink();
    createTelemetry({ flag: true, env: {}, sink: s }).emit({ name: 'run' });
    expect(Object.keys(sent[0] as object).sort()).toEqual([
      'name',
      'nodeMajor',
      'os',
      'runId',
      'wizard',
    ]);
  });
});

describe('closed vocabulary', () => {
  const bad = (over: Record<string, unknown>): TelemetryEvent => {
    const { s, sent } = sink();
    createTelemetry({ flag: true, env: {}, sink: s }).emit({ name: 'step', ...over } as never);
    return sent[0] as TelemetryEvent;
  };
  it('drops an unknown outcome field but still sends the event', () => {
    const e = bad({ outcome: '/Users/me/secret.txt' });
    expect(e).toBeDefined();
    expect('outcome' in e).toBe(false);
  });
  it('drops an unknown errorCategory', () => {
    expect('errorCategory' in bad({ errorCategory: 'EACCES: /home/x' })).toBe(false);
  });
  it('drops recipe/step that are not short identifiers (free text)', () => {
    const e = bad({ recipe: 'my project at /home/me', step: 'a'.repeat(100) });
    expect('recipe' in e).toBe(false);
    expect('step' in e).toBe(false);
  });
  it('drops the whole event for an unknown name', () => {
    const { s, sent } = sink();
    createTelemetry({ flag: true, env: {}, sink: s }).emit({ name: 'custom' } as never);
    expect(sent).toEqual([]);
  });
  it('strips unknown extra keys at runtime', () => {
    const e = bad({ email: 'a@b.c', path: '/x' });
    expect('email' in e).toBe(false);
    expect('path' in e).toBe(false);
  });
  it('rejects extra keys and free text at the type level', () => {
    const t = createTelemetry({ flag: false, env: {} });
    // @ts-expect-error extra key
    t.emit({ name: 'run', email: 'a@b.c' });
    // @ts-expect-error free-text outcome
    t.emit({ name: 'step', outcome: 'whatever I like' });
    // @ts-expect-error free-text errorCategory
    t.emit({ name: 'step', errorCategory: 'ENOENT /x' });
    // @ts-expect-error runId is generated, not supplied
    t.emit({ name: 'run', runId: 'mine' });
    // @ts-expect-error name is closed
    t.emit({ name: 'other' });
  });
});

describe('no persistence, no transport', () => {
  it('writes nothing to disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bugsee-telemetry-'));
    const prev = process.cwd();
    process.chdir(dir);
    try {
      const { s } = sink();
      const t = createTelemetry({ flag: true, env: {}, sink: s });
      t.emit({ name: 'run' });
      t.emit({ name: 'step', outcome: 'applied' });
      expect(await readdir(dir)).toEqual([]);
    } finally {
      process.chdir(prev);
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('the module has no fs/network imports or calls', async () => {
    const src = await readFile(new URL('../../src/engine/telemetry.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(
      /node:(fs|http|https|net|dns|tls|child_process)|\bfetch\(|XMLHttpRequest|WebSocket/,
    );
  });
});
