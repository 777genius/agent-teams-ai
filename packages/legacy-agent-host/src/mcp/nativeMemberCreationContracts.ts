import type { JsonValue } from '../contracts.js';
/** Original authenticated lead DO input is captured privately, never selected by tool arguments. */
export interface TeamMcpNativeMemberCreationPort {
  invoke(operation: 'create' | 'lookup', raw: unknown): Promise<JsonValue>;
}
