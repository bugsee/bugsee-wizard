import type { PackageManagerName } from '../engine/package-manager.js';

export interface JsDetection {
  packageDir: string;
  packageManager: PackageManagerName | null;
  runtimes: string[];
  framework?: string;
  buildTool?: string;
  typescript: boolean;
  versions: Record<string, string>;
  workspace?: { root: string; packages: { dir: string; name: string }[] };
  needsPackageChoice: boolean;
}
