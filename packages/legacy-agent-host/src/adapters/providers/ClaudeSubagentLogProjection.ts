import { claudeActivityReference } from './claudeActivityReference.js';
import type { Event } from '@agent-teams/provider-session-contracts';
import type { RuntimeBinding } from '../../runtime/contracts.js';

/** The parent native Agent result has CLI child-ID/usage trailers; child observations own its transcript. */
export class ClaudeSubagentLogProjection {
  private readonly parents = new Set<string>();
  private readonly binding: RuntimeBinding;
  constructor(binding: RuntimeBinding) { this.binding = binding; }
  project(event: Event): Event {
    if (event.kind === 'tool' && event.name === 'Agent') {
      this.parents.add(event.toolRef);
      return { ...event, toolRef: claudeActivityReference(this.binding, event.sessionRef, 'tool', event.toolRef) };
    }
    if (event.kind === 'tool-result' && this.parents.has(event.toolRef)) {
      return { ...event, toolRef: claudeActivityReference(this.binding, event.sessionRef, 'tool', event.toolRef),
        content: { scope: 'ordinary-subagent', outcome: event.isError ? 'failed' : 'returned', transcript: 'child-activity' } };
    }
    return event;
  }
}
