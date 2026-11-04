import type { WizardContext } from '../core/context.js';
import type { PluginTarget } from './config-ast.js';
import type { ManifestRecorder } from './manifest.js';
import type { DetectedPackageManager } from './package-manager.js';

export type DetectRule = { dependency: string } | { file: string };

export type OpSpec =
  | { op: 'install-package'; packages: string[]; dev?: boolean; tag?: string }
  | {
      op: 'add-bundler-plugin';
      target: PluginTarget;
      importFrom: string;
      importName: string;
      callArgs: string;
      ensureSourcemap?: boolean;
    }
  | { op: 'set-json-key'; file: string; path: string[]; value: unknown }
  | { op: 'add-package-script'; name: string; command: string; chainInto?: string }
  | { op: 'ensure-gitignore'; line: string }
  | { op: 'write-env-var'; file: string; key: string; from: 'token' }
  | { op: 'write-file'; path: string; template: string };

export interface Recipe {
  schema: 1;
  id: string;
  kind: 'runtime' | 'framework' | 'buildtool';
  platform: string;
  engine: { min: string };
  sdk: { range: string };
  detect: DetectRule[];
  ops: OpSpec[];
  verify?: string[];
}

export interface RecipeContext extends WizardContext {
  readonly packageDir: string;
  readonly packageManager: DetectedPackageManager | null;
  readonly token: string;
  readonly manifest: ManifestRecorder;
}

export class RecipeError extends Error {
  readonly violations: readonly string[];
  constructor(violations: readonly string[]) {
    super(
      `Invalid recipe (${violations.length} problem(s)):\n${violations.map((v) => `  - ${v}`).join('\n')}`,
    );
    this.name = 'RecipeError';
    this.violations = violations;
  }
}

type Obj = Record<string, unknown>;

const KINDS = ['runtime', 'framework', 'buildtool'] as const;
const TARGETS = ['vite', 'webpack', 'rollup', 'rspack'] as const;
const PACKAGE_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._^~<>=*-]*$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;
const TOKEN_PLACEHOLDER = '{{token}}';

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

class Check {
  readonly errors: string[] = [];

  fail(path: string, reason: string): void {
    this.errors.push(`${path}: ${reason}`);
  }

  object(v: unknown, path: string, allowed: readonly string[]): Obj | undefined {
    if (!isObj(v)) {
      this.fail(path, 'must be an object');
      return undefined;
    }
    for (const key of Object.keys(v)) {
      if (!allowed.includes(key)) this.fail(`${path}.${key}`, 'unknown key');
    }
    return v;
  }

  string(o: Obj, key: string, path: string, opts: { empty?: boolean } = {}): string | undefined {
    const v = o[key];
    if (typeof v !== 'string') {
      this.fail(`${path}.${key}`, v === undefined ? 'is required' : 'must be a string');
      return undefined;
    }
    if (v === '' && !opts.empty) {
      this.fail(`${path}.${key}`, 'must not be empty');
      return undefined;
    }
    return v;
  }

  optionalString(o: Obj, key: string, path: string): string | undefined {
    return o[key] === undefined ? undefined : this.string(o, key, path);
  }

  optionalBool(o: Obj, key: string, path: string): boolean | undefined {
    const v = o[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'boolean') this.fail(`${path}.${key}`, 'must be a boolean');
    return typeof v === 'boolean' ? v : undefined;
  }

  strings(v: unknown, path: string, nonEmptyList: boolean): string[] | undefined {
    if (!Array.isArray(v)) {
      this.fail(path, v === undefined ? 'is required' : 'must be an array of strings');
      return undefined;
    }
    if (nonEmptyList && v.length === 0) this.fail(path, 'must not be empty');
    const out: string[] = [];
    v.forEach((item: unknown, i) => {
      if (typeof item !== 'string' || item === '') {
        this.fail(`${path}[${i}]`, 'must be a non-empty string');
      } else {
        out.push(item);
      }
    });
    return out;
  }

  /** A relative path that stays inside the package directory. */
  relPath(o: Obj, key: string, path: string): string | undefined {
    const v = this.string(o, key, path);
    if (v === undefined) return undefined;
    const where = `${path}.${key}`;
    if (v.includes('\0')) this.fail(where, 'must not contain a NUL byte');
    else if (/^(?:[\\/]|[A-Za-z]:)/.test(v)) this.fail(where, 'must be relative, not absolute');
    else if (v.split(/[\\/]/).includes('..'))
      this.fail(where, 'must not escape the package directory via ".."');
    else if (v.split(/[\\/]/).every((s) => s === '' || s === '.'))
      this.fail(where, 'must name a file');
    return v;
  }
}

function checkOp(c: Check, raw: unknown, path: string): OpSpec | undefined {
  if (!isObj(raw)) {
    c.fail(path, 'must be an object');
    return undefined;
  }
  const op = raw.op;
  const before = c.errors.length;
  let spec: OpSpec | undefined;
  switch (op) {
    case 'install-package': {
      const o = c.object(raw, path, ['op', 'packages', 'dev', 'tag']);
      if (!o) return undefined;
      const packages = c.strings(o.packages, `${path}.packages`, true);
      packages?.forEach((p, i) => {
        if (!PACKAGE_RE.test(p)) c.fail(`${path}.packages[${i}]`, 'is not a valid package name');
      });
      const dev = c.optionalBool(o, 'dev', path);
      const tag = c.optionalString(o, 'tag', path);
      if (tag !== undefined && !TAG_RE.test(tag))
        c.fail(`${path}.tag`, 'is not a valid version or dist-tag');
      if (packages) {
        spec = {
          op,
          packages,
          ...(dev !== undefined ? { dev } : {}),
          ...(tag !== undefined ? { tag } : {}),
        };
      }
      break;
    }
    case 'add-bundler-plugin': {
      const o = c.object(raw, path, [
        'op',
        'target',
        'importFrom',
        'importName',
        'callArgs',
        'ensureSourcemap',
      ]);
      if (!o) return undefined;
      const target = TARGETS.find((t) => t === o.target);
      if (!target) c.fail(`${path}.target`, `must be one of ${TARGETS.join(', ')}`);
      const importFrom = c.string(o, 'importFrom', path);
      const importName = c.string(o, 'importName', path);
      const callArgs = c.string(o, 'callArgs', path, { empty: true });
      const ensureSourcemap = c.optionalBool(o, 'ensureSourcemap', path);
      if (importName !== undefined && !/^[A-Za-z_$][\w$]*$/.test(importName)) {
        c.fail(`${path}.importName`, 'must be a valid identifier');
      }
      if (
        target &&
        importFrom !== undefined &&
        importName !== undefined &&
        callArgs !== undefined
      ) {
        spec = {
          op,
          target,
          importFrom,
          importName,
          callArgs,
          ...(ensureSourcemap !== undefined ? { ensureSourcemap } : {}),
        };
      }
      break;
    }
    case 'set-json-key': {
      const o = c.object(raw, path, ['op', 'file', 'path', 'value']);
      if (!o) return undefined;
      const file = c.relPath(o, 'file', path);
      const keyPath = c.strings(o.path, `${path}.path`, true);
      if (!('value' in o)) c.fail(`${path}.value`, 'is required');
      if (file !== undefined && keyPath && 'value' in o)
        spec = { op, file, path: keyPath, value: o.value };
      break;
    }
    case 'add-package-script': {
      const o = c.object(raw, path, ['op', 'name', 'command', 'chainInto']);
      if (!o) return undefined;
      const name = c.string(o, 'name', path);
      const command = c.string(o, 'command', path);
      const chainInto = c.optionalString(o, 'chainInto', path);
      if (name !== undefined && chainInto === name)
        c.fail(`${path}.chainInto`, 'must differ from name');
      if (name !== undefined && command !== undefined) {
        spec = { op, name, command, ...(chainInto !== undefined ? { chainInto } : {}) };
      }
      break;
    }
    case 'ensure-gitignore': {
      const o = c.object(raw, path, ['op', 'line']);
      if (!o) return undefined;
      const line = c.string(o, 'line', path);
      if (line !== undefined && /[\r\n]/.test(line))
        c.fail(`${path}.line`, 'must not contain a newline');
      else if (line !== undefined && line.trim() === '')
        c.fail(`${path}.line`, 'must not be blank');
      if (line !== undefined) spec = { op, line };
      break;
    }
    case 'write-env-var': {
      const o = c.object(raw, path, ['op', 'file', 'key', 'from']);
      if (!o) return undefined;
      const file = c.relPath(o, 'file', path);
      const key = c.string(o, 'key', path);
      if (key !== undefined && !ENV_KEY_RE.test(key))
        c.fail(`${path}.key`, 'is not a valid environment variable name');
      if (o.from !== 'token') c.fail(`${path}.from`, "must be 'token'");
      if (file !== undefined && key !== undefined && o.from === 'token')
        spec = { op, file, key, from: 'token' };
      break;
    }
    case 'write-file': {
      const o = c.object(raw, path, ['op', 'path', 'template']);
      if (!o) return undefined;
      const file = c.relPath(o, 'path', path);
      const template = c.string(o, 'template', path, { empty: true });
      if (template?.includes(TOKEN_PLACEHOLDER)) {
        c.fail(
          `${path}.template`,
          `must not contain ${TOKEN_PLACEHOLDER} (secrets are never written from a template)`,
        );
      }
      if (file !== undefined && template !== undefined) spec = { op, path: file, template };
      break;
    }
    default:
      c.fail(`${path}.op`, `unknown operation ${JSON.stringify(op)}`);
      return undefined;
  }
  return c.errors.length === before ? spec : undefined;
}

function checkDetect(c: Check, raw: unknown, path: string): DetectRule | undefined {
  if (!isObj(raw)) {
    c.fail(path, 'must be an object');
    return undefined;
  }
  const keys = Object.keys(raw);
  if (keys.length !== 1 || (keys[0] !== 'dependency' && keys[0] !== 'file')) {
    c.fail(path, "must have exactly one key: 'dependency' or 'file'");
    return undefined;
  }
  if (keys[0] === 'dependency') {
    const dependency = c.string(raw, 'dependency', path);
    return dependency === undefined ? undefined : { dependency };
  }
  const file = c.string(raw, 'file', path);
  return file === undefined ? undefined : { file };
}

/** Validate untrusted recipe JSON. Throws a RecipeError listing every violation. */
export function parseRecipe(json: unknown): Recipe {
  const c = new Check();
  const root = c.object(json, 'recipe', [
    'schema',
    'id',
    'kind',
    'platform',
    'engine',
    'sdk',
    'detect',
    'ops',
    'verify',
  ]);
  if (!root) throw new RecipeError(c.errors);

  if (root.schema !== 1) c.fail('recipe.schema', 'must be 1');
  const id = c.string(root, 'id', 'recipe');
  const kind = KINDS.find((k) => k === root.kind);
  if (!kind) c.fail('recipe.kind', `must be one of ${KINDS.join(', ')}`);
  const platform = c.string(root, 'platform', 'recipe');

  let min: string | undefined;
  const engine =
    root.engine === undefined ? undefined : c.object(root.engine, 'recipe.engine', ['min']);
  if (root.engine === undefined) c.fail('recipe.engine', 'is required');
  if (engine) {
    min = c.string(engine, 'min', 'recipe.engine');
    if (min !== undefined && !SEMVER_RE.test(min))
      c.fail('recipe.engine.min', 'must be a semantic version');
  }

  let range: string | undefined;
  const sdk = root.sdk === undefined ? undefined : c.object(root.sdk, 'recipe.sdk', ['range']);
  if (root.sdk === undefined) c.fail('recipe.sdk', 'is required');
  if (sdk) range = c.string(sdk, 'range', 'recipe.sdk');

  const detect: DetectRule[] = [];
  if (Array.isArray(root.detect)) {
    root.detect.forEach((r: unknown, i) => {
      const rule = checkDetect(c, r, `recipe.detect[${i}]`);
      if (rule) detect.push(rule);
    });
  } else {
    c.fail('recipe.detect', root.detect === undefined ? 'is required' : 'must be an array');
  }

  const ops: OpSpec[] = [];
  if (Array.isArray(root.ops)) {
    root.ops.forEach((r: unknown, i) => {
      const spec = checkOp(c, r, `recipe.ops[${i}]`);
      if (spec) ops.push(spec);
    });
  } else {
    c.fail('recipe.ops', root.ops === undefined ? 'is required' : 'must be an array');
  }

  const verify =
    root.verify === undefined ? undefined : c.strings(root.verify, 'recipe.verify', false);

  if (c.errors.length > 0 || !id || !kind || !platform || !min || !range)
    throw new RecipeError(c.errors);
  return {
    schema: 1,
    id,
    kind,
    platform,
    engine: { min },
    sdk: { range },
    detect,
    ops,
    ...(verify ? { verify } : {}),
  };
}
