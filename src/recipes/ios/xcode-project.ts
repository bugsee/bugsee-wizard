import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import * as xcode from 'xcode';

import type { PBXNativeTarget, UUID, XcodeProject as XcodeProjectInternal } from 'xcode';

/** Loose alias used while traversing the parsed pbxproj graph. */
type Section = Record<string, Record<string, unknown> | string>;

export interface SpmRequirement {
  readonly kind: 'upToNextMajorVersion' | 'branch' | 'exactVersion';
  readonly version?: string;
  readonly branch?: string;
}

/**
 * Thin wrapper around the `xcode` npm package's parser. Exposes only the
 * operations the iOS wizard needs (find a native target by name, add or
 * remove an SPM dependency on a package URL + product). Everything that
 * mutates the parsed graph touches `project.hash.project.objects` directly,
 * which is the contract the package exposes for advanced edits the typed
 * helpers don't cover (notably SPM, which requires touching multiple
 * sections atomically).
 */
export class XcodeProject {
  /** Path to the `*.xcodeproj/project.pbxproj` file. */
  private readonly pbxprojPath: string;
  private readonly project: XcodeProjectInternal;

  constructor(xcodeProjectDir: string) {
    this.pbxprojPath = path.join(xcodeProjectDir, 'project.pbxproj');
    this.project = xcode.project(this.pbxprojPath);
    this.project.parseSync();
  }

  /**
   * Locate a `PBXNativeTarget` by `name`. Returns the UUID of the target
   * and the parsed target object, or null if no target with that name
   * exists in the project.
   */
  findNativeTarget(name: string): { uuid: UUID; target: PBXNativeTarget } | null {
    const objects = this.project.hash.project.objects;
    const section = (objects.PBXNativeTarget as Section | undefined) ?? {};
    for (const [uuid, value] of Object.entries(section)) {
      if (uuid.endsWith('_comment') || typeof value === 'string') continue;
      const target = value as PBXNativeTarget;
      if (target.name === name) return { uuid, target };
    }
    return null;
  }

  /**
   * Returns true when the consuming target already has a Swift Package
   * product dependency with the given productName. Mirrors what the user
   * sees in Xcode's Package Dependencies tab.
   */
  hasSpmProduct(targetName: string, productName: string): boolean {
    const found = this.findNativeTarget(targetName);
    if (!found) return false;
    const objects = this.project.hash.project.objects;
    const productSection = (objects.XCSwiftPackageProductDependency as Section | undefined) ?? {};
    const targetDeps = (found.target.packageProductDependencies ?? []) as Array<{
      value: UUID;
      comment?: string;
    }>;
    for (const ref of targetDeps) {
      const dep = productSection[ref.value];
      if (!dep || typeof dep === 'string') continue;
      if ((dep as Record<string, unknown>).productName === productName) return true;
    }
    return false;
  }

  /**
   * Add an SPM dependency on `packageUrl` and link `productName` to the
   * given target. No-op when the product is already linked.
   *
   * Implementation mirrors the four-section update Xcode itself emits:
   * 1. Create XCRemoteSwiftPackageReference (the package URL + version rule)
   * 2. Create XCSwiftPackageProductDependency (the product within that package)
   * 3. Append the package ref to the project's `packageReferences`
   * 4. Append the product dep to the target's `packageProductDependencies`
   */
  addSpmDependency(input: {
    targetName: string;
    packageUrl: string;
    productName: string;
    /** A short label used for object comments — e.g. 'spm' for github.com/bugsee/spm. */
    packageName: string;
    requirement: SpmRequirement;
  }): void {
    const { targetName, packageUrl, productName, packageName, requirement } = input;
    if (this.hasSpmProduct(targetName, productName)) return;

    const found = this.findNativeTarget(targetName);
    if (!found) {
      throw new Error(`Native target ${JSON.stringify(targetName)} not found in pbxproj`);
    }
    const target = found.target;

    const objects = this.project.hash.project.objects as unknown as Record<string, Section>;
    const ensure = (key: string): Section => {
      if (!objects[key]) objects[key] = {};
      const section = objects[key];
      // Type narrowing — `objects[key]` was just initialised, so it is non-null.
      if (!section) throw new Error('section initialisation failed');
      return section;
    };

    const packageRefSection = ensure('XCRemoteSwiftPackageReference');
    const productDepSection = ensure('XCSwiftPackageProductDependency');

    const packageRefUuid = this.project.generateUuid();
    const productDepUuid = this.project.generateUuid();

    const packageRefComment = `XCRemoteSwiftPackageReference "${packageName}"`;

    const requirementBlock: Record<string, string> = { kind: requirement.kind };
    if (requirement.kind === 'upToNextMajorVersion' || requirement.kind === 'exactVersion') {
      if (!requirement.version) {
        throw new Error(`requirement.kind=${requirement.kind} needs a version`);
      }
      if (requirement.kind === 'upToNextMajorVersion') {
        requirementBlock.minimumVersion = requirement.version;
      } else {
        requirementBlock.version = requirement.version;
      }
    } else if (requirement.kind === 'branch') {
      if (!requirement.branch) throw new Error('requirement.kind=branch needs a branch');
      requirementBlock.branch = requirement.branch;
    }

    packageRefSection[packageRefUuid] = {
      isa: 'XCRemoteSwiftPackageReference',
      repositoryURL: `"${packageUrl}"`,
      requirement: requirementBlock,
    };
    packageRefSection[`${packageRefUuid}_comment`] = packageRefComment;

    productDepSection[productDepUuid] = {
      isa: 'XCSwiftPackageProductDependency',
      package: packageRefUuid,
      package_comment: packageRefComment,
      productName,
    };
    productDepSection[`${productDepUuid}_comment`] = productName;

    // Attach the package ref to the project's packageReferences list.
    const xcProject = this.project.getFirstProject().firstProject;
    const projectRecord = xcProject as unknown as Record<string, unknown>;
    if (!Array.isArray(projectRecord.packageReferences)) {
      projectRecord.packageReferences = [];
    }
    (projectRecord.packageReferences as Array<{ value: UUID; comment?: string }>).push({
      value: packageRefUuid,
      comment: packageRefComment,
    });

    // Attach the product dep to the target.
    const targetRecord = target as unknown as Record<string, unknown>;
    if (!Array.isArray(targetRecord.packageProductDependencies)) {
      targetRecord.packageProductDependencies = [];
    }
    (targetRecord.packageProductDependencies as Array<{ value: UUID; comment?: string }>).push({
      value: productDepUuid,
      comment: productName,
    });
  }

  /**
   * Remove the SPM dependency on `productName` from the given target.
   * If the package reference becomes orphaned (no other product references
   * it), the package reference itself is also removed. No-op when the
   * product isn't linked.
   */
  removeSpmDependency(targetName: string, productName: string): boolean {
    const found = this.findNativeTarget(targetName);
    if (!found) return false;
    const target = found.target;

    const objects = this.project.hash.project.objects as unknown as Record<string, Section>;
    const productSection = objects.XCSwiftPackageProductDependency;
    const packageSection = objects.XCRemoteSwiftPackageReference;

    const targetRecord = target as unknown as Record<string, unknown>;
    const targetDeps =
      (targetRecord.packageProductDependencies as
        | Array<{ value: UUID; comment?: string }>
        | undefined) ?? [];

    let packageRefUuid: UUID | null = null;
    const remaining: Array<{ value: UUID; comment?: string }> = [];
    let removedAny = false;
    for (const dep of targetDeps) {
      const obj = productSection?.[dep.value];
      if (!obj || typeof obj === 'string') {
        remaining.push(dep);
        continue;
      }
      if ((obj as Record<string, unknown>).productName === productName) {
        packageRefUuid = ((obj as Record<string, unknown>).package as UUID) ?? null;
        if (productSection) {
          delete productSection[dep.value];
          delete productSection[`${dep.value}_comment`];
        }
        removedAny = true;
        continue;
      }
      remaining.push(dep);
    }
    targetRecord.packageProductDependencies = remaining;

    if (!removedAny) return false;

    // Drop the package reference if no remaining product references it.
    if (packageRefUuid && productSection) {
      const stillReferenced = Object.entries(productSection).some(([k, v]) => {
        if (k.endsWith('_comment') || typeof v === 'string') return false;
        return (v as Record<string, unknown>).package === packageRefUuid;
      });
      if (!stillReferenced) {
        if (packageSection) {
          delete packageSection[packageRefUuid];
          delete packageSection[`${packageRefUuid}_comment`];
        }
        const xcProject = this.project.getFirstProject().firstProject;
        const projectRecord = xcProject as unknown as Record<string, unknown>;
        const refs =
          (projectRecord.packageReferences as
            | Array<{ value: UUID; comment?: string }>
            | undefined) ?? [];
        projectRecord.packageReferences = refs.filter((r) => r.value !== packageRefUuid);
      }
    }

    return true;
  }

  async save(): Promise<void> {
    const text = this.project.writeSync();
    await writeFile(this.pbxprojPath, text);
  }
}
