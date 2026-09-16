import type { BootId, DeploymentId } from '@shared/contracts/hosted';

declare const runtimeRootReferenceBrand: unique symbol;

export type RuntimeRootReferenceValue = string & {
  readonly [runtimeRootReferenceBrand]: 'RuntimeRootReferenceValue';
};

export type RuntimeRootKind = 'claude' | 'app-data' | 'workspace' | 'temp' | 'logs';

export interface RuntimeRootReference<Kind extends RuntimeRootKind = RuntimeRootKind> {
  readonly kind: Kind;
  readonly reference: RuntimeRootReferenceValue;
}

export interface RuntimeInstanceContext {
  readonly deploymentId: DeploymentId;
  readonly bootId: BootId;
  readonly claudeRoot: RuntimeRootReference<'claude'>;
  readonly appDataRoot: RuntimeRootReference<'app-data'>;
  readonly workspaceRoots: readonly RuntimeRootReference<'workspace'>[];
  readonly tempRoot: RuntimeRootReference<'temp'>;
  readonly logsRoot: RuntimeRootReference<'logs'>;
}
