import type { CodexAccountSnapshotDto } from '@features/codex-account/contracts';
import type { CodexRuntimeStatus } from '@features/codex-runtime-installer/contracts';
import type {
  RuntimeLocalProviderListInput,
  RuntimeLocalProviderListResponse,
  RuntimeLocalProviderScanInput,
  RuntimeLocalProviderScanResponse,
  RuntimeProviderManagementCancelModelLoadInput,
  RuntimeProviderManagementDirectoryResponse,
  RuntimeProviderManagementLoadDirectoryInput,
  RuntimeProviderManagementLoadModelsInput,
  RuntimeProviderManagementModelsResponse,
  RuntimeProviderManagementModelTestControlResponse,
} from '@features/runtime-provider-management/contracts';
import type {
  CliInstallationStatus,
  OpenCodeRuntimeStatus,
  ReplaceMembersRequest,
  TeamCreateRequest,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProvisioningPrepareResult,
} from '@shared/types';

export const RETAINED_LEGACY_LAUNCH_CHANNEL = 'agentBackend:retainedLegacyLaunch';
export const RETAINED_LEGACY_LAUNCH_ROUTE = '/api/agent-backend/retained-legacy-launch';

/** A temporary Main-owned choice. Never a saved Team setting or a native release receipt. */
export interface RetainedLegacyLaunchChoice {
  scopeId: string;
  teamName: string;
  mode: 'original-runtime';
  expiresAt: number;
  projectPath: string;
}

export type RetainedLegacyLaunchRequest =
  | { action: 'open'; teamName: string; intentId: string }
  | { action: 'closeIntent'; teamName: string; intentId: string }
  | { action: 'rebind'; scopeId: string; projectPath: string; intentId: string }
  | { action: 'close'; scopeId: string }
  | { action: 'read'; scopeId: string }
  | { action: 'status'; scopeId: string; projectPath: string }
  | { action: 'account'; scopeId: string }
  | { action: 'opencodeRuntime'; scopeId: string }
  | { action: 'codexRuntime'; scopeId: string }
  | { action: 'models'; scopeId: string; input: RuntimeProviderManagementLoadModelsInput }
  | { action: 'directory'; scopeId: string; input: RuntimeProviderManagementLoadDirectoryInput }
  | { action: 'localProviders'; scopeId: string; input: RuntimeLocalProviderListInput }
  | { action: 'scanLocalProviders'; scopeId: string; input: RuntimeLocalProviderScanInput }
  | {
      action: 'cancelModels';
      scopeId: string;
      input: RuntimeProviderManagementCancelModelLoadInput;
    }
  | { action: 'prepare'; scopeId: string; args: unknown[] }
  | { action: 'roster'; scopeId: string; request: ReplaceMembersRequest }
  | { action: 'launch'; scopeId: string; request: TeamLaunchRequest };

export interface RetainedLegacyLaunchValueMap {
  open: RetainedLegacyLaunchChoice;
  rebind: RetainedLegacyLaunchChoice;
  close: null;
  closeIntent: null;
  read: TeamCreateRequest;
  status: CliInstallationStatus;
  account: CodexAccountSnapshotDto;
  opencodeRuntime: OpenCodeRuntimeStatus;
  codexRuntime: CodexRuntimeStatus;
  models: RuntimeProviderManagementModelsResponse;
  directory: RuntimeProviderManagementDirectoryResponse;
  localProviders: RuntimeLocalProviderListResponse;
  scanLocalProviders: RuntimeLocalProviderScanResponse;
  cancelModels: RuntimeProviderManagementModelTestControlResponse;
  prepare: TeamProvisioningPrepareResult;
  roster: null;
  launch: TeamLaunchResponse;
}

export type RetainedLegacyLaunchFailure =
  | 'unavailable'
  | 'invalid'
  | 'source-changed'
  | 'account-changed'
  | 'import-not-absent'
  | 'not-eligible'
  | 'busy'
  | 'intent-changed'
  | 'outcome-unknown';

export type RetainedLegacyLaunchResult =
  | {
      [K in keyof RetainedLegacyLaunchValueMap]: {
        ok: true;
        action: K;
        value: RetainedLegacyLaunchValueMap[K];
      };
    }[keyof RetainedLegacyLaunchValueMap]
  | { ok: false; reason: RetainedLegacyLaunchFailure; outcome: 'not-dispatched' | 'unknown' };

export interface RetainedLegacyLaunchApi {
  retainedLegacyLaunch?(request: RetainedLegacyLaunchRequest): Promise<RetainedLegacyLaunchResult>;
}
