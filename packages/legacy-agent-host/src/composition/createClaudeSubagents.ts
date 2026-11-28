import { claudeSubagentActivity } from './claudeSubagentActivity.js';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import type { ClaudeSubagentPort } from '@agent-teams/provider-implementations/claude';
import type { MemberEntry } from './MemberEntry.js';
import type { RuntimeMemberProfile } from './runtimeProfile.js';
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
  return createCapturedClaudeSubagents({ ...options, profile: entry.profile, binding: entry.binding,
    allowsInput: intent => entry.team.owner.allowsOrdinarySubagent(entry.profile.principalId, intent) });
}

/** The caller owns input authority; this common native port adds no Team member or task. */
export function createCapturedClaudeSubagents(options: {
  profile: RuntimeMemberProfile;
  binding: RuntimeBinding;
  allowsInput(intent: RuntimeSessionRecord['inputs'][number]['intent']): boolean;
  isCurrent(): boolean;
  readRuntime(binding: RuntimeBinding): { record: RuntimeSessionRecord | undefined; attached: boolean };
  observe(binding: RuntimeBinding, sessionRef: string, activity: RuntimeProviderActivity): void;
}): ClaudeSubagentPort | undefined {
  if (options.profile.provider !== 'claude' || options.profile.nativeOptions?.permissionMode === 'plan') return;
  const tools = options.profile.nativeTools.filter(name => !/^(Team|Task|TodoWrite|Agent|Cron|Schedule|SendMessage$|ListAgents$|mcp__)/.test(name));
  if (!tools.length) return;
  return {
    mode: 'do', tools,
    authorize: async authorization => {
      if (authorization.signal.aborted || !options.isCurrent()) return false;
      const captured = options.readRuntime(options.binding);
      const input = captured.record?.inputs.find(input => input.intent.inputId === authorization.inputId && input.operationRef === authorization.operationRef && ['claimed', 'consumed'].includes(input.phase));
      return !!input && captured.attached && captured.record?.phase === 'allocated' && !captured.record.sealed && captured.record.custody === 'owned' && captured.record.nativeReady && captured.record.sessionRef === authorization.sessionRef &&
        options.allowsInput(input.intent);
    },
    observe: async observation => {
      if (observation.signal.aborted || !options.isCurrent()) throw new RuntimeOwnerError('hold');
      options.observe(options.binding, observation.sessionRef, claudeSubagentActivity(options.binding, observation));
    },
  };
}
