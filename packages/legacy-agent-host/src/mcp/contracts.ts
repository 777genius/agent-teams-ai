import type { TeamOwner } from '../team/TeamOwner.js';
import type { DeliveryBinding } from '../team/contracts.js';

/** Captured by trusted composition using TeamOwner.connect(principalId). */
export type TeamMcpConnection = Pick<ReturnType<TeamOwner['connect']>,
  'execute' | 'lookup' | 'getTask' | 'listTasks'>;

export interface TeamMcpEndpointOptions {
  connection: TeamMcpConnection;
  binding: DeliveryBinding;
  expiresAtMs: number;
  /** Current owner/run/member/generation registry check, independent of Team grants. */
  isCurrentBinding(binding: Readonly<DeliveryBinding>): boolean;
  port?: number;
  maxRequestBytes?: number;
  maxConcurrentRequests?: number;
  now?: () => number;
}

/** Private composition handle. Never put its URL/token into public app DTOs or logs. */
export interface TeamMcpEndpoint {
  readonly url: string;
  readonly bearerToken: string;
  readonly binding: Readonly<DeliveryBinding>;
  revoke(): void;
  close(): Promise<void>;
}

export class McpToolFailure extends Error {
  constructor(readonly code: 'invalid' | 'forbidden' | 'unsupported' | 'output-limit') {
    super(`MCP operation ${code}`);
  }
}
