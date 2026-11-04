import { describe, expect, it, vi } from 'vitest';

import { runChild } from '../src/core/run-child.js';

const node = process.execPath;

describe('runChild', () => {
  it('completes when the child writes >1 MB to stdout and stdout is not forwarded', async () => {
    const script = `process.stdout.write('x'.repeat(3 * 1024 * 1024));`;
    await expect(
      runChild(node, ['-e', script], { cwd: process.cwd(), forwardStdout: false }),
    ).resolves.toBeUndefined();
  }, 10_000);

  it('forwards stdout to the parent when asked', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await runChild(node, ['-e', `process.stdout.write('hello-forward')`], {
        cwd: process.cwd(),
        forwardStdout: true,
      });
      expect(write.mock.calls.map((c) => String(c[0])).join('')).toContain('hello-forward');
    } finally {
      write.mockRestore();
    }
  });

  it('does not forward stdout when not asked', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await runChild(node, ['-e', `process.stdout.write('quiet-child')`], {
        cwd: process.cwd(),
        forwardStdout: false,
      });
      expect(write.mock.calls.map((c) => String(c[0])).join('')).not.toContain('quiet-child');
    } finally {
      write.mockRestore();
    }
  });

  it('rejects with the exit code and the stderr tail on failure', async () => {
    const script = `console.error('l1\\nboom'); process.exit(3)`;
    await expect(
      runChild(node, ['-e', script], { cwd: process.cwd(), forwardStdout: false }),
    ).rejects.toThrow(/exited with code 3[\s\S]*boom/);
  });

  it('names the command and args in the failure message', async () => {
    await expect(
      runChild(node, ['-e', 'process.exit(2)'], { cwd: process.cwd(), forwardStdout: false }),
    ).rejects.toThrow(`${node} -e process.exit(2) exited with code 2`);
  });

  it('rejects when the command cannot be spawned', async () => {
    await expect(
      runChild('definitely-not-a-real-binary-xyz', [], {
        cwd: process.cwd(),
        forwardStdout: false,
      }),
    ).rejects.toThrow(/ENOENT/);
  });

  it('keeps only a bounded tail of stderr but still reports the last lines', async () => {
    const script = `const big = 'e'.repeat(1000) + '\\n';
for (let i = 0; i < 20000; i++) process.stderr.write(big);
process.stderr.write('LAST-LINE\\n'); process.exit(4);`;
    const err = await runChild(node, ['-e', script], {
      cwd: process.cwd(),
      forwardStdout: false,
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain('exited with code 4');
    expect(msg).toContain('LAST-LINE');
    // 10 lines of ~1000 chars at most, nowhere near the 20 MB written.
    expect(msg.length).toBeLessThan(20_000);
  }, 20_000);

  it('caps the retained stderr tail at 64 KB (observable on one huge line)', async () => {
    const script = `process.stderr.write('z'.repeat(300 * 1024)); process.exit(5);`;
    const err = await runChild(node, ['-e', script], {
      cwd: process.cwd(),
      forwardStdout: false,
    }).catch((e: Error) => e);
    const msg = (err as Error).message;
    expect(msg).toContain('exited with code 5');
    expect(msg.length).toBeLessThan(64 * 1024 + 200);
    expect(msg.length).toBeGreaterThan(60 * 1024);
  }, 20_000);
});
