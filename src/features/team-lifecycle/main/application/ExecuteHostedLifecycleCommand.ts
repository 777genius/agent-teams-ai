import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';

import { ExecuteHostedLifecycleCommand as CoreExecuteHostedLifecycleCommand } from '../../core/application/ExecuteHostedLifecycleCommand';

import type {
  HostedLifecycleCommand,
  HostedLifecycleCommandAction,
  HostedLifecycleCommandExecutionResult,
  HostedLifecycleIdempotencyKey,
} from '../../contracts/hosted-lifecycle-commands';
import type {
  HostedLifecycleAuthorizationGeneration,
  HostedLifecycleCommandAuthorization,
  HostedLifecycleCommandGatewayPort,
  HostedLifecycleGrantId,
  HostedLifecycleOwnerEffectFence,
} from '../../core/application/ports/HostedLifecycleCommandGatewayPort';
import type { QueryContext, Revision, RunId, TeamId, WorkspaceId } from '@shared/contracts/hosted';

const OWNER_AUTHORITY_PATTERN = /^owner-authority_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const OWNER_SESSION_PATTERN = /^owner-session_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const GRANT_ID_PATTERN = /^grant_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const AUTHORIZATION_GENERATION_PATTERN =
  /^authorization-generation_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const OWNER_PROOF_KEY_PATTERN = /^[0-9a-f]{64}$/;
const OWNER_PROOF_DOMAIN = 'agent-teams.hosted-lifecycle.owner-proof/v1';
const DURABLE_COMMAND_FINGERPRINT_DOMAIN = 'agent-teams.hosted-lifecycle-command/v1';

export const ORCHESTRATOR_LIFECYCLE_DURABLE_COMMAND_SCHEMA_VERSION = 1 as const;
export const ORCHESTRATOR_LIFECYCLE_COMMAND_FINGERPRINT_ALGORITHM = 'sha256' as const;
export const ORCHESTRATOR_LIFECYCLE_COMMAND_FINGERPRINT_VERSION = 1 as const;

export interface OrchestratorLifecycleCommandFingerprint {
  readonly algorithm: typeof ORCHESTRATOR_LIFECYCLE_COMMAND_FINGERPRINT_ALGORITHM;
  readonly version: typeof ORCHESTRATOR_LIFECYCLE_COMMAND_FINGERPRINT_VERSION;
  readonly digest: string;
}

export interface OrchestratorLifecycleCommandIdempotency {
  readonly deploymentId: QueryContext['deploymentId'];
  readonly actorId: QueryContext['actorId'];
  readonly action: HostedLifecycleCommandAction;
  readonly idempotencyKey: HostedLifecycleIdempotencyKey;
}

export interface OrchestratorLifecycleCommandResource {
  readonly bootId: QueryContext['bootId'];
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId;
  readonly runId: RunId | null;
  readonly expectedRevision: Revision;
  readonly restoreGeneration: number;
  readonly mountGeneration: number;
  readonly ownerEffectFence: HostedLifecycleOwnerEffectFence;
}

/**
 * Stable identity persisted by the external owner before it performs a lifecycle effect.
 * The web process can reconstruct this after a response loss or restart, but never settles it.
 */
export interface OrchestratorLifecycleDurableCommand {
  readonly schemaVersion: typeof ORCHESTRATOR_LIFECYCLE_DURABLE_COMMAND_SCHEMA_VERSION;
  readonly commandFingerprint: OrchestratorLifecycleCommandFingerprint;
  readonly idempotency: OrchestratorLifecycleCommandIdempotency;
  readonly resource: OrchestratorLifecycleCommandResource;
}

export type OrchestratorLifecycleOwnerProofKey = string & {
  readonly __brand: 'OrchestratorLifecycleOwnerProofKey';
};

export interface OrchestratorSocketIdentity {
  readonly device: string;
  readonly inode: string;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
}

export interface OrchestratorLifecycleOwnerBinding {
  readonly ownerAuthority: string;
  readonly ownerGeneration: number;
  readonly ownerSessionId: string;
  readonly socketIdentity: OrchestratorSocketIdentity;
}

export function isOrchestratorLifecycleRecord(
  value: unknown
): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasExactOrchestratorLifecycleKeys(
  value: Record<PropertyKey, unknown>,
  keys: readonly string[]
): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => typeof key === 'string' && keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export function parseOrchestratorSocketIdentity(value: unknown): OrchestratorSocketIdentity {
  if (
    !isOrchestratorLifecycleRecord(value) ||
    !hasExactOrchestratorLifecycleKeys(value, ['device', 'inode', 'uid', 'gid', 'mode']) ||
    typeof value.device !== 'string' ||
    !/^\d{1,32}$/.test(value.device) ||
    typeof value.inode !== 'string' ||
    !/^\d{1,32}$/.test(value.inode) ||
    !Number.isSafeInteger(value.uid) ||
    (value.uid as number) < 0 ||
    !Number.isSafeInteger(value.gid) ||
    (value.gid as number) < 0 ||
    !Number.isSafeInteger(value.mode) ||
    (value.mode as number) < 0 ||
    (value.mode as number) > 0o777
  ) {
    throw new TypeError('orchestrator-lifecycle-socket-identity-invalid');
  }
  return Object.freeze({
    device: value.device,
    inode: value.inode,
    uid: value.uid as number,
    gid: value.gid as number,
    mode: value.mode as number,
  });
}

export function parseOrchestratorLifecycleOwnerBinding(
  value: unknown
): OrchestratorLifecycleOwnerBinding {
  if (
    !isOrchestratorLifecycleRecord(value) ||
    !hasExactOrchestratorLifecycleKeys(value, [
      'ownerAuthority',
      'ownerGeneration',
      'ownerSessionId',
      'socketIdentity',
    ]) ||
    typeof value.ownerAuthority !== 'string' ||
    !OWNER_AUTHORITY_PATTERN.test(value.ownerAuthority) ||
    !Number.isSafeInteger(value.ownerGeneration) ||
    (value.ownerGeneration as number) < 1 ||
    typeof value.ownerSessionId !== 'string' ||
    !OWNER_SESSION_PATTERN.test(value.ownerSessionId)
  ) {
    throw new TypeError('orchestrator-lifecycle-owner-binding-invalid');
  }
  return Object.freeze({
    ownerAuthority: value.ownerAuthority,
    ownerGeneration: value.ownerGeneration as number,
    ownerSessionId: value.ownerSessionId,
    socketIdentity: parseOrchestratorSocketIdentity(value.socketIdentity),
  });
}

export function parseOrchestratorLifecycleOwnerProofKey(
  value: unknown
): OrchestratorLifecycleOwnerProofKey {
  if (typeof value !== 'string' || !OWNER_PROOF_KEY_PATTERN.test(value)) {
    throw new TypeError('orchestrator-lifecycle-owner-proof-key-invalid');
  }
  return value as OrchestratorLifecycleOwnerProofKey;
}

export function parseHostedLifecycleOwnerEffectFence(
  value: unknown
): HostedLifecycleOwnerEffectFence {
  if (
    !isOrchestratorLifecycleRecord(value) ||
    !hasExactOrchestratorLifecycleKeys(value, ['grantRevision', 'identityChecksum']) ||
    typeof value.grantRevision !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.grantRevision) ||
    typeof value.identityChecksum !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.identityChecksum)
  ) {
    throw new TypeError('orchestrator-lifecycle-owner-effect-fence-invalid');
  }
  return Object.freeze({
    grantRevision: value.grantRevision,
    identityChecksum: value.identityChecksum,
  });
}

export function sameHostedLifecycleOwnerEffectFence(
  left: HostedLifecycleOwnerEffectFence,
  right: HostedLifecycleOwnerEffectFence
): boolean {
  return (
    left.grantRevision === right.grantRevision && left.identityChecksum === right.identityChecksum
  );
}

export async function inspectOrchestratorLifecycleSocketIdentity(
  path: string
): Promise<OrchestratorSocketIdentity> {
  const stat = await lstat(path, { bigint: true });
  if (!stat.isSocket() || stat.isSymbolicLink()) {
    throw new Error('orchestrator-lifecycle-socket-identity-invalid');
  }
  return Object.freeze({
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
    mode: Number(stat.mode & 0o777n),
  });
}

export function createOrchestratorLifecycleOwnerProof(
  key: OrchestratorLifecycleOwnerProofKey,
  direction: 'request' | 'response',
  envelope: Readonly<Record<string, unknown>> | string
): string {
  const serializedEnvelope = typeof envelope === 'string' ? envelope : JSON.stringify(envelope);
  return createHmac('sha256', Buffer.from(key, 'hex'))
    .update(`${OWNER_PROOF_DOMAIN}\u0000${direction}\u0000${serializedEnvelope}`)
    .digest('hex');
}

export function createOrchestratorLifecycleReadinessProof(
  key: OrchestratorLifecycleOwnerProofKey,
  envelope: Readonly<Record<string, unknown>> | string
): string {
  const serializedEnvelope = typeof envelope === 'string' ? envelope : JSON.stringify(envelope);
  return createHmac('sha256', Buffer.from(key, 'hex'))
    .update(`${OWNER_PROOF_DOMAIN}\u0000readiness\u0000${serializedEnvelope}`)
    .digest('hex');
}

/** Serializes the only accepted signed command frame shape, with the proof as the final member. */
export function serializeOrchestratorLifecycleSignedFrame(
  key: OrchestratorLifecycleOwnerProofKey,
  direction: 'request' | 'response',
  unsignedEnvelope: Readonly<Record<string, unknown>>
): string {
  const serializedUnsignedEnvelope = JSON.stringify(unsignedEnvelope);
  if (
    serializedUnsignedEnvelope.length < 2 ||
    serializedUnsignedEnvelope[0] !== '{' ||
    serializedUnsignedEnvelope.at(-1) !== '}'
  ) {
    throw new TypeError('orchestrator-lifecycle-json-frame-invalid');
  }
  const ownerProof = createOrchestratorLifecycleOwnerProof(
    key,
    direction,
    serializedUnsignedEnvelope
  );
  return `${serializedUnsignedEnvelope.slice(0, -1)},"ownerProof":"${ownerProof}"}\n`;
}

export function orchestratorLifecycleOwnerProofMatches(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string' || !/^[0-9a-f]{64}$/.test(actual)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}

function lifecycleCommandFingerprintPreimage(
  command: HostedLifecycleCommand,
  ownerEffectFence: HostedLifecycleOwnerEffectFence
): readonly unknown[] {
  return Object.freeze([
    DURABLE_COMMAND_FINGERPRINT_DOMAIN,
    command.schemaVersion,
    command.action,
    command.commandId,
    command.idempotencyKey,
    command.workspaceId,
    command.teamId,
    command.expectedRevision,
    command.action === 'launch' ? null : command.runId,
    ownerEffectFence.grantRevision,
    ownerEffectFence.identityChecksum,
  ]);
}

export function createOrchestratorLifecycleDurableCommand(
  command: HostedLifecycleCommand,
  context: QueryContext,
  restoreGeneration: number,
  mountGeneration: number,
  ownerEffectFence: HostedLifecycleOwnerEffectFence
): OrchestratorLifecycleDurableCommand {
  const parsedRestoreGeneration = parseOrchestratorRestoreGeneration(restoreGeneration);
  const parsedMountGeneration = parseOrchestratorMountGeneration(mountGeneration);
  const parsedOwnerEffectFence = parseHostedLifecycleOwnerEffectFence(ownerEffectFence);
  const commandFingerprint = Object.freeze({
    algorithm: ORCHESTRATOR_LIFECYCLE_COMMAND_FINGERPRINT_ALGORITHM,
    version: ORCHESTRATOR_LIFECYCLE_COMMAND_FINGERPRINT_VERSION,
    digest: createHash('sha256')
      .update(
        JSON.stringify(lifecycleCommandFingerprintPreimage(command, parsedOwnerEffectFence)),
        'utf8'
      )
      .digest('hex'),
  });
  return Object.freeze({
    schemaVersion: ORCHESTRATOR_LIFECYCLE_DURABLE_COMMAND_SCHEMA_VERSION,
    commandFingerprint,
    idempotency: Object.freeze({
      deploymentId: context.deploymentId,
      actorId: context.actorId,
      action: command.action,
      idempotencyKey: command.idempotencyKey,
    }),
    resource: Object.freeze({
      bootId: context.bootId,
      workspaceId: command.workspaceId,
      teamId: command.teamId,
      runId: command.action === 'launch' ? null : command.runId,
      expectedRevision: command.expectedRevision,
      restoreGeneration: parsedRestoreGeneration,
      mountGeneration: parsedMountGeneration,
      ownerEffectFence: parsedOwnerEffectFence,
    }),
  });
}

/** Rejects any signed response that describes a different durable ledger entry. */
export function requireOrchestratorLifecycleDurableCommandEcho(
  value: unknown,
  expected: OrchestratorLifecycleDurableCommand
): OrchestratorLifecycleDurableCommand {
  if (
    !isOrchestratorLifecycleRecord(value) ||
    !hasExactOrchestratorLifecycleKeys(value, [
      'schemaVersion',
      'commandFingerprint',
      'idempotency',
      'resource',
    ]) ||
    value.schemaVersion !== ORCHESTRATOR_LIFECYCLE_DURABLE_COMMAND_SCHEMA_VERSION ||
    !isOrchestratorLifecycleRecord(value.commandFingerprint) ||
    !hasExactOrchestratorLifecycleKeys(value.commandFingerprint, [
      'algorithm',
      'version',
      'digest',
    ]) ||
    value.commandFingerprint.algorithm !== expected.commandFingerprint.algorithm ||
    value.commandFingerprint.version !== expected.commandFingerprint.version ||
    value.commandFingerprint.digest !== expected.commandFingerprint.digest ||
    !isOrchestratorLifecycleRecord(value.idempotency) ||
    !hasExactOrchestratorLifecycleKeys(value.idempotency, [
      'deploymentId',
      'actorId',
      'action',
      'idempotencyKey',
    ]) ||
    value.idempotency.deploymentId !== expected.idempotency.deploymentId ||
    value.idempotency.actorId !== expected.idempotency.actorId ||
    value.idempotency.action !== expected.idempotency.action ||
    value.idempotency.idempotencyKey !== expected.idempotency.idempotencyKey ||
    !isOrchestratorLifecycleRecord(value.resource) ||
    !hasExactOrchestratorLifecycleKeys(value.resource, [
      'bootId',
      'workspaceId',
      'teamId',
      'runId',
      'expectedRevision',
      'restoreGeneration',
      'mountGeneration',
      'ownerEffectFence',
    ]) ||
    value.resource.bootId !== expected.resource.bootId ||
    value.resource.workspaceId !== expected.resource.workspaceId ||
    value.resource.teamId !== expected.resource.teamId ||
    value.resource.runId !== expected.resource.runId ||
    value.resource.expectedRevision !== expected.resource.expectedRevision ||
    value.resource.restoreGeneration !== expected.resource.restoreGeneration ||
    value.resource.mountGeneration !== expected.resource.mountGeneration ||
    !sameHostedLifecycleOwnerEffectFence(
      parseHostedLifecycleOwnerEffectFence(value.resource.ownerEffectFence),
      expected.resource.ownerEffectFence
    )
  ) {
    throw new TypeError('orchestrator-lifecycle-durable-command-invalid');
  }
  return expected;
}

export function orchestratorLifecycleAuthorizationKey(
  authorization: HostedLifecycleCommandAuthorization
): string {
  return `${authorization.grantId}\u0000${authorization.authorizationGeneration}`;
}

export function sameOrchestratorLifecycleOwnerBinding(
  left: OrchestratorLifecycleOwnerBinding,
  right: OrchestratorLifecycleOwnerBinding
): boolean {
  return (
    left.ownerAuthority === right.ownerAuthority &&
    left.ownerGeneration === right.ownerGeneration &&
    left.ownerSessionId === right.ownerSessionId &&
    sameOrchestratorSocketIdentity(left.socketIdentity, right.socketIdentity)
  );
}

export function sameOrchestratorSocketIdentity(
  left: OrchestratorSocketIdentity,
  right: OrchestratorSocketIdentity
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode
  );
}

export function serializeOrchestratorLifecycleContext(context: QueryContext) {
  return Object.freeze({
    actorId: context.actorId,
    sessionId: context.sessionId,
    deploymentId: context.deploymentId,
    bootId: context.bootId,
    requestId: context.requestId,
    authorizedScope: context.authorizedScope,
    deadlineAtMs: context.deadlineAtMs,
  });
}

export function serializeOrchestratorLifecycleAuthority(
  context: QueryContext,
  workspaceId: WorkspaceId,
  teamId: TeamId,
  restoreGeneration: number,
  mountGeneration: number,
  resourceRevision: Revision | null,
  ownerEffectFence: HostedLifecycleOwnerEffectFence
) {
  return Object.freeze({
    actorId: context.actorId,
    workspaceId,
    teamId,
    deploymentId: context.deploymentId,
    restoreGeneration,
    mountGeneration,
    bootId: context.bootId,
    resourceRevision,
    ownerEffectFence: parseHostedLifecycleOwnerEffectFence(ownerEffectFence),
  });
}

export function requireOrchestratorLifecycleAuthorityRevision(
  authority: Readonly<{ resourceRevision: Revision | null }>,
  revision: Revision | null
): void {
  if (authority.resourceRevision !== revision) {
    throw new TypeError('orchestrator-lifecycle-response-authority-revision-invalid');
  }
}

export function validateOrchestratorLifecycleSocketPath(socketPath: string): string {
  if (
    typeof socketPath !== 'string' ||
    socketPath.length < 1 ||
    socketPath.includes('\0') ||
    !isAbsolute(socketPath) ||
    normalize(socketPath) !== socketPath ||
    Buffer.byteLength(socketPath) > 103
  ) {
    throw new TypeError('orchestrator-lifecycle-socket-path-invalid');
  }
  return socketPath;
}

export function parseHostedLifecycleGrantId(value: unknown): HostedLifecycleGrantId {
  if (typeof value !== 'string' || !GRANT_ID_PATTERN.test(value)) {
    throw new TypeError('orchestrator-lifecycle-grant-id-invalid');
  }
  return value as HostedLifecycleGrantId;
}

export function parseHostedLifecycleAuthorizationGeneration(
  value: unknown
): HostedLifecycleAuthorizationGeneration {
  if (typeof value !== 'string' || !AUTHORIZATION_GENERATION_PATTERN.test(value)) {
    throw new TypeError('orchestrator-lifecycle-authorization-generation-invalid');
  }
  return value as HostedLifecycleAuthorizationGeneration;
}

export function sameHostedLifecycleAuthorization(
  left: HostedLifecycleCommandAuthorization,
  right: HostedLifecycleCommandAuthorization
): boolean {
  return (
    left.grantId === right.grantId &&
    left.authorizationGeneration === right.authorizationGeneration &&
    left.deploymentId === right.deploymentId &&
    left.bootId === right.bootId &&
    left.resourceRevision === right.resourceRevision &&
    left.actorId === right.actorId &&
    left.workspaceId === right.workspaceId &&
    left.teamId === right.teamId &&
    left.restoreGeneration === right.restoreGeneration &&
    left.mountGeneration === right.mountGeneration &&
    sameHostedLifecycleOwnerEffectFence(left.ownerEffectFence, right.ownerEffectFence)
  );
}

export function parseOrchestratorRetryAfterMs(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 60_000) {
    throw new TypeError('orchestrator-lifecycle-retry-after-invalid');
  }
  return value as number;
}

export function parseOrchestratorRestoreGeneration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('orchestrator-lifecycle-restore-generation-invalid');
  }
  return value;
}

export function parseOrchestratorMountGeneration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('orchestrator-lifecycle-mount-generation-invalid');
  }
  return value;
}

/** Parses exactly one newline-delimited JSON value and rejects duplicate object keys. */
export function parseStrictOrchestratorJsonFrame(frame: string): unknown {
  const newline = frame.indexOf('\n');
  if (newline < 1 || newline !== frame.length - 1) {
    throw new TypeError('orchestrator-lifecycle-json-frame-invalid');
  }
  const body = frame.slice(0, newline);
  assertNoDuplicateJsonObjectKeys(body);
  return JSON.parse(body) as unknown;
}

export interface StrictOrchestratorSignedJsonFrame {
  readonly value: Record<PropertyKey, unknown>;
  /** Exact UTF-8 text authenticated by the proof, before the final ownerProof member was appended. */
  readonly serializedUnsignedEnvelope: string;
  readonly ownerProof: string;
}

/**
 * Parses the fixed signed-frame encoding without normalizing the authenticated bytes. Whitespace,
 * key-order, escape, number-spelling, or duplicate-key changes therefore cannot retain a proof that
 * was issued for different wire bytes.
 */
export function parseStrictOrchestratorSignedJsonFrame(
  frame: string
): StrictOrchestratorSignedJsonFrame {
  const value = parseStrictOrchestratorJsonFrame(frame);
  if (!isOrchestratorLifecycleRecord(value)) {
    throw new TypeError('orchestrator-lifecycle-signed-json-frame-invalid');
  }
  const ownerProof = value.ownerProof;
  if (typeof ownerProof !== 'string' || !/^[0-9a-f]{64}$/.test(ownerProof)) {
    throw new TypeError('orchestrator-lifecycle-signed-json-frame-invalid');
  }
  const body = frame.slice(0, -1);
  const proofSuffix = `,"ownerProof":"${ownerProof}"}`;
  if (!body.endsWith(proofSuffix)) {
    throw new TypeError('orchestrator-lifecycle-signed-json-frame-invalid');
  }
  const serializedUnsignedEnvelope = `${body.slice(0, -proofSuffix.length)}}`;
  const unsigned = parseStrictOrchestratorJsonFrame(`${serializedUnsignedEnvelope}\n`);
  if (
    !isOrchestratorLifecycleRecord(unsigned) ||
    Object.hasOwn(unsigned, 'ownerProof') ||
    Reflect.ownKeys(unsigned).length + 1 !== Reflect.ownKeys(value).length
  ) {
    throw new TypeError('orchestrator-lifecycle-signed-json-frame-invalid');
  }
  return Object.freeze({ value, serializedUnsignedEnvelope, ownerProof });
}

function assertNoDuplicateJsonObjectKeys(source: string): void {
  let cursor = 0;
  const fail = (): never => {
    throw new TypeError('orchestrator-lifecycle-json-frame-invalid');
  };
  const whitespace = (): void => {
    while (/\s/.test(source[cursor] ?? '')) cursor += 1;
  };
  const stringToken = (): string => {
    if (source[cursor] !== '"') fail();
    const start = cursor++;
    while (cursor < source.length) {
      const character = source[cursor++];
      if (character === '"') return JSON.parse(source.slice(start, cursor)) as string;
      if (character === '\\') {
        if (cursor >= source.length) fail();
        cursor += 1;
      } else if ((character?.charCodeAt(0) ?? 0) < 0x20) {
        fail();
      }
    }
    return fail();
  };
  const value = (): void => {
    whitespace();
    if (source[cursor] === '{') {
      cursor += 1;
      whitespace();
      const keys = new Set<string>();
      if (source[cursor] === '}') {
        cursor += 1;
        return;
      }
      for (;;) {
        whitespace();
        const key = stringToken();
        if (keys.has(key)) fail();
        keys.add(key);
        whitespace();
        if (source[cursor++] !== ':') fail();
        value();
        whitespace();
        const delimiter = source[cursor++];
        if (delimiter === '}') return;
        if (delimiter !== ',') fail();
      }
    }
    if (source[cursor] === '[') {
      cursor += 1;
      whitespace();
      if (source[cursor] === ']') {
        cursor += 1;
        return;
      }
      for (;;) {
        value();
        whitespace();
        const delimiter = source[cursor++];
        if (delimiter === ']') return;
        if (delimiter !== ',') fail();
      }
    }
    if (source[cursor] === '"') {
      stringToken();
      return;
    }
    const start = cursor;
    while (cursor < source.length && !/[\s,}\]]/.test(source[cursor])) cursor += 1;
    if (cursor === start) fail();
  };
  value();
  whitespace();
  if (cursor !== source.length) fail();
}

interface ReleasableHostedLifecycleCommandGateway extends HostedLifecycleCommandGatewayPort {
  release?(
    command: HostedLifecycleCommand,
    authorization: HostedLifecycleCommandAuthorization,
    context: QueryContext
  ): Promise<
    Readonly<{
      kind: 'released' | 'already_released' | 'operator_required';
      authorization: HostedLifecycleCommandAuthorization;
    }>
  >;
}

/** Owns the bounded lifetime of one externally issued authorization; it owns no runtime effect. */
export class ExecuteHostedLifecycleCommand {
  constructor(
    private readonly gateway: ReleasableHostedLifecycleCommandGateway,
    private readonly now: () => number = Date.now
  ) {}

  async execute(
    action: HostedLifecycleCommandAction,
    body: unknown,
    context: QueryContext
  ): Promise<HostedLifecycleCommandExecutionResult> {
    let issued:
      | Readonly<{
          command: HostedLifecycleCommand;
          authorization: HostedLifecycleCommandAuthorization;
        }>
      | undefined;
    const scopedGateway: HostedLifecycleCommandGatewayPort = {
      getControlState: this.gateway.getControlState.bind(this.gateway),
      authorize: async (command, queryContext) => {
        const result = await this.gateway.authorize(command, queryContext);
        if (result.kind === 'authorized') {
          issued = Object.freeze({ command, authorization: result.authorization });
        }
        return result;
      },
      revalidate: this.gateway.revalidate.bind(this.gateway),
      execute: async (command, authorization, queryContext) => {
        const result = await this.gateway.execute(command, authorization, queryContext);
        if (result.kind === 'result') {
          issued = Object.freeze({ command, authorization: result.authorization });
        }
        return result;
      },
    };
    let executionResult: HostedLifecycleCommandExecutionResult | undefined;
    let executionError: unknown;
    let executionFailed = false;
    try {
      executionResult = await new CoreExecuteHostedLifecycleCommand(
        scopedGateway,
        this.now
      ).execute(action, body, context);
    } catch (error) {
      executionFailed = true;
      executionError = error;
    }
    if (issued !== undefined && this.gateway.release !== undefined) {
      const operatorRequired = (): HostedLifecycleCommandExecutionResult =>
        Object.freeze({
          schemaVersion: issued!.command.schemaVersion,
          kind: 'operator_required' as const,
          action: issued!.command.action,
          commandId: issued!.command.commandId,
          workspaceId: issued!.command.workspaceId,
          teamId: issued!.command.teamId,
        });
      try {
        const release = await this.gateway.release(issued.command, issued.authorization, context);
        if (
          release.kind === 'operator_required' ||
          !sameHostedLifecycleAuthorization(release.authorization, issued.authorization)
        ) {
          return operatorRequired();
        }
      } catch {
        return operatorRequired();
      }
    }
    if (executionFailed) throw executionError;
    return executionResult!;
  }
}
