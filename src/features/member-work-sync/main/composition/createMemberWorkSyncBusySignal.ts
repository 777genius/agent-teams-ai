import { createNativeMailboxMemberWorkSyncBusySignal } from '../adapters/output/NativeMailboxMemberWorkSyncBusySignal';
import { CompositeMemberWorkSyncBusySignal } from '../infrastructure/CompositeMemberWorkSyncBusySignal';
import { MemberWorkSyncToolActivityBusySignal } from '../infrastructure/MemberWorkSyncToolActivityBusySignal';

import type {
  MemberWorkSyncBusySignalPort,
  MemberWorkSyncLoggerPort,
} from '../../core/application';
import type { TeamChangeEvent } from '@shared/types';

export function createMemberWorkSyncBusySignal(input: {
  teamsBasePath: string;
  recoveryProtocolVersion?: number;
  priorityBusySignals?: MemberWorkSyncBusySignalPort[];
  extraBusySignals?: MemberWorkSyncBusySignalPort[];
  logger?: MemberWorkSyncLoggerPort;
}): {
  busySignal: MemberWorkSyncBusySignalPort;
  noteTeamChange: (event: TeamChangeEvent) => void;
} {
  const toolActivityBusySignal = new MemberWorkSyncToolActivityBusySignal();
  const protocol2BusySignals =
    (input.recoveryProtocolVersion ?? 0) >= 2
      ? [createNativeMailboxMemberWorkSyncBusySignal({ teamsBasePath: input.teamsBasePath })]
      : [];
  return {
    busySignal: CompositeMemberWorkSyncBusySignal.compose(toolActivityBusySignal, {
      priorityBusySignals: input.priorityBusySignals,
      extraBusySignals: [...protocol2BusySignals, ...(input.extraBusySignals ?? [])],
      logger: input.logger,
    }),
    noteTeamChange: (event) => toolActivityBusySignal.noteTeamChange(event),
  };
}
