import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Logger } from '../core/logger.js';
import { writeFileAtomic } from './fs-edit.js';
import { ensureGitignoreLine } from './gitignore.js';
import {
  addedPackages,
  computeEdits,
  isLockfile,
  lockfileNote,
  type ManifestEdit,
  revertEdits,
  validEdits,
  withoutPackages,
} from './manifest-edits.js';
import { resolveInside } from './ops/shared.js';
import { isRuntimeSdkPackage } from './sdk-packages.js';
import { findWorkspace } from './workspace.js';

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
  /**
   * What exactly the wizard changed, so uninstall can undo only that when the file was edited since.
   * Absent on entries written by older wizards and on files that cannot be described safely.
   */
  edits?: ManifestEdit[];
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
/** NUL or a backslash (a Windows separator that `..\\` could hide behind). */
const UNSAFE_PATH = /[\0\\]/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const optString = (v: unknown): boolean => v === undefined || typeof v === 'string';

function validEntry(e: unknown): e is ManifestFileEntry {
  if (!isRecord(e)) return false;
  const file = e['file'];
  if (typeof file !== 'string' || file === '' || isAbsolute(file) || UNSAFE_PATH.test(file)) {
    return false;
  }
  if (e['action'] !== 'created' && e['action'] !== 'edited' && e['action'] !== 'manual')
    return false;
  if (!optString(e['beforeSha256']) || !optString(e['afterSha256']) || !optString(e['marker'])) {
    return false;
  }
  if (e['edits'] !== undefined && !validEdits(e['edits'])) return false;
  // the backup name is derived, never free-form: exactly `.bugsee/backup/<beforeSha256>`
  const backup = e['backup'];
  if (backup !== undefined) {
    const before = e['beforeSha256'];
    if (typeof before !== 'string' || !SHA256_RE.test(before)) return false;
    if (backup !== `${BACKUP_DIR}/${before}`) return false;
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
  if (e.action !== 'manual' && !isEnvMarker(e.marker)) {
    const edits = computeEdits(file, e.action, e.before, e.after);
    if (edits !== undefined) entry.edits = edits;
  }
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
function mergeEntry(prevPending: Pending, next: Pending): Pending {
  const prev = prevPending.entry;
  if (next.entry.action === 'manual' && prev.action !== 'manual') return { entry: prev };
  if (prev.action === 'manual') return next;
  const merged: ManifestFileEntry = { ...next.entry };
  // a file the wizard created and later edited did not exist before the wizard: still "created"
  if (prev.action === 'created') merged.action = 'created';
  delete merged.beforeSha256;
  delete merged.backup;
  // edits are all-or-nothing: a chain with an undescribed link cannot be taken out piecemeal
  delete merged.edits;
  if (prev.edits !== undefined && next.entry.edits !== undefined) {
    merged.edits = [...prev.edits, ...next.entry.edits];
  }
  if (prev.beforeSha256 !== undefined) merged.beforeSha256 = prev.beforeSha256;
  if (prev.backup !== undefined) merged.backup = prev.backup;
  if (prev.action === 'created') return { entry: merged };
  if (prev.beforeSha256 !== undefined) {
    // first before wins; no new backup (but one the earlier entry queued in this same batch is kept)
    return prevPending.backupText !== undefined
      ? { entry: merged, backupText: prevPending.backupText }
      : { entry: merged };
  }
  const out: Pending = { entry: merged };
  if (next.entry.beforeSha256 !== undefined) merged.beforeSha256 = next.entry.beforeSha256;
  if (next.entry.backup !== undefined) merged.backup = next.entry.backup;
  if (next.backupText !== undefined) out.backupText = next.backupText;
  return out;
}

async function persist(dir: string, manifest: Manifest, opts: RecorderOptions): Promise<void> {
  const path = join(dir, MANIFEST_FILE);
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`);
  if (opts.ignoreInGit ?? true) await ensureGitignoreLine(dir, `${BUGSEE_DIR}/`);
}

/** Move an existing-but-invalid manifest aside (never overwrite it); returns the new relative path. */
async function quarantine(dir: string): Promise<string | undefined> {
  const path = join(dir, MANIFEST_FILE);
  if ((await readIfExists(path)) === null) return undefined;
  const rel = `${MANIFEST_FILE}.bad-${Date.now()}-${randomBytes(3).toString('hex')}`;
  await rename(path, join(dir, rel));
  return rel;
}

export interface FlushingRecorder extends ManifestRecorder {
  /** Persist everything recorded so far (merged into what is on disk). Safe to call after every step. */
  flush(): Promise<{ quarantined?: string }>;
  /**
   * Put the manifest (and the backups this recorder added) back as they were before its first
   * flush: for a run that was rolled back, so the manifest never lists changes that are gone.
   */
  discard(): Promise<void>;
}

export function createManifestRecorder(
  dir: string,
  meta: { wizard: string; recipes: { id: string; revision: string }[] },
  opts: RecorderOptions = {},
): FlushingRecorder {
  const queue: ManifestEntry[] = [];
  const base = resolve(opts.cwd ?? dir);
  /** The manifest text before our first write (null: none), and the backups we added. */
  let initial: string | null | undefined;
  const addedBackups: string[] = [];
  return {
    async discard() {
      if (initial === undefined) return;
      const path = join(dir, MANIFEST_FILE);
      if (initial === null) await rm(path, { force: true });
      else await writeFileAtomic(path, initial);
      for (const b of addedBackups.splice(0)) await rm(b, { force: true });
      initial = undefined;
      for (const d of [join(dir, BACKUP_DIR), join(dir, BUGSEE_DIR)]) {
        const left = await readdir(d).catch(() => null);
        if (left !== null && left.length === 0) await rmdir(d);
      }
    },
    record(entry) {
      queue.push(entry);
    },
    async flush() {
      const batch = queue.splice(0);
      if (initial === undefined) initial = await readIfExists(join(dir, MANIFEST_FILE));
      const existing = await loadManifest(dir);
      // an existing manifest we cannot read still holds the only record of the pre-wizard state
      const quarantined = existing === null ? await quarantine(dir) : undefined;
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
        byKey.set(key, prev === undefined ? next : mergeEntry(prev, next));
      }
      const pendings = order.flatMap((k) => byKey.get(k) ?? []);
      for (const p of pendings) {
        if (p.backupText !== undefined && p.entry.backup !== undefined) {
          const target = join(dir, p.entry.backup);
          await mkdir(dirname(target), { recursive: true });
          if (!(await pathExists(target))) addedBackups.push(target);
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
      return quarantined === undefined ? {} : { quarantined };
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

/** The root rollback may touch: workspace root, else nearest `.git` ancestor, else the manifest dir. */
async function allowedRoot(dir: string): Promise<string> {
  const ws = await findWorkspace(dir);
  if (ws !== null) return ws.root;
  let cur = resolve(dir);
  for (;;) {
    if (await pathExists(join(cur, '.git'))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return resolve(dir);
    cur = parent;
  }
}

async function pathExists(p: string): Promise<boolean> {
  return lstat(p).then(
    () => true,
    () => false,
  );
}

const manual = (file: string, note: string): RollbackResult => ({ file, outcome: 'manual', note });

async function rollbackEntry(
  dir: string,
  root: string,
  e: ManifestFileEntry,
  dryRun: boolean,
  packages: readonly string[],
): Promise<RollbackResult> {
  const file = e.file;
  if (e.action === 'manual') return manual(file, 'needs a manual step');
  let abs: string;
  try {
    abs = await resolveInside(root, resolve(dir, e.file));
  } catch {
    return manual(file, 'resolves outside the project; left untouched');
  }
  const current = await readIfExists(abs);
  if (current === null) return { file, outcome: 'missing' };

  if (isEnvMarker(e.marker)) {
    const key = e.marker.slice('env:'.length);
    if (!basename(abs).startsWith('.env') || !ENV_KEY_RE.test(key)) {
      return manual(file, 'not an env file or not a valid variable name; left untouched');
    }
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

  // already back at its pre-wizard content (an earlier, partial rollback): nothing left to do
  if (e.action === 'edited' && e.beforeSha256 !== undefined && sha256(current) === e.beforeSha256) {
    return { file, outcome: 'reverted', note: 'already reverted' };
  }
  if (e.afterSha256 === undefined) {
    return manual(file, 'no content hash was recorded; left untouched');
  }
  if (sha256(current) !== e.afterSha256) {
    return revertChanged(e, abs, current, dryRun, packages);
  }
  if (e.action === 'created') {
    if (!dryRun) await rm(abs);
    return { file, outcome: 'deleted' };
  }
  if (e.backup === undefined || e.beforeSha256 === undefined) {
    return manual(file, 'no backup was recorded; revert by hand');
  }
  let backup: string | null;
  try {
    backup = await readIfExists(await resolveInside(root, join(dir, e.backup)));
  } catch {
    return manual(file, 'backup resolves outside the project; revert by hand');
  }
  if (backup === null || sha256(backup) !== e.beforeSha256) {
    return manual(file, 'backup is missing or altered; revert by hand');
  }
  if (!dryRun) await writeFileAtomic(abs, backup);
  return { file, outcome: 'reverted' };
}

const MAX_NOTE = 3;

/**
 * The file differs from what the wizard wrote: the user has kept working in it. Take out only the
 * wizard's recorded part where that is safe; otherwise say exactly what is left to do by hand.
 */
async function revertChanged(
  e: ManifestFileEntry,
  abs: string,
  current: string,
  dryRun: boolean,
  packages: readonly string[],
): Promise<RollbackResult> {
  const file = e.file;
  if (isLockfile(file)) return manual(file, lockfileNote(file, packages));
  if (e.action === 'created' && (e.edits === undefined || basename(file) !== '.gitignore')) {
    return manual(
      file,
      'created by the wizard but changed since; left untouched. Delete it if you no longer need it',
    );
  }
  if (e.edits === undefined) {
    const where = e.backup === undefined ? '' : ` (the original is saved in ${e.backup})`;
    return manual(
      file,
      `changed since the wizard wrote it; left untouched. Remove the Bugsee entries by hand${where}`,
    );
  }
  const res = revertEdits(current, e.edits);
  const pending = res.manual.slice(0, MAX_NOTE).join('; ');
  const more = res.manual.length > MAX_NOTE ? `; and ${res.manual.length - MAX_NOTE} more` : '';
  if (res.text !== current && !dryRun) {
    if (e.action === 'created' && res.text.trim() === '') await rm(abs);
    else await writeFileAtomic(abs, res.text);
  }
  if (res.manual.length > 0) {
    return manual(file, `reverted what it could; by hand: ${pending}${more}`);
  }
  if (e.action === 'created' && res.text.trim() === '') return { file, outcome: 'deleted' };
  return {
    file,
    outcome: 'reverted',
    note:
      res.text === current
        ? 'already reverted'
        : 'removed only the wizard changes; your edits were kept',
  };
}

/**
 * package.json while the SDK has to stay (its import could not be taken out): everything else the
 * wizard added is removed, the SDK packages are kept, and the entry stays in the manifest for a retry.
 */
async function revertKeepingSdk(
  dir: string,
  root: string,
  e: ManifestFileEntry,
  dryRun: boolean,
): Promise<RollbackResult> {
  const kept = addedPackages(e.edits).filter((n) => isRuntimeSdkPackage(n));
  const note = `kept ${kept.length > 0 ? kept.join(', ') : 'the @bugsee SDK packages'}: your code still imports ${kept.length === 1 ? 'it' : 'them'} (remove the import, then run uninstall again)`;
  let abs: string;
  try {
    abs = await resolveInside(root, resolve(dir, e.file));
  } catch {
    return manual(e.file, 'resolves outside the project; left untouched');
  }
  const current = await readIfExists(abs);
  if (current === null) return { file: e.file, outcome: 'missing' };
  if (e.edits === undefined) return manual(e.file, `left untouched. ${note}`);
  const res = revertEdits(
    current,
    withoutPackages(e.edits, (n) => isRuntimeSdkPackage(n)),
  );
  if (res.text !== current && !dryRun) await writeFileAtomic(abs, res.text);
  return manual(
    e.file,
    res.manual.length > 0 ? `${note}; by hand: ${res.manual.join('; ')}` : note,
  );
}

export async function rollbackFromManifest(ctx: {
  dir: string;
  log: Logger;
  dryRun: boolean;
}): Promise<{ results: RollbackResult[]; failed: boolean }> {
  const manifest = await loadManifest(ctx.dir);
  if (manifest === null) return { results: [], failed: false };
  const root = await allowedRoot(ctx.dir);
  const results: RollbackResult[] = [];
  const errored = new Set<number>();
  // reverse order: later changes are undone before the earlier ones they build on
  const order = manifest.entries.map((_, i) => i).reverse();
  const packages = manifest.entries.flatMap((e) =>
    isLockfile(e.file) ? [] : addedPackages(e.edits),
  );
  const byIndex = new Map<number, RollbackResult>();
  // set once the init edit of an entry file could not be taken out: the SDK must then stay installed
  let keepSdk = false;
  for (const i of order) {
    const e = manifest.entries[i];
    if (e === undefined) continue;
    try {
      let r: RollbackResult;
      if (keepSdk && basename(e.file) === 'package.json') {
        r = await revertKeepingSdk(ctx.dir, root, e, ctx.dryRun);
      } else if (keepSdk && isLockfile(e.file)) {
        r = manual(
          e.file,
          'left untouched: it still describes the @bugsee SDK packages your code imports',
        );
      } else {
        r = await rollbackEntry(ctx.dir, root, e, ctx.dryRun, packages);
      }
      if (e.marker === 'bugsee-wizard:sdk-init' && e.action === 'edited' && r.outcome === 'manual')
        keepSdk = true;
      byIndex.set(i, r);
    } catch (err) {
      errored.add(i);
      const note = err instanceof Error ? err.message : String(err);
      ctx.log.error(`Could not roll back ${e.file}: ${note}`);
      byIndex.set(i, { file: e.file, outcome: 'skipped', note });
    }
  }
  const keep: ManifestFileEntry[] = [];
  let unresolved = false;
  manifest.entries.forEach((e, i) => {
    const r = byIndex.get(i);
    if (r === undefined) return;
    results.push(r);
    if (errored.has(i)) {
      keep.push(e);
    } else if (r.outcome === 'manual') {
      keep.push(e);
      if (e.action !== 'manual') unresolved = true; // a user-changed file: a retry may still resolve it
    }
  });
  const failed = errored.size > 0;
  if (!ctx.dryRun && !failed && !unresolved) {
    await rm(join(ctx.dir, MANIFEST_FILE), { force: true });
    await rm(join(ctx.dir, BACKUP_DIR), { recursive: true, force: true });
    const left = await readdir(join(ctx.dir, BUGSEE_DIR)).catch(() => null);
    if (left !== null && left.length === 0) await rmdir(join(ctx.dir, BUGSEE_DIR));
  } else if (!ctx.dryRun && keep.length < manifest.entries.length) {
    // partial rollback: keep only what is left, so a later run deals with just that
    await writeFileAtomic(
      join(ctx.dir, MANIFEST_FILE),
      `${JSON.stringify({ ...manifest, entries: keep }, null, 2)}\n`,
    );
    const wanted = new Set(
      keep.flatMap((e) => (e.backup === undefined ? [] : [basename(e.backup)])),
    );
    for (const name of await readdir(join(ctx.dir, BACKUP_DIR)).catch(() => [])) {
      if (!wanted.has(name)) await rm(join(ctx.dir, BACKUP_DIR, name), { force: true });
    }
  }
  return { results, failed };
}
