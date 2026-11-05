import { writeFile } from 'node:fs/promises';

import detectIndent from 'detect-indent';

import type { Step, StepStatus } from '../../../core/step.js';
import { readOrNull } from '../../android/io.js';
import type { RnContext } from '../types.js';

const PLUGIN_NAME = '@bugsee/react-native';

type PluginEntry = string | [string, ...unknown[]];

interface ExpoConfigShape {
  expo?: { plugins?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}

/** What one run wrote, so rollback removes exactly that and nothing the user owns. */
interface Added {
  readonly original: string;
  readonly written: string;
  readonly entry: string;
  readonly createdPlugins: boolean;
}

// Keyed by context: "added in this run" is the ownership rule for rollback.
const added = new WeakMap<object, Added>();

type Tokens = Readonly<Record<string, string>>;

function appTokenOption(tokens: Tokens): string | { ios: string; android: string } | undefined {
  const ios = tokens.ios || undefined;
  const android = tokens.android || undefined;
  if (ios && android && ios !== android) return { ios, android };
  const single = ios ?? android;
  return single;
}

function entryFor(tokens: Tokens): PluginEntry {
  const appToken = appTokenOption(tokens);
  return appToken === undefined ? PLUGIN_NAME : [PLUGIN_NAME, { appToken }];
}

/**
 * JSON the user adds by hand to `expo.plugins` when the config is app.config.js/ts (which this
 * step cannot edit). The token appears only if a token was given.
 */
export function expoPluginSnippet(tokens: Tokens): string {
  return JSON.stringify(entryFor(tokens), null, 2);
}

function nameOf(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  if (Array.isArray(entry) && typeof entry[0] === 'string') return entry[0];
  return undefined;
}

function serialize(parsed: unknown, original: string): string {
  const indent = detectIndent(original).indent || '  ';
  const out = JSON.stringify(parsed, null, indent);
  return original.endsWith('\n') ? `${out}\n` : out;
}

function parse(content: string): ExpoConfigShape | undefined {
  try {
    const v = JSON.parse(content) as unknown;
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as ExpoConfigShape)
      : undefined;
  } catch {
    return undefined;
  }
}

export const expoPluginStep: Step<RnContext> = {
  id: 'react-native.expo-plugin',
  title: `Add the ${PLUGIN_NAME} config plugin to app.json`,

  async precheck(ctx): Promise<StepStatus> {
    const file = ctx.rnPaths.expoConfig;
    if (file === null) return { kind: 'satisfied', note: 'not an Expo project (no app.json)' };
    const content = await readOrNull(file);
    if (content === null) return { kind: 'blocked', reason: `${file} not found` };
    const parsed = parse(content);
    if (!parsed) return { kind: 'blocked', reason: `${file} is not a valid JSON object` };
    const plugins = parsed.expo?.plugins;
    if (plugins !== undefined && !Array.isArray(plugins)) {
      return { kind: 'blocked', reason: `${file}: expo.plugins is not an array` };
    }
    if (plugins?.some((p) => nameOf(p) === PLUGIN_NAME)) {
      return { kind: 'satisfied', note: `${PLUGIN_NAME} is already in expo.plugins` };
    }
    return { kind: 'pending' };
  },

  async apply(ctx) {
    const file = ctx.rnPaths.expoConfig;
    if (file === null) return;
    const original = await readOrNull(file);
    if (original === null) throw new Error(`${file} not found`);
    const parsed = parse(original);
    if (!parsed) throw new Error(`${file} is not a valid JSON object`);
    const expo = (parsed.expo ?? {}) as NonNullable<ExpoConfigShape['expo']>;
    parsed.expo = expo;
    const createdPlugins = expo.plugins === undefined;
    const plugins = (expo.plugins ?? []) as unknown[];
    const entry = entryFor(ctx.tokens);
    plugins.push(entry);
    expo.plugins = plugins;
    const written = serialize(parsed, original);
    await writeFile(file, written);
    added.set(ctx, { original, written, entry: JSON.stringify(entry), createdPlugins });
  },

  async rollback(ctx) {
    const file = ctx.rnPaths.expoConfig;
    if (file === null) return;
    const rec = added.get(ctx);
    const current = await readOrNull(file);
    if (current === null) return;
    added.delete(ctx);
    if (rec && current === rec.written) {
      await writeFile(file, rec.original);
      return;
    }
    const parsed = parse(current);
    const plugins = parsed?.expo?.plugins;
    if (!parsed || !Array.isArray(plugins)) return;
    // With a record (failed run): only the entry we wrote, if unchanged.
    // Without one (uninstall): any entry for our plugin, in either form.
    const idx = plugins.findIndex((p) =>
      rec ? JSON.stringify(p) === rec.entry : nameOf(p) === PLUGIN_NAME,
    );
    if (idx === -1) return;
    plugins.splice(idx, 1);
    if (plugins.length === 0 && rec?.createdPlugins && parsed.expo) {
      delete parsed.expo.plugins;
    }
    await writeFile(file, serialize(parsed, current));
  },
};
