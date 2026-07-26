import type {
  MemberWorkSyncBusySignalPort,
  MemberWorkSyncLoggerPort,
} from '../../core/application';

export class CompositeMemberWorkSyncBusySignal implements MemberWorkSyncBusySignalPort {
  static compose(
    primarySignal: MemberWorkSyncBusySignalPort,
    options: {
      priorityBusySignals?: MemberWorkSyncBusySignalPort[];
      extraBusySignals?: MemberWorkSyncBusySignalPort[];
      logger?: MemberWorkSyncLoggerPort;
    }
  ): MemberWorkSyncBusySignalPort {
    const signals = [
      ...(options.priorityBusySignals ?? []),
      primarySignal,
      ...(options.extraBusySignals ?? []),
    ];
    return signals.length === 1
      ? primarySignal
      : new CompositeMemberWorkSyncBusySignal(signals, options.logger);
  }

  constructor(
    private readonly signals: MemberWorkSyncBusySignalPort[],
    private readonly logger?: MemberWorkSyncLoggerPort
  ) {}

  async isBusy(input: Parameters<MemberWorkSyncBusySignalPort['isBusy']>[0]) {
    for (const signal of this.signals) {
      try {
        const result = await signal.isBusy(input);
        if (result.busy) {
          return result;
        }
      } catch (error) {
        this.logger?.warn('member work sync busy signal failed', {
          teamName: input.teamName,
          memberName: input.memberName,
          error: String(error),
        });
      }
    }

    return { busy: false };
  }
}
