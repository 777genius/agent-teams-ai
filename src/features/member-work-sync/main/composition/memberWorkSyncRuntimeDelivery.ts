export type OpenCodeWorkSyncLaneDeliveryReason =
  | 'work_sync_lane_reserved'
  | 'work_sync_ticket_stale'
  | 'work_sync_ticket_consumed'
  | 'work_sync_admission_stopped';

export interface OpenCodeWorkSyncDeliveryInput {
  teamName: string;
  memberName: string;
  messageId?: string;
  messageKind?: string;
  workSyncRuntimeTicketId?: string;
  workSyncControlRevision?: number;
  source?: string;
}

interface OpenCodeWorkSyncDeliveryMessage {
  messageKind?: string;
  workSyncRuntimeTicketId?: string;
}

export interface OpenCodeWorkSyncDeliveryLane {
  readonly reason?: OpenCodeWorkSyncLaneDeliveryReason;
  restore(): void;
}

interface OpenCodeWorkSyncDeliveryAdmission extends OpenCodeWorkSyncDeliveryLane {
  send<T>(input: {
    message: OpenCodeWorkSyncDeliveryMessage;
    checkpoint: () => Promise<void>;
    serialize: (send: () => Promise<T>) => Promise<T>;
    sendMessage: () => Promise<T>;
  }): Promise<{ ok: true; result: T } | { ok: false; reason: OpenCodeWorkSyncLaneDeliveryReason }>;
}

export interface NativeWorkSyncRuntimeIdentityInput {
  teamsBasePath: string;
  teamName: string;
  memberName: string;
}

export interface MemberWorkSyncRuntimeDeliveryDependencies<
  TOpenCodeLane extends OpenCodeWorkSyncDeliveryLane = OpenCodeWorkSyncDeliveryLane,
> {
  prepareOpenCodeDeliveryLane(
    input: OpenCodeWorkSyncDeliveryInput
  ): Promise<TOpenCodeLane>;
  sendOpenCodeAdmittedMessage<T>(input: {
    lane: TOpenCodeLane;
    message: OpenCodeWorkSyncDeliveryMessage;
    restore: () => void;
    checkpoint: () => Promise<void>;
    serialize: (send: () => Promise<T>) => Promise<T>;
    sendMessage: () => Promise<T>;
  }): Promise<{ ok: true; result: T } | { ok: false; reason: OpenCodeWorkSyncLaneDeliveryReason }>;
  readCurrentNativeRuntimeInstanceId(input: NativeWorkSyncRuntimeIdentityInput): Promise<string | null>;
}

export interface MemberWorkSyncRuntimeDelivery {
  prepareOpenCodeDelivery(
    input: OpenCodeWorkSyncDeliveryInput
  ): Promise<OpenCodeWorkSyncDeliveryAdmission>;
  readCurrentNativeRuntimeInstanceId(
    input: NativeWorkSyncRuntimeIdentityInput
  ): Promise<string | null>;
}

/** Builds the runtime-delivery facade from narrow, main-composition-owned capabilities. */
export function createMemberWorkSyncRuntimeDelivery<
  TOpenCodeLane extends OpenCodeWorkSyncDeliveryLane,
>(
  dependencies: MemberWorkSyncRuntimeDeliveryDependencies<TOpenCodeLane>
): MemberWorkSyncRuntimeDelivery {
  return {
    prepareOpenCodeDelivery: async (input) => {
      const lane = await dependencies.prepareOpenCodeDeliveryLane(input);
      return {
        reason: lane.reason,
        restore: lane.restore,
        send: (sendInput) =>
          dependencies.sendOpenCodeAdmittedMessage({
            lane,
            ...sendInput,
            restore: lane.restore,
          }),
      };
    },
    readCurrentNativeRuntimeInstanceId: (input) =>
      dependencies.readCurrentNativeRuntimeInstanceId(input),
  };
}
