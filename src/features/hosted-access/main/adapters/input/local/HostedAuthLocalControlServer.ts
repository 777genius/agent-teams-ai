import { HOSTED_ROLES, type HostedRole } from '../../../../contracts';

import type {
  HostedAuthHostPlatform,
  HostedAuthLocalControlTransport,
  HostedAuthLocalControlTransportFactory,
  HostedLocalAdministration,
} from '../../../../core/application';

const MAX_REQUEST_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

interface LocalControlRequest {
  readonly version: 1;
  readonly command: string;
  readonly arguments: Record<string, unknown>;
}

interface HostedAuthLocalControlServerDependencies {
  readonly socketPath: string;
  readonly administration: HostedLocalAdministration;
  readonly platform: Pick<HostedAuthHostPlatform, 'byteLength' | 'isAbsolute'>;
  readonly transportFactory: HostedAuthLocalControlTransportFactory;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('hosted_local_control_request_invalid');
  }
  return value as Record<string, unknown>;
}

function stringArgument(
  argumentsValue: Record<string, unknown>,
  name: string,
  maximum = 256
): string {
  const value = argumentsValue[name];
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new TypeError('hosted_local_control_argument_invalid');
  }
  return value;
}

function parseRequest(body: string): LocalControlRequest {
  const row = record(JSON.parse(body));
  if (
    row.version !== 1 ||
    typeof row.command !== 'string' ||
    Reflect.ownKeys(row).some(
      (key) => typeof key !== 'string' || !['version', 'command', 'arguments'].includes(key)
    )
  ) {
    throw new TypeError('hosted_local_control_request_invalid');
  }
  return Object.freeze({
    version: 1,
    command: row.command,
    arguments: record(row.arguments),
  });
}

function assertArgumentKeys(
  argumentsValue: Record<string, unknown>,
  expected: readonly string[]
): void {
  if (
    Reflect.ownKeys(argumentsValue).some(
      (key) => typeof key !== 'string' || !expected.includes(key)
    ) ||
    expected.some((key) => !Object.hasOwn(argumentsValue, key))
  ) {
    throw new TypeError('hosted_local_control_argument_invalid');
  }
}

function errorCode(error: unknown): string {
  if (error instanceof Error) {
    if (error.message.startsWith('hosted_local_control_')) {
      return error.message.slice('hosted_local_control_'.length);
    }
    if (error.message.startsWith('hosted-access-')) return 'argument_invalid';
    if (error instanceof SyntaxError || error instanceof TypeError) return 'request_invalid';
  }
  return 'internal_error';
}

function response(ok: boolean, value: unknown): string {
  return `${JSON.stringify(ok ? { ok: true, value } : { ok: false, code: value })}\n`;
}

export async function executeHostedAuthLocalControlRequest(
  administration: HostedLocalAdministration,
  body: string
): Promise<unknown> {
  const request = parseRequest(body);
  const args = request.arguments;
  switch (request.command) {
    case 'users.list':
      assertArgumentKeys(args, []);
      return administration.listUsers();
    case 'users.enable':
    case 'users.disable':
      assertArgumentKeys(args, ['userId']);
      return {
        changed: await administration.setUserStatus(
          stringArgument(args, 'userId', 128),
          request.command === 'users.enable' ? 'active' : 'disabled'
        ),
      };
    case 'roles.set': {
      assertArgumentKeys(args, ['userId', 'role']);
      const role = stringArgument(args, 'role');
      if (!HOSTED_ROLES.includes(role as HostedRole)) {
        throw new TypeError('hosted_local_control_role_invalid');
      }
      await administration.setLocalRole(stringArgument(args, 'userId', 128), role as HostedRole);
      return { updated: true, effectiveAfter: 'reauthentication' };
    }
    case 'roles.clear':
      assertArgumentKeys(args, ['userId']);
      return {
        cleared: await administration.clearLocalRole(stringArgument(args, 'userId', 128)),
        effectiveAfter: 'reauthentication',
      };
    case 'workspaces.list':
      assertArgumentKeys(args, []);
      return administration.listWorkspaces();
    case 'workspaces.register':
      assertArgumentKeys(args, ['workspaceId', 'displayName']);
      return administration.registerWorkspace(
        stringArgument(args, 'workspaceId'),
        stringArgument(args, 'displayName')
      );
    case 'workspaces.disable':
      assertArgumentKeys(args, ['workspaceId']);
      return {
        disabled: await administration.disableWorkspace(stringArgument(args, 'workspaceId')),
      };
    case 'workspaces.grant':
      assertArgumentKeys(args, ['userId', 'workspaceId']);
      return administration.grantWorkspace(
        stringArgument(args, 'userId', 128),
        stringArgument(args, 'workspaceId')
      );
    case 'workspaces.revoke':
      assertArgumentKeys(args, ['userId', 'workspaceId']);
      return {
        revoked: await administration.revokeWorkspaceGrant(
          stringArgument(args, 'userId', 128),
          stringArgument(args, 'workspaceId')
        ),
      };
    case 'personal.reset': {
      assertArgumentKeys(args, ['resetGeneration']);
      const resetGeneration = args.resetGeneration;
      if (!Number.isSafeInteger(resetGeneration) || Number(resetGeneration) <= 0) {
        throw new TypeError('hosted_local_control_reset_generation_invalid');
      }
      return administration.resetPersonal(Number(resetGeneration));
    }
    case 'auth-mode.reset': {
      assertArgumentKeys(args, ['targetMode', 'resetGeneration']);
      const targetMode = stringArgument(args, 'targetMode');
      if (targetMode !== 'personal' && targetMode !== 'oidc') {
        throw new TypeError('hosted_local_control_auth_mode_invalid');
      }
      const resetGeneration = args.resetGeneration;
      if (!Number.isSafeInteger(resetGeneration) || Number(resetGeneration) <= 0) {
        throw new TypeError('hosted_local_control_reset_generation_invalid');
      }
      return administration.resetAuthMode(targetMode, Number(resetGeneration));
    }
    default:
      throw new TypeError('hosted_local_control_command_unknown');
  }
}

/**
 * Mode-0600 Unix-domain control transport. It never binds TCP and is not
 * registered with Fastify, so browser traffic cannot reach local operations.
 */
export class HostedAuthLocalControlServer {
  private transport: HostedAuthLocalControlTransport | null = null;

  constructor(private readonly dependencies: HostedAuthLocalControlServerDependencies) {
    if (
      !dependencies.platform.isAbsolute(dependencies.socketPath) ||
      dependencies.platform.byteLength(dependencies.socketPath) > 100
    ) {
      throw new TypeError('hosted_local_control_socket_path_invalid');
    }
  }

  async start(): Promise<void> {
    if (this.transport !== null) return;
    const transport = this.dependencies.transportFactory.create({
      socketPath: this.dependencies.socketPath,
      maximumRequestBytes: MAX_REQUEST_BYTES,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    });
    await transport.start(async (requestBody) => {
      try {
        const value = await executeHostedAuthLocalControlRequest(
          this.dependencies.administration,
          requestBody
        );
        return response(true, value);
      } catch (error) {
        return response(false, errorCode(error));
      }
    });
    this.transport = transport;
  }

  async close(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    await transport?.close();
  }
}
