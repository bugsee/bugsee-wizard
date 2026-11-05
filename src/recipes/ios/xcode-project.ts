import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PBXNativeTarget, UUID, XcodeProject as XcodeProjectInternal } from 'xcode';
import * as xcode from 'xcode';

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
  hasSpmProduct(targetName: string, productName: string, packageUrl?: string): boolean {
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
      if ((dep as Record<string, unknown>).productName !== productName) continue;
      if (packageUrl === undefined) return true;
      if (this.productPackageUrlMatches(dep as Record<string, unknown>, packageUrl)) return true;
    }
    return false;
  }

  /**
   * True when the product dependency resolves (through its `package` UUID) to
   * an XCRemoteSwiftPackageReference whose repositoryURL is `packageUrl`
   * (ignoring quotes, case, a trailing slash and a `.git` suffix).
   */
  private productPackageUrlMatches(dep: Record<string, unknown>, packageUrl: string): boolean {
    const objects = this.project.hash.project.objects as unknown as Record<string, Section>;
    const ref = objects.XCRemoteSwiftPackageReference?.[String(dep.package)];
    if (!ref || typeof ref === 'string') return false;
    const normalize = (u: string) =>
      u
        .replace(/^"|"$/g, '')
        .replace(/\/+$/, '')
        .replace(/\.git$/i, '')
        .toLowerCase();
    return (
      normalize(String((ref as Record<string, unknown>).repositoryURL ?? '')) ===
      normalize(packageUrl)
    );
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
    if (this.hasSpmProduct(targetName, productName, packageUrl)) return;

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

    // Link the product: Xcode records it as a PBXBuildFile (productRef) in
    // the target's Frameworks phase. Without it the package is resolved but
    // never linked into the target.
    const buildFileSection = ensure('PBXBuildFile');
    const buildFileUuid = this.project.generateUuid();
    const buildFileComment = `${productName} in Frameworks`;
    buildFileSection[buildFileUuid] = {
      isa: 'PBXBuildFile',
      productRef: productDepUuid,
      productRef_comment: productName,
    };
    buildFileSection[`${buildFileUuid}_comment`] = buildFileComment;
    this.frameworksPhaseFiles(target, true)?.push({
      value: buildFileUuid,
      comment: buildFileComment,
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
   * The `files` array of the target's PBXFrameworksBuildPhase. When the
   * target has none and `create` is set, a new phase is added to the target.
   */
  private frameworksPhaseFiles(
    target: PBXNativeTarget,
    create: boolean,
  ): Array<{ value: UUID; comment?: string }> | null {
    const objects = this.project.hash.project.objects as unknown as Record<string, Section>;
    if (!objects.PBXFrameworksBuildPhase) objects.PBXFrameworksBuildPhase = {};
    const phases = objects.PBXFrameworksBuildPhase;
    const targetRecord = target as unknown as Record<string, unknown>;
    const buildPhases = (targetRecord.buildPhases ?? []) as Array<{ value: UUID }>;
    for (const ref of buildPhases) {
      const phase = phases[ref.value];
      if (phase && typeof phase !== 'string') {
        const rec = phase as Record<string, unknown>;
        if (!Array.isArray(rec.files)) rec.files = [];
        return rec.files as Array<{ value: UUID; comment?: string }>;
      }
    }
    if (!create) return null;
    const uuid = this.project.generateUuid();
    const files: Array<{ value: UUID; comment?: string }> = [];
    phases[uuid] = {
      isa: 'PBXFrameworksBuildPhase',
      buildActionMask: '2147483647',
      files,
      runOnlyForDeploymentPostprocessing: '0',
    } as unknown as Record<string, unknown>;
    phases[`${uuid}_comment`] = 'Frameworks';
    targetRecord.buildPhases = [...buildPhases, { value: uuid, comment: 'Frameworks' }];
    return files;
  }

  /**
   * Absolute paths of the files in the target's Sources build phase,
   * resolved through the PBXGroup tree. Returns null when the target is not
   * found or lists no sources (e.g. Xcode 16 synchronized folders), so the
   * caller can fall back to a heuristic.
   */
  targetSourceFiles(targetName: string): string[] | null {
    const found = this.findNativeTarget(targetName);
    if (!found) return null;
    const objects = this.project.hash.project.objects as unknown as Record<string, Section>;
    const rec = (section: string, id: string): Record<string, unknown> | null => {
      const v = objects[section]?.[id];
      return v && typeof v !== 'string' ? (v as Record<string, unknown>) : null;
    };
    const projectDir = path.dirname(path.dirname(this.pbxprojPath));
    const unquote = (v: unknown) => String(v).replace(/^"|"$/g, '');

    // Resolve every file reference to an absolute path by walking from the
    // main group down.
    const resolved = new Map<string, string>();
    const walk = (groupId: string, base: string, seen: Set<string>) => {
      if (seen.has(groupId)) return;
      seen.add(groupId);
      const group = rec('PBXGroup', groupId) ?? rec('PBXVariantGroup', groupId);
      if (!group) return;
      let dir = base;
      if (group.path !== undefined && (group.sourceTree ?? '<group>') !== 'SOURCE_ROOT') {
        dir = path.resolve(base, unquote(group.path));
      } else if (group.path !== undefined) {
        dir = path.resolve(projectDir, unquote(group.path));
      }
      for (const child of (group.children ?? []) as Array<{ value: UUID }>) {
        const file = rec('PBXFileReference', child.value);
        if (file) {
          if (file.path === undefined) continue;
          const p = unquote(file.path);
          const tree = unquote(file.sourceTree ?? '<group>');
          resolved.set(
            child.value,
            tree === 'SOURCE_ROOT' ? path.resolve(projectDir, p) : path.resolve(dir, p),
          );
        } else {
          walk(child.value, dir, seen);
        }
      }
    };
    const mainGroup = (
      this.project.getFirstProject().firstProject as unknown as { mainGroup: string }
    ).mainGroup;
    walk(mainGroup, projectDir, new Set());

    const out: string[] = [];
    const targetRecord = found.target as unknown as Record<string, unknown>;
    for (const ref of (targetRecord.buildPhases ?? []) as Array<{ value: UUID }>) {
      const phase = rec('PBXSourcesBuildPhase', ref.value);
      if (!phase) continue;
      for (const f of (phase.files ?? []) as Array<{ value: UUID }>) {
        const bf = rec('PBXBuildFile', f.value);
        const abs = bf?.fileRef ? resolved.get(String(bf.fileRef)) : undefined;
        if (abs) out.push(abs);
      }
    }
    return out.length > 0 ? out : null;
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
        this.removeBuildFilesFor(found.target, dep.value);
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

    // The `xcode` library creates these sections on add and leaves them as
    // empty `Begin/End` stubs after removal; drop any we just emptied so an
    // add -> remove round-trip restores the original file. (Xcode itself
    // never writes an empty section.)
    for (const name of [
      'XCSwiftPackageProductDependency',
      'XCRemoteSwiftPackageReference',
      'PBXBuildFile',
    ]) {
      const section = objects[name];
      if (section && Object.keys(section).length === 0) delete objects[name];
    }

    return true;
  }

  /** Drop the PBXBuildFile(s) linking `productDepUuid` and their phase entries. */
  private removeBuildFilesFor(target: PBXNativeTarget, productDepUuid: UUID): void {
    const objects = this.project.hash.project.objects as unknown as Record<string, Section>;
    const buildFiles = objects.PBXBuildFile;
    if (!buildFiles) return;
    const dropped = new Set<string>();
    for (const [k, v] of Object.entries(buildFiles)) {
      if (k.endsWith('_comment') || typeof v === 'string') continue;
      if ((v as Record<string, unknown>).productRef === productDepUuid) dropped.add(k);
    }
    for (const k of dropped) {
      delete buildFiles[k];
      delete buildFiles[`${k}_comment`];
    }
    const files = this.frameworksPhaseFiles(target, false);
    if (files) {
      for (let i = files.length - 1; i >= 0; i--) {
        if (dropped.has(files[i]?.value ?? '')) files.splice(i, 1);
      }
    }
  }

  async save(): Promise<void> {
    const text = this.project.writeSync();
    await writeFile(this.pbxprojPath, text);
  }
}
