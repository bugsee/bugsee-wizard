import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>();
  return {
    ...real,
    writeFile: vi.fn(async (...args: Parameters<typeof real.writeFile>) => {
      if (String(args[0]).endsWith('f.txt')) throw new Error('disk full');
      return real.writeFile(...args);
    }),
  };
});

import { opToStep } from '../../../src/engine/ops/index.js';
import { makeCtx, makeTmp } from '../helpers.js';

let tmp: Awaited<ReturnType<typeof makeTmp>>;
beforeEach(async () => {
  tmp = await makeTmp();
});
afterEach(() => tmp.cleanup());

const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );

describe('write-file op when the write fails', () => {
  it('removes the directories this step created and rethrows the original error', async () => {
    const step = opToStep({ op: 'write-file', path: 'newdir/sub/f.txt', template: 'x' });
    await expect(step.apply(makeCtx(tmp.dir))).rejects.toThrow('disk full');
    expect(await exists(join(tmp.dir, 'newdir'))).toBe(false);
  });
});
