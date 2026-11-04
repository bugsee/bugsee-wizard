import type { Step, StepStatus } from '../../../core/step.js';
import { BUGSEE_SPM_PRODUCT, BUGSEE_SPM_URL, type IosContext } from '../types.js';
import { XcodeProject } from '../xcode-project.js';

const SPM_PACKAGE_NAME = 'spm';
// Floor for the Bugsee SPM repo's tagged versions. Matches the docs page —
// users get the latest 6.x release that satisfies the requirement.
const SPM_MIN_VERSION = '6.0.0';

export const addSpmDependencyStep: Step<IosContext> = {
  id: 'ios.add-spm-dependency',
  title: `Add ${BUGSEE_SPM_PRODUCT} Swift Package to project`,

  async precheck(ctx): Promise<StepStatus> {
    if (ctx.iosOptions.distribution !== 'spm') {
      return { kind: 'satisfied', note: 'SPM not selected' };
    }
    let proj: XcodeProject;
    try {
      proj = new XcodeProject(ctx.iosPaths.xcodeProject);
    } catch (err) {
      return {
        kind: 'blocked',
        reason: `Failed to parse ${ctx.iosPaths.xcodeProject}/project.pbxproj: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
    if (!proj.findNativeTarget(ctx.iosPaths.schemeName)) {
      return {
        kind: 'blocked',
        reason: `Native target ${JSON.stringify(ctx.iosPaths.schemeName)} not found in pbxproj`,
      };
    }
    return proj.hasSpmProduct(ctx.iosPaths.schemeName, BUGSEE_SPM_PRODUCT)
      ? { kind: 'satisfied' }
      : { kind: 'pending' };
  },

  async apply(ctx) {
    const proj = new XcodeProject(ctx.iosPaths.xcodeProject);
    proj.addSpmDependency({
      targetName: ctx.iosPaths.schemeName,
      packageUrl: BUGSEE_SPM_URL,
      productName: BUGSEE_SPM_PRODUCT,
      packageName: SPM_PACKAGE_NAME,
      requirement: { kind: 'upToNextMajorVersion', version: SPM_MIN_VERSION },
    });
    await proj.save();
  },

  async rollback(ctx) {
    let proj: XcodeProject;
    try {
      proj = new XcodeProject(ctx.iosPaths.xcodeProject);
    } catch {
      return;
    }
    const removed = proj.removeSpmDependency(ctx.iosPaths.schemeName, BUGSEE_SPM_PRODUCT);
    if (removed) await proj.save();
  },
};
