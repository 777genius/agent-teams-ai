import { claudeSubagentActivity } from './claudeSubagentActivity.js';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import type { ClaudeSubagentPort } from '@agent-teams/provider-implementations/claude';
import type { MemberEntry } from './MemberEntry.js';
import type { RuntimeBinding, RuntimeSessionRecord } from '../runtime/contracts.js';
import type { RuntimeProviderActivity } from '../runtime/providerActivityContracts.js';

/** Current persisted Team policy authorizes the original input; native child IDs select no authority. */
export function createClaudeSubagents(options: {
  entry: MemberEntry;
  isCurrent(): boolean;
  readRuntime(binding: RuntimeBinding): { record: RuntimeSessionRecord | undefined; attached: boolean };
  observe(binding: RuntimeBinding, sessionRef: string, activity: RuntimeProviderActivity): void;
}): ClaudeSubagentPort | undefined {
  const { entry } = options;
  if (entry.profile.provider !== 'claude') return;
  const tools = entry.profile.nativeTools.filter(name => !/^(Team|Task|TodoWrite|Agent|Cron|Schedule|SendMessage$|ListAgents$|mcp__)/.test(name));
  if (!tools.length) return;
  return {
    mode: 'do', tools,
    authorize: async authorization => {
      if (authorization.signal.aborted || !options.isCurrent()) return false;
      const captured = options.readRuntime(entry.binding);
      const input = captured.record?.inputs.find(input => input.intent.inputId === authorization.inputId && input.operationRef === authorization.operationRef && ['claimed', 'consumed'].includes(input.phase));
      return !!input && captured.attached && captured.record?.phase === 'allocated' && !captured.record.sealed && captured.record.custody === 'owned' && captured.record.nativeReady && captured.record.sessionRef === authorization.sessionRef &&
        entry.team.owner.allowsOrdinarySubagent(entry.profile.principalId, input.intent);
    },
    observe: async observation => {
      if (observation.signal.aborted || !options.isCurrent()) throw new RuntimeOwnerError('hold');
      options.observe(entry.binding, observation.sessionRef, claudeSubagentActivity(entry.binding, observation));
    },
  };
}
