import type {
  ExtensionManagementAPI,
  ExtensionSelection,
  LocalSkillChange,
  ManagementClient,
  ManagementPlan,
  ManagementSession,
  SkillCopyCandidate,
  SkillCopyDestination,
  SkillCopyReview,
} from '../../contracts';

/** Paths and executables stay on this trusted side of the renderer boundary. */
export interface CapturedExtensionEnvironment {
  identity: string;
  label: string;
  selection: ExtensionSelection;
  resources: readonly string[];
  resourcesForPlan?(plan: ManagementPlan): readonly string[];
  locateLocalSkill?(skillPath: string): Promise<{
    rootId: string;
    skillName: string;
    overlapsManagedPath(candidate: string): Promise<boolean>;
  }>;
  skillCopySources?(managedPaths: readonly string[]): Promise<SkillCopyCandidate[]>;
  prepareSkillCopy?(
    managedPaths: readonly string[],
    destination: SkillCopyDestination
  ): Promise<{ preview: SkillCopyReview; change: LocalSkillChange }>;
  assertCurrent(): Promise<void>;
  assertInactive(plan?: ManagementPlan): Promise<void>;
  connect(): Promise<{
    client: ManagementClient;
    session: ManagementSession;
    close(): Promise<void>;
  }>;
}
export interface ExtensionContextResolver {
  capture(selection: ExtensionSelection): Promise<CapturedExtensionEnvironment>;
}
export interface ExtensionManagementFeature extends ExtensionManagementAPI {
  close(): Promise<void>;
}
