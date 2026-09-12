export const OPEN_CODE_BRIDGE_COMMAND_NAMES = [
  'opencode.handshake',
  'opencode.commandStatus',
  'opencode.readiness',
  'opencode.cleanupStartupHosts',
  'opencode.reapUnleasedCursorAgentTrees',
  'opencode.cleanupHosts',
  'opencode.launchTeam',
  'opencode.reconcileTeam',
  'opencode.stopTeam',
  'opencode.stopOutcome',
  'opencode.reconcileStop',
  'opencode.sendMessage',
  'opencode.observeMessageDelivery',
  'opencode.answerPermission',
  'opencode.listRuntimePermissions',
  'opencode.getRuntimeTranscript',
  'opencode.recoverDeliveryJournal',
  'opencode.backfillTaskLedger',
] as const;

export type OpenCodeBridgeCommandName = (typeof OPEN_CODE_BRIDGE_COMMAND_NAMES)[number];
