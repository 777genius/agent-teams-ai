export interface OpenCodeMemberInboxDeliveryWakeInput {
  teamName: string;
  memberName: string;
  messageId: string;
  delayMs?: number;
  isCurrent?: () => boolean;
}

export interface OpenCodeMemberInboxDeliveryWakePorts {
  watchdogScheduler: {
    isEnabled(): boolean;
  };
  scheduleWake(input: {
    teamName: string;
    memberName: string;
    messageId: string;
    delayMs: number;
    isCurrent?: () => boolean;
  }): void;
}

export function scheduleOpenCodeMemberInboxDeliveryWakeWithPorts(
  input: OpenCodeMemberInboxDeliveryWakeInput,
  ports: OpenCodeMemberInboxDeliveryWakePorts
): boolean {
  const teamName = input.teamName.trim();
  const memberName = input.memberName.trim();
  const messageId = input.messageId.trim();
  if (
    !teamName ||
    !memberName ||
    !messageId ||
    !ports.watchdogScheduler.isEnabled() ||
    input.isCurrent?.() === false
  ) {
    return false;
  }

  ports.scheduleWake({
    teamName,
    memberName,
    messageId,
    delayMs: Math.max(0, input.delayMs ?? 500),
    ...(input.isCurrent ? { isCurrent: input.isCurrent } : {}),
  });
  return true;
}
