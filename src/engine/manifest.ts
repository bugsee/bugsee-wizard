import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Logger } from '../core/logger.js';
import { writeFileAtomic } from './fs-edit.js';
import { ensureGitignoreLine } from './gitignore.js';

/** What ops hand to the recorder. `file` is relative to the wizard's cwd; before/after are file TEXT. */
export interface ManifestEntry {
  file: string;
  action: 'created' | 'edited' | 'manual';
  before?: string;
  after?: string;
  marker?: string;
}

export interface ManifestRecorder {
  record(entry: ManifestEntry): void;
}

/** What is persisted. `file` is relative to the manifest dir (the package dir), `/`-separated. */
export interface ManifestFileEntry {
  file: string;
  action: 'created' | 'edited' | 'manual';
  beforeSha256?: string;
  afterSha256?: string;
  marker?: string;
  /** Relative to the manifest dir, under `.bugsee/backup/`: the pre-edit text. */
  backup?: string;
}

export interface Manifest {
  schema: 1;
  wizard: string;
  recipes: { id: string; revision: string }[];
  entries: ManifestFileEntry[];
}

export interface RollbackResult {
  file: string;
  outcome: 'reverted' | 'deleted' | 'skipped' | 'manual' | 'missing';
  note?: string;
}

const BUGSEE_DIR = '.bugsee';
const MANIFEST_FILE = `${BUGSEE_DIR}/wizard-manifest.json`;
const BACKUP_DIR = `${BUGSEE_DIR}/backup`;

const sha256 = (data: string): string => createHash('sha256').update(data, 'utf8').digest('hex');
const posix = (p: string): string => p.split(sep).join('/');
const isEnvMarker = (m: string | undefined): m is string => m?.startsWith('env:') === true;
/** Env markers are per-variable, so one file can legitimately carry several entries. */
const entryKey = (e: { file: string; marker?: string | undefined }): string =>
  isEnvMarker(e.marker) ? `${e.file}\0${e.marker}` : e.file;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const optString = (v: unknown): boolean => v === undefined || typeof v === 'string';

function validEntry(e: unknown): e is ManifestFileEntry {
  if (!isRecord(e)) return false;
  if (typeof e['file'] !== 'string' || e['file'] === '' || isAbsolute(e['file'])) return false;
  if (e['action'] !== 'created' && e['action'] !== 'edited' && e['action'] !== 'manual')
    return false;
  if (!optString(e['beforeSha256']) || !optString(e['afterSha256']) || !optString(e['marker'])) {
    return false;
  }
  const backup = e['backup'];
  if (backup !== undefined) {
    if (typeof backup !== 'string') return false;
    if (!backup.startsWith(`${BACKUP_DIR}/`) || backup.split('/').includes('..')) return false;
  }
  return true;
}

function validManifest(m: unknown): m is Manifest {
  if (!isRecord(m) || m['schema'] !== 1 || typeof m['wizard'] !== 'string') return false;
  const { recipes, entries } = m;
  if (!Array.isArray(recipes) || !Array.isArray(entries)) return false;
  const okRecipes = recipes.every(
    (r) => isRecord(r) && typeof r['id'] === 'string' && typeof r['revision'] === 'string',
  );
  return okRecipes && entries.every(validEntry);
}

/** The manifest at `<dir>/.bugsee/wizard-manifest.json`, or null when missing or malformed. Never throws. */
export async function loadManifest(dir: string): Promise<Manifest | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, MANIFEST_FILE), 'utf8'));
    return validManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Re-run helper: did a previous run record a (non-manual) change to `file` (and `marker`, when given)? */
export function isRecordedApplied(
  manifest: Manifest | null,
  file: string,
  marker?: string,
): boolean {
  if (manifest === null) return false;
  return manifest.entries.some(
    (e) =>
      e.file === file && e.action !== 'manual' && (marker === undefined || e.marker === marker),
  );
}

export interface RecorderOptions {
  /** Add `.bugsee/` to the manifest dir's .gitignore (default true). */
  ignoreInGit?: boolean;
  /**
   * The directory ops' `file` paths are relative to (the wizard's cwd). They are re-based to be relative
   * to the manifest dir. Defaults to the manifest dir itself.
   */
  cwd?: string;
}

interface Pending {
  entry: ManifestFileEntry;
  backupText?: string;
}

function toFileEntry(e: ManifestEntry, file: string): Pending {
  const entry: ManifestFileEntry = { file, action: e.action };
  if (e.marker !== undefined) entry.marker = e.marker;
  if (e.after !== undefined) entry.afterSha256 = sha256(e.after);
  const pending: Pending = { entry };
  if (e.before !== undefined) {
    entry.beforeSha256 = sha256(e.before);
    if (e.action === 'edited') {
      entry.backup = `${BACKUP_DIR}/${entry.beforeSha256}`;
      pending.backupText = e.before;
    }
  }
  return pending;
}

/** Combine an earlier entry for the same file with a later one: latest wins, first "before" survives. */
function mergeEntry(prev: ManifestFileEntry, next: Pending): Pending {
  if (next.entry.action === 'manual' && prev.action !== 'manual') return { entry: prev };
  if (prev.action === 'manual') return next;
  const merged: ManifestFileEntry = { ...next.entry };
  // a file the wizard created and later edited did not exist before the wizard: still "created"
  if (prev.action === 'created') merged.action = 'created';
  delete merged.beforeSha256;
  delete merged.backup;
  if (prev.beforeSha256 !== undefined) merged.beforeSha256 = prev.beforeSha256;
  if (prev.backup !== undefined) merged.backup = prev.backup;
  if (prev.action === 'created') return { entry: merged };
  if (prev.beforeSha256 !== undefined) return { entry: merged }; // first before wins; no new backup
  const out: Pending = { entry: merged };
  if (next.entry.beforeSha256 !== undefined) merged.beforeSha256 = next.entry.beforeSha256;
  if (next.entry.backup !== undefined) merged.backup = next.entry.backup;
  if (next.backupText !== undefined) out.backupText = next.backupText;
  return out;
}

async function persist(dir: string, manifest: Manifest, opts: RecorderOptions): Promise<void> {
  const path = join(dir, MANIFEST_FILE);
  await mkdir(dirname(path), { recursive: true });
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  if (
    await stat(path).then(
      () => true,
      () => false,
    )
  )
    await writeFileAtomic(path, body);
  else await writeFile(path, body, 'utf8');
  if (opts.ignoreInGit ?? true) await ensureGitignoreLine(dir, `${BUGSEE_DIR}/`);
}

export function createManifestRecorder(
  dir: string,
  meta: { wizard: string; recipes: { id: string; revision: string }[] },
  opts: RecorderOptions = {},
): ManifestRecorder & { flush(): Promise<void> } {
  const queue: ManifestEntry[] = [];
  const base = resolve(opts.cwd ?? dir);
  return {
    record(entry) {
      queue.push(entry);
    },
    async flush() {
      const batch = queue.splice(0);
      const existing = await loadManifest(dir);
      const order: string[] = [];
      const byKey = new Map<string, Pending>();
      for (const e of existing?.entries ?? []) {
        order.push(entryKey(e));
        byKey.set(entryKey(e), { entry: e });
      }
      for (const e of batch) {
        const file = posix(relative(resolve(dir), resolve(base, e.file)));
        const next = toFileEntry(e, file);
        const key = entryKey(next.entry);
        const prev = byKey.get(key);
        if (prev === undefined) order.push(key);
        byKey.set(key, prev === undefined ? next : mergeEntry(prev.entry, next));
      }
      const pendings = order.flatMap((k) => byKey.get(k) ?? []);
      for (const p of pendings) {
        if (p.backupText !== undefined && p.entry.backup !== undefined) {
          const target = join(dir, p.entry.backup);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, p.backupText, 'utf8');
        }
      }
      const recipes = new Map((existing?.recipes ?? []).map((r) => [r.id, r.revision] as const));
      for (const r of meta.recipes) recipes.set(r.id, r.revision);
      await persist(
        dir,
        {
          schema: 1,
          wizard: meta.wizard,
          recipes: [...recipes].map(([id, revision]) => ({ id, revision })),
          entries: pendings.map((p) => p.entry),
        },
        opts,
      );
    },
  };
}

/** Record one entry and persist immediately. */
export async function recordEntry(
  dir: string,
  entry: ManifestEntry,
  meta: { wizard: string; recipes: { id: string; revision: string }[] } = {
    wizard: 'unknown',
    recipes: [],
  },
  opts: RecorderOptions = {},
): Promise<void> {
  const r = createManifestRecorder(dir, meta, opts);
  r.record(entry);
  await r.flush();
}

const KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function rollbackEntry(
  dir: string,
  e: ManifestFileEntry,
  dryRun: boolean,
): Promise<RollbackResult> {
  const file = e.file;
  if (e.action === 'manual') return { file, outcome: 'manual', note: 'needs a manual step' };
  const abs = resolve(dir, e.file);
  const current = await readIfExists(abs);
  if (current === null) return { file, outcome: 'missing' };

  if (isEnvMarker(e.marker)) {
    const key = e.marker.slice('env:'.length);
    const lines = current.split('\n');
    const kept = lines.filter((l) => KEY_LINE.exec(l)?.[1] !== key);
    if (kept.length === lines.length) {
      return { file, outcome: 'skipped', note: `${key} is no longer set` };
    }
    const out = kept.join('\n');
    if (out.trim() === '' && e.action === 'created') {
      if (!dryRun) await rm(abs);
      return { file, outcome: 'deleted' };
    }
    if (!dryRun) await writeFileAtomic(abs, out);
    return { file, outcome: 'reverted' };
  }

  if (e.afterSha256 === undefined) {
    return {
      file,
      outcome: 'manual',
      note: 'no content hash was recorded; left untouched',
    };
  }
  if (sha256(current) !== e.afterSha256) {
    return {
      file,
      outcome: 'manual',
      note: 'changed since the wizard wrote it; left untouched',
    };
  }
  if (e.action === 'created') {
    if (!dryRun) await rm(abs);
    return { file, outcome: 'deleted' };
  }
  if (e.backup === undefined || e.beforeSha256 === undefined) {
    return {
      file,
      outcome: 'manual',
      note: 'no backup was recorded; revert by hand',
    };
  }
  const backup = await readIfExists(join(dir, e.backup));
  if (backup === null || sha256(backup) !== e.beforeSha256) {
    return {
      file,
      outcome: 'manual',
      note: 'backup is missing or altered; revert by hand',
    };
  }
  if (!dryRun) await writeFileAtomic(abs, backup);
  return { file, outcome: 'reverted' };
}

export async function rollbackFromManifest(ctx: {
  dir: string;
  log: Logger;
  dryRun: boolean;
}): Promise<{ results: RollbackResult[]; failed: boolean }> {
  const manifest = await loadManifest(ctx.dir);
  if (manifest === null) return { results: [], failed: false };
  const results: RollbackResult[] = [];
  let failed = false;
  // reverse order: later changes are undone before the earlier ones they build on
  for (const e of [...manifest.entries].reverse()) {
    try {
      results.push(await rollbackEntry(ctx.dir, e, ctx.dryRun));
    } catch (err) {
      failed = true;
      const note = err instanceof Error ? err.message : String(err);
      ctx.log.error(`Could not roll back ${e.file}: ${note}`);
      results.push({ file: e.file, outcome: 'skipped', note });
    }
  }
  results.reverse();
  // user-changed files stay listed (outcome 'manual' from a real entry) so a retry is possible
  const unresolved = results.some(
    (r, i) => r.outcome === 'manual' && manifest.entries[i]?.action !== 'manual',
  );
  if (!failed && !ctx.dryRun && !unresolved) {
    await rm(join(ctx.dir, MANIFEST_FILE), { force: true });
    await rm(join(ctx.dir, BACKUP_DIR), { recursive: true, force: true });
    const left = await readdir(join(ctx.dir, BUGSEE_DIR)).catch(() => null);
    if (left !== null && left.length === 0) await rmdir(join(ctx.dir, BUGSEE_DIR));
  }
  return { results, failed };
}
