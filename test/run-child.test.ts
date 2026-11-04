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
});
