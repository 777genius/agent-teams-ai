import { FORCED_CLAUDE_DIR_ENV } from '../controller';

/**
 * Hosted member tool calls need invocation provenance supplied by the MCP
 * transport, not names or session IDs supplied as tool arguments. The current
 * server does not have an authenticated OpenCode invocation source, so Hosted
 * calls fail closed until the owner wires this contract to one.
 */
export interface HostedMemberInvocation {
  teamName: string;
  memberName: string;
  runId: string;
  runtimeSessionId: string;
  ownerIncarnationId: string;
  ownerAuthorityId: string;
}

export interface HostedMemberAdmission extends HostedMemberInvocation {
  allowedTaskRefs: readonly string[];
  allowedMessageRecipients: readonly string[];
  allowedInboundMessageIds: readonly string[];
}

export interface HostedOwnerAuthority {
  ownerIncarnationId: string;
  ownerAuthorityId: string;
}

/**
 * ADR-30 personal-host profile. Only the Owner's signed personal-host admission
 * puts this into the MCP launch environment; together with the forced Claude
 * root it selects desktop tool semantics on that root, even though the Owner's
 * Hosted runtime env is inherited through OpenCode into this process.
 */
export const AGENT_TEAMS_MCP_TRUST_MODE_ENV = 'AGENT_TEAMS_MCP_TRUST_MODE';
export const PERSONAL_HOST_TRUSTED_PROCESS_TRUST_MODE = 'personal-host-trusted-process';

export interface HostedAgentToolAdmissionOptions {
  /** Explicit Hosted selection is useful for tests. Production uses Hosted env. */
  hosted?: boolean;
  /** Must derive from server-authenticated invocation context, never tool args. */
  resolveInvocation?: (context: unknown) => Promise<HostedMemberInvocation | null>;
  /** Must read the current admitted run/session and its task/message scope. */
  readMemberAdmission?: (invocation: HostedMemberInvocation) => Promise<HostedMemberAdmission | null>;
  /** Must read the current Owner lease/incarnation at the point of use. */
  readOwnerAuthority?: (teamName: string) => Promise<HostedOwnerAuthority | null>;
  /** Owner-side executor must recheck the supplied expected authority before any effect. */
  ownerDispatcher?: HostedOwnerToolDispatcher;
}

export type HostedOwnerToolCommand =
  | { readonly tool: 'task_get'; readonly teamName: string; readonly taskId: string }
  | { readonly tool: 'task_start' | 'task_complete'; readonly teamName: string; readonly taskId: string; readonly actor: string }
  | { readonly tool: 'task_add_comment'; readonly teamName: string; readonly taskId: string; readonly from: string; readonly text: string; readonly taskRefs?: readonly { taskId: string; teamName: string }[] }
  | {
      readonly tool: 'message_send'; readonly teamName: string; readonly from: string;
      readonly to: string; readonly text: string; readonly summary?: string;
      readonly source?: string; readonly relayOfMessageId?: string;
      readonly leadSessionId?: string; readonly hasAttachments?: boolean;
      readonly taskRefs?: readonly { taskId: string; teamName: string }[];
    };

export interface HostedOwnerToolDispatchRequest {
  readonly command: HostedOwnerToolCommand;
  readonly invocation: Readonly<HostedMemberInvocation>;
  readonly expectedOwnerAuthority: Readonly<HostedOwnerAuthority>;
}

export interface HostedOwnerToolDispatcher {
  dispatch(request: HostedOwnerToolDispatchRequest): Promise<unknown>;
}

export type HostedAgentToolOperation =
  | { kind: 'task'; teamName: string; taskRef: string; actor?: string; relatedTaskRefs?: readonly { taskId: string; teamName: string }[] }
  | {
      kind: 'message';
      teamName: string;
      from: string;
      to: string;
      taskRefs?: readonly { taskId: string; teamName: string }[];
      relayOfMessageId?: string;
      source?: string;
      leadSessionId?: string;
      hasAttachments?: boolean;
    };

const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const sameIdentity = (left: string, right: string): boolean => left === right;

export function isPersonalHostTrustedProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env[AGENT_TEAMS_MCP_TRUST_MODE_ENV] === PERSONAL_HOST_TRUSTED_PROCESS_TRUST_MODE &&
    nonempty(env[FORCED_CLAUDE_DIR_ENV])
  );
}

export function isHostedAgentToolMode(options: HostedAgentToolAdmissionOptions = {}): boolean {
  if (options.hosted === true) return true;
  if (isPersonalHostTrustedProcess()) return false;
  return Boolean(process.env.HOSTED_OPENCODE_RUNTIME_MODE || process.env.AUTH_MODE);
}

function fail(): never {
  throw new Error('Hosted agent tool call denied: authenticated member admission unavailable or stale');
}

async function admitHostedAgentToolOperation(
  operation: HostedAgentToolOperation,
  context: unknown,
  options: HostedAgentToolAdmissionOptions
): Promise<Readonly<{ invocation: HostedMemberInvocation; owner: HostedOwnerAuthority }>> {

  if (!options.resolveInvocation || !options.readMemberAdmission || !options.readOwnerAuthority) {
    fail();
  }

  const invocation = await options.resolveInvocation(context);
  if (
    !invocation ||
    ![invocation.teamName, invocation.memberName, invocation.runId, invocation.runtimeSessionId,
      invocation.ownerIncarnationId, invocation.ownerAuthorityId].every(nonempty) ||
    !sameIdentity(invocation.teamName, operation.teamName)
  ) fail();

  const [admission, owner] = await Promise.all([
    options.readMemberAdmission(invocation),
    options.readOwnerAuthority(operation.teamName),
  ]);
  if (!admission || !owner ||
    ![owner.ownerIncarnationId, owner.ownerAuthorityId].every(nonempty) ||
    !sameIdentity(invocation.ownerIncarnationId, owner.ownerIncarnationId) ||
    !sameIdentity(invocation.ownerAuthorityId, owner.ownerAuthorityId) ||
    !sameIdentity(admission.teamName, invocation.teamName) ||
    !sameIdentity(admission.memberName, invocation.memberName) ||
    !sameIdentity(admission.runId, invocation.runId) ||
    !sameIdentity(admission.runtimeSessionId, invocation.runtimeSessionId) ||
    !sameIdentity(admission.ownerIncarnationId, owner.ownerIncarnationId) ||
    !sameIdentity(admission.ownerAuthorityId, owner.ownerAuthorityId) ||
    !Array.isArray(admission.allowedTaskRefs) ||
    !Array.isArray(admission.allowedMessageRecipients) ||
    !Array.isArray(admission.allowedInboundMessageIds)) fail();

  if (operation.kind === 'task') {
    if (!nonempty(operation.taskRef) || !admission.allowedTaskRefs.includes(operation.taskRef)) fail();
    if (operation.actor !== undefined && !sameIdentity(operation.actor, invocation.memberName)) fail();
    if (operation.relatedTaskRefs?.some((ref) =>
      ref.teamName !== invocation.teamName || !admission.allowedTaskRefs.includes(ref.taskId))) fail();
    return { invocation, owner };
  }

  if (!sameIdentity(operation.from, invocation.memberName) ||
    !admission.allowedMessageRecipients.includes(operation.to) ||
    (operation.source !== undefined && operation.source !== 'runtime_delivery') ||
    (operation.source === 'runtime_delivery' && !operation.relayOfMessageId) ||
    operation.leadSessionId !== undefined ||
    operation.hasAttachments === true ||
    operation.taskRefs?.some((ref) =>
      ref.teamName !== invocation.teamName || !admission.allowedTaskRefs.includes(ref.taskId)) ||
    (operation.relayOfMessageId !== undefined &&
      !admission.allowedInboundMessageIds.includes(operation.relayOfMessageId))) fail();
  return { invocation, owner };
}

export async function assertHostedAgentToolAdmission(
  operation: HostedAgentToolOperation,
  context: unknown,
  options: HostedAgentToolAdmissionOptions = {}
): Promise<void> {
  if (!isHostedAgentToolMode(options)) return;
  await admitHostedAgentToolOperation(operation, context, options);
}

/** Hosted commands never enter a local controller; production has no Owner executor yet. */
export async function dispatchHostedOwnerTool(
  command: HostedOwnerToolCommand,
  context: unknown,
  options: HostedAgentToolAdmissionOptions
): Promise<unknown> {
  if (!isHostedAgentToolMode(options)) fail();
  const operation: HostedAgentToolOperation = command.tool === 'message_send'
    ? {
        kind: 'message', teamName: command.teamName, from: command.from, to: command.to,
        taskRefs: command.taskRefs, relayOfMessageId: command.relayOfMessageId,
        source: command.source, leadSessionId: command.leadSessionId,
        hasAttachments: command.hasAttachments,
      }
    : {
        kind: 'task', teamName: command.teamName, taskRef: command.taskId,
        ...(command.tool === 'task_get' ? {} : {
          actor: command.tool === 'task_add_comment' ? command.from : command.actor,
        }),
        ...(command.tool === 'task_add_comment' ? { relatedTaskRefs: command.taskRefs } : {}),
      };
  const admitted = await admitHostedAgentToolOperation(operation, context, options);
  if (!options.ownerDispatcher) {
    throw new Error('Hosted agent tool call denied: Owner executor unavailable');
  }
  return options.ownerDispatcher.dispatch({
    command,
    invocation: Object.freeze({ ...admitted.invocation }),
    expectedOwnerAuthority: Object.freeze({ ...admitted.owner }),
  });
}
