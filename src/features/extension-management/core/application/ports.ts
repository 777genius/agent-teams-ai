import type {
  ExtensionManagementAPI,
  ExtensionSelection,
  ManagementClient,
  ManagementPlan,
  ManagementSession,
} from '../../contracts';

/** Paths and executables stay on this trusted side of the renderer boundary. */
export interface CapturedExtensionEnvironment {
  identity: string;
  label: string;
  selection: ExtensionSelection;
  resources: readonly string[];
  resourcesForPlan?(plan: ManagementPlan): readonly string[];
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
