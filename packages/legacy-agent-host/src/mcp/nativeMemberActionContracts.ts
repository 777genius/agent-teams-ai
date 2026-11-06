import type { JsonValue } from '../contracts.js';

/** Private authenticated connection port; original input authority never comes from tool arguments. */
export interface TeamMcpNativeMemberActionPort {
  invoke(
    operation: 'prepare' | 'execute' | 'read' | 'lookup' | 'retry',
    commandId: string,
    raw: unknown
  ): Promise<JsonValue>;
}
