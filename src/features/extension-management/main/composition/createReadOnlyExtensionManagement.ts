import type { ExtensionManagementFeature } from '../../core/application/ports';

const reason =
  'This standalone viewer cannot coordinate agent activity. Open the Agent Teams desktop app to install, update or restore extensions.';

/** The standalone viewer has no runtime owner; never invent an idle activity source. */
export function createReadOnlyExtensionManagement(): ExtensionManagementFeature {
  const unavailable = async (): Promise<never> => {
    throw new Error(reason);
  };
  return {
    hostStatus: async () => ({ available: false, reason }),
    capture: unavailable,
    catalog: unavailable,
    detail: unavailable,
    discoverSkills: unavailable,
    previewSkill: unavailable,
    discardSkillCatalog: unavailable,
    environment: unavailable,
    localSkillStatus: unavailable,
    prepareLocalSkill: unavailable,
    skillCopySources: unavailable,
    previewSkillCopy: unavailable,
    prepare: unavailable,
    discardPlan: unavailable,
    apply: unavailable,
    operation: unavailable,
    cancel: unavailable,
    close: async () => {},
  };
}
