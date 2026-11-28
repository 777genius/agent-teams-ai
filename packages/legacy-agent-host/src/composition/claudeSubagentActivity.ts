import { claudeActivityReference } from '../adapters/providers/claudeActivityReference.js';
import { normalizeActivity } from '../runtime/normalizeActivity.js';
import type { ClaudeSubagentObservation } from '@agent-teams/provider-implementations/claude';
import type { RuntimeBinding } from '../runtime/contracts.js';
import type { RuntimeProviderActivity } from '../runtime/providerActivityContracts.js';

/** Private native IDs end here. This is observation, never a Team member, Task or billed usage. */
export function claudeSubagentActivity(binding: RuntimeBinding, observation: ClaudeSubagentObservation): RuntimeProviderActivity {
  const alias = (kind: string, native: string) => claudeActivityReference(binding, observation.sessionRef, kind, native);
  const data: RuntimeProviderActivity['data'] = { kind: 'subagent', phase: observation.phase,
    ...(observation.childRef ? { childId: alias('child', observation.childRef) } : {}),
    ...(observation.parentToolRef ? { parentToolRef: alias('tool', observation.parentToolRef) } : {}) };
  if (observation.phase === 'fact' || observation.phase === 'interaction') {
    const fact = { ...observation.fact };
    if ('messageRef' in fact) fact.messageRef = alias('message', fact.messageRef);
    if ('toolRef' in fact) fact.toolRef = alias('tool', fact.toolRef);
    data.fact = normalizeActivity({ ...fact, sessionRef: observation.sessionRef });
  } else if (observation.phase === 'usage') {
    data.childTotalTokens = observation.totalTokens;
    data.childToolUses = observation.toolUses;
    data.childDurationMs = observation.durationMs;
  } else if (observation.phase === 'gap') data.reason = observation.reason;
  return { ...(observation.inputId === undefined ? {} : { inputId: observation.inputId }),
    ...(observation.operationRef === undefined ? {} : { operationRef: observation.operationRef }), data };
}
