import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureGitignoreLine } from '../../src/engine/gitignore.js';
import { makeTmp } from './helpers.js';

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir, cleanup } = await makeTmp());
});
afterEach(async () => {
  await cleanup();
});
const gi = () => join(dir, '.gitignore');
const L = '.env.bugsee-build-plugin';

describe('ensureGitignoreLine', () => {
  it('creates the file when missing', async () => {
    expect(await ensureGitignoreLine(dir, L)).toBe('created');
    expect(await readFile(gi(), 'utf8')).toMatch(new RegExp(`^${L.replace(/\./g, '\\.')}\\r?\\n$`));
  });

  it('adds the line, keeping existing content and a final newline', async () => {
    await writeFile(gi(), 'node_modules\n');
    expect(await ensureGitignoreLine(dir, L)).toBe('added');
    expect(await readFile(gi(), 'utf8')).toBe(`node_modules\n${L}\n`);
  });

  it('adds a separating newline when the file has none at the end', async () => {
    await writeFile(gi(), 'node_modules');
    expect(await ensureGitignoreLine(dir, L)).toBe('added');
    expect(await readFile(gi(), 'utf8')).toBe(`node_modules\n${L}\n`);
  });

  it('preserves CRLF when adding', async () => {
    await writeFile(gi(), 'node_modules\r\ndist\r\n');
    expect(await ensureGitignoreLine(dir, L)).toBe('added');
    expect(await readFile(gi(), 'utf8')).toBe(`node_modules\r\ndist\r\n${L}\r\n`);
  });

  it('adds to an empty file without a leading blank line', async () => {
    await writeFile(gi(), '');
    expect(await ensureGitignoreLine(dir, L)).toBe('added');
    expect(await readFile(gi(), 'utf8')).toMatch(/^\.env\.bugsee-build-plugin\r?\n$/);
  });

  it('recognizes an exact existing line (even CRLF, padded, or leading slash)', async () => {
    for (const content of [`${L}\n`, `a\r\n${L}\r\n`, `  ${L}  \n`, `/${L}\n`]) {
      await writeFile(gi(), content);
      expect(await ensureGitignoreLine(dir, L)).toBe('present');
      expect(await readFile(gi(), 'utf8')).toBe(content);
    }
  });

  it('recognizes covering globs', async () => {
    for (const g of [
      '.env*',
      '.env.*',
      '*.bugsee-build-plugin',
      '.env.bugsee-?uild-plugin',
      '**/.env*',
      '*',
    ]) {
      await writeFile(gi(), `${g}\n`);
      expect(await ensureGitignoreLine(dir, L), g).toBe('present');
    }
  });

  it('does not treat non-covering patterns, comments or negations as present', async () => {
    for (const g of [
      '.env',
      '.envrc',
      '# .env*',
      '!.env*',
      'src/.env*',
      '.env.bugsee-build-plugin2',
      '*.log',
    ]) {
      await writeFile(gi(), `${g}\n`);
      expect(await ensureGitignoreLine(dir, L), g).toBe('added');
    }
  });

  it('treats regex metacharacters in patterns literally', async () => {
    await writeFile(gi(), '.env+bugsee*\n');
    expect(await ensureGitignoreLine(dir, L)).toBe('added');
  });

  it('is idempotent', async () => {
    expect(await ensureGitignoreLine(dir, L)).toBe('created');
    expect(await ensureGitignoreLine(dir, L)).toBe('present');
  });
});
