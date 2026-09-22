import { MemberSettingsMutationBusyError } from '../../core/application/ports/UpdateMemberSettingsPorts';

import type { MemberSettingsMutationGatePort } from '../../core/application/ports/UpdateMemberSettingsPorts';

export interface LegacyLiveRosterMutationSource {
  runLiveRosterMutation(teamName: string, mutation: () => Promise<void>): Promise<void>;
  tryRunLiveRosterMutation?(teamName: string, mutation: () => Promise<void>): Promise<boolean>;
}

/** Adapts the legacy roster lock without exposing the lifecycle service to the use case. */
export class LegacyMemberSettingsMutationGateAdapter implements MemberSettingsMutationGatePort {
  constructor(private readonly source: LegacyLiveRosterMutationSource) {}

  async runExclusive<T>(teamName: string, operation: () => Promise<T>): Promise<T> {
    let completed = false;
    let result!: T;
    const mutation = async (): Promise<void> => {
      result = await operation();
      completed = true;
    };
    if (this.source.tryRunLiveRosterMutation) {
      const acquired = await this.source.tryRunLiveRosterMutation(teamName, mutation);
      if (!acquired) throw new MemberSettingsMutationBusyError(teamName);
    } else {
      await this.source.runLiveRosterMutation(teamName, mutation);
    }
    if (!completed) {
      throw new Error('Live roster mutation gate completed without running its callback');
    }
    return result;
  }
}
