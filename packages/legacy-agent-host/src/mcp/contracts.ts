import type { TeamMcpGroupPort } from './groupChatTools.js';
import type { TeamMcpNativeMemberCreationPort } from './nativeMemberCreationContracts.js';
import type { TeamMcpNativeMemberActionPort } from './nativeMemberActionContracts.js';
import type { TeamMcpWorkSyncPort } from './workSyncContracts.js';
import type { TeamMcpCrossTeamPort } from './nativeCrossTeamContracts.js';
import type { TeamOwner } from '../team/TeamOwner.js';
import type { DeliveryBinding } from '../team/contracts.js';

/** Captured by trusted composition using TeamOwner.connect(principalId). */
export type TeamMcpConnection = Pick<
  ReturnType<TeamOwner['connect']>,
  'execute' | 'lookup' | 'getTask' | 'listTasks'
> & {
  readonly readQueries?: NonNullable<ReturnType<TeamOwner['connect']>['readQueries']>;
  readonly groups?: TeamMcpGroupPort;
  readonly crossTeam?: TeamMcpCrossTeamPort;
  readonly workSync?: TeamMcpWorkSyncPort;
  readonly nativeMemberCreation?: TeamMcpNativeMemberCreationPort;
  readonly nativeMemberActions?: TeamMcpNativeMemberActionPort;
  readonly process?: Pick<
    ReturnType<TeamOwner['processCommands']>,
    'register' | 'metadata' | 'list' | 'lookup'
  >;
};

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
  /** Authenticated tools/list response served by this endpoint generation; private, not app readiness. */
  getCatalogReceipt?(): TeamMcpCatalogReceipt | undefined;
  revoke(): void;
  close(): Promise<void>;
}

export interface TeamMcpCatalogReceipt {
  readonly binding: Readonly<DeliveryBinding>;
  readonly toolNames: readonly string[];
  readonly sequence: number;
  readonly servedAtMs: number;
}

export class McpToolFailure extends Error {
  constructor(readonly code: 'invalid' | 'forbidden' | 'unsupported' | 'output-limit') {
    super(`MCP operation ${code}`);
  }
}
