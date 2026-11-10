import type { OpenCodeTeamRuntimeMessageResult } from '../runtime';

export interface OpenCodeMemberSendSerializationPorts {
  inFlightByLane: OpenCodeMemberSendInFlightStore;
}

export interface OpenCodeMemberSendInFlightStore {
  get(laneKey: string): Promise<OpenCodeTeamRuntimeMessageResult> | undefined;
  set(laneKey: string, work: Promise<OpenCodeTeamRuntimeMessageResult>): void;
  delete(laneKey: string): void;
}

export interface OpenCodeMemberSerializedSendInput {
  teamName: string;
  laneId: string;
  send: () => Promise<OpenCodeTeamRuntimeMessageResult>;
}

export class OpenCodeMemberSendSerializer {
  constructor(private readonly ports: OpenCodeMemberSendSerializationPorts) {}

  getMemberRelayKey(teamName: string, memberName: string): string {
    return `${teamName}:${memberName.trim()}`;
  }

  getOpenCodeMemberRelayKey(teamName: string, memberName: string): string {
    return `opencode:${this.getMemberRelayKey(teamName, memberName)}`;
  }

  getOpenCodeMemberSendLaneKey(teamName: string, laneId: string): string {
    return `opencode-send:${teamName}:${laneId.trim()}`;
  }

  async sendSerialized(
    input: OpenCodeMemberSerializedSendInput
  ): Promise<OpenCodeTeamRuntimeMessageResult> {
    const laneKey = this.getOpenCodeMemberSendLaneKey(input.teamName, input.laneId);
    const previous = this.ports.inFlightByLane.get(laneKey);
    const work = (async (): Promise<OpenCodeTeamRuntimeMessageResult> => {
      if (previous) {
        try {
          await previous;
        } catch {
          // A failed send must not permanently block later deliveries on the same lane.
        }
      }
      return await input.send();
    })();

    this.ports.inFlightByLane.set(laneKey, work);
    try {
      return await work;
    } finally {
      if (this.ports.inFlightByLane.get(laneKey) === work) {
        this.ports.inFlightByLane.delete(laneKey);
      }
    }
  }
}
