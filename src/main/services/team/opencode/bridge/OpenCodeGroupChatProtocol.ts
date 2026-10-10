/** Runtime publishes this only for the currently live member bridge. */
export interface OpenCodeGroupChatRunProof {
  teamName: string;
  memberName: string;
  runId: string;
  runKey: string;
  laneId: string | null;
  runtimeSessionId: string;
  runtimePid: number;
  processorReady: boolean;
}

/** Physical inbox destination metadata is preserved by send and observation. */
export interface OpenCodeGroupDeliveryEnvelope {
  groupChatId?: string;
  groupRunKey?: string;
  from?: string;
  groupChatName?: string;
  timestamp?: string;
  groupMessageId?: string;
  groupChatProtocolVersion?: 1;
  relayOfMessageId?: string;
}
