import type { TeamOwner } from '../team/TeamOwner.js';
import type { WorkSyncInputAuthority, WorkSyncTeamProof } from '../work-sync/commandContracts.js';
import type { RuntimeDelivery, RuntimeSessionRecord } from '../runtime/contracts.js';
import type { MemberWorkSyncProviderId } from '../work-sync/policy/contracts/index.js';

/** Trusted connection facts, never part of a native tool schema. */
export interface NativeWorkSyncMemberContext {
  teamId: string;
  teamName: string;
  owner: TeamOwner;
  providerId: MemberWorkSyncProviderId;
  sourceRevision: string;
  captureSource(): WorkSyncInputAuthority;
  /** Optional only while older status/report-only composition is being migrated. */
  delivery?: {
    principalId: string;
    readRuntime(): { record: RuntimeSessionRecord | undefined; attached: boolean };
    captureTeam(original: RuntimeDelivery): Readonly<WorkSyncTeamProof>;
    assertCurrent(): void;
    settleDeliveries(): Promise<void>;
  };
}
