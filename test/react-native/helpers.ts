import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { vi } from 'vitest';

import type { WizardContext } from '../../src/core/context.js';
import { createLogger } from '../../src/core/logger.js';
import { discoverRnPaths } from '../../src/recipes/react-native/paths.js';
import type { RnContext, RnLaunchPath, RnOptions } from '../../src/recipes/react-native/types.js';

export async function makeFixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bugsee-rn-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

export async function readFixture(dir: string, rel: string): Promise<string> {
  return readFile(path.join(dir, rel), 'utf8');
}

export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

interface MakeRnContextOpts {
  cwd: string;
  launchPath?: RnLaunchPath;
  autoInjectJsEntry?: boolean;
  runPackageInstall?: boolean;
  tokens?: Record<string, string>;
}

/** Constructs an RnContext after running real path discovery. */
export async function makeRnContext(opts: MakeRnContextOpts): Promise<RnContext> {
  const paths = await discoverRnPaths(opts.cwd);
  const rnOptions: RnOptions = {
    launchPath: opts.launchPath ?? 'native',
    autoInjectJsEntry: opts.autoInjectJsEntry ?? true,
    runPackageInstall: opts.runPackageInstall ?? false,
  };
  const base: WizardContext = {
    cwd: opts.cwd,
    debug: false,
    dryRun: false,
    kind: 'react-native',
    tokens: opts.tokens ?? { android: 'AND_TOK', ios: 'IOS_TOKEN' },
    log: createLogger({ debug: false }),
  };
  return { ...base, kind: 'react-native', rnPaths: paths, rnOptions };
}

export const SAMPLE_RN_PACKAGE_JSON = JSON.stringify(
  {
    name: 'AwesomeProject',
    version: '0.0.1',
    private: true,
    scripts: { start: 'react-native start' },
    dependencies: {
      react: '18.2.0',
      'react-native': '0.74.0',
    },
    devDependencies: {
      '@babel/core': '7.20.0',
    },
  },
  null,
  2,
);

export const SAMPLE_APP_TSX = `import React from 'react';
import { SafeAreaView, Text } from 'react-native';

function App(): React.JSX.Element {
  return (
    <SafeAreaView>
      <Text>Hello</Text>
    </SafeAreaView>
  );
}

export default App;
`;

export const SAMPLE_INDEX_JS = `import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
`;

// Suppress clack noise across the RN suite.
export function _mockClack(): void {
  vi.mock('@clack/prompts', () => ({
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
      step: vi.fn(),
      message: vi.fn(),
    },
    cancel: vi.fn(),
    spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
  }));
}
