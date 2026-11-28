import type { TeamOwner } from '../team/TeamOwner.js';
import type { captureNativeInputAuthority } from './captureNativeInputAuthority.js';
import type { RuntimeDelivery, RuntimeSessionRecord } from '../runtime/contracts.js';
import type { NativeMcpAuthorityProof } from '../team/NativeMcpAuthority.js';
import type { MemberWorkSyncProviderId } from '../work-sync/policy/contracts/index.js';

/** Trusted connection facts, never part of a native tool schema. */
export interface NativeWorkSyncMemberContext {
  teamId: string;
  teamName: string;
  owner: TeamOwner;
  providerId: MemberWorkSyncProviderId;
  sourceRevision: string;
  captureSource(): ReturnType<typeof captureNativeInputAuthority>;
  /** Optional only while older status/report-only composition is being migrated. */
  delivery?: {
    principalId: string;
    readRuntime(): { record: RuntimeSessionRecord | undefined; attached: boolean };
    captureTeam(original: RuntimeDelivery): Readonly<NativeMcpAuthorityProof>;
    assertCurrent(): void;
    settleDeliveries(): Promise<void>;
  };
}
