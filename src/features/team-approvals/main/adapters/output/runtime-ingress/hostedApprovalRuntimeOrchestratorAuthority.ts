import { randomBytes } from 'node:crypto';
import { connect as connectSocket, type Socket } from 'node:net';

import {
  inspectOrchestratorLifecycleSocketIdentity,
  type OrchestratorLifecycleOwnerBinding,
  type OrchestratorLifecycleOwnerProofKey,
  type OrchestratorSocketIdentity,
  parseOrchestratorLifecycleOwnerBinding,
  parseStrictOrchestratorSignedJsonFrame,
  sameOrchestratorLifecycleOwnerBinding,
  sameOrchestratorSocketIdentity,
} from '@features/team-lifecycle/main/hosted';
import { isExactRuntimePermissionApprovalIngressAuthority } from '@features/team-runtime-control/contracts';

import {
  createHostedApprovalRuntimeOwnerProof,
  HOSTED_APPROVAL_RUNTIME_WIRE_SCHEMA_VERSION,
  type HostedApprovalDecisionDeliveryRequest,
  type HostedApprovalRuntimeOperation,
  hostedApprovalRuntimeOwnerProofMatches,
  type HostedApprovalRuntimeRequestPayloadByOperation,
  type HostedApprovalRuntimeResponsePayloadByOperation,
  type HostedApprovalRuntimeWireAuthority,
  parseHostedApprovalRuntimeExchangeId,
  parseHostedApprovalRuntimeRequestPayload,
  parseHostedApprovalRuntimeResponsePayload,
  parseHostedApprovalRuntimeWireAuthority,
  sameHostedApprovalRuntimeWireAuthority,
} from './hostedApprovalRuntimeOrchestratorWire';

import type {
  HostedApprovalDecisionExternalLifecycleDeliveryPort,
  HostedApprovalDecisionReconciliationPort,
  HostedRuntimePermissionIngressAuthorityPort,
  HostedRuntimePermissionIngressEffectPort,
} from '../../../ports/HostedTeamApprovalRuntimeBridgePorts';
import type { RuntimePermissionApprovalIngressAuthority } from '@features/team-runtime-control/contracts';
import type { RunId, TeamId } from '@shared/contracts/hosted';

const DEFAULT_TIMEOUT_MS = 5_000;
export const HOSTED_APPROVAL_RUNTIME_MAXIMUM_FRAME_BYTES = 8 * 1024 * 1024;

export interface HostedApprovalRuntimeOwnerLeasePort {
  readonly socketPath: string;
  currentBinding(): OrchestratorLifecycleOwnerBinding | null;
  invalidate(): void;
}

export interface HostedApprovalRuntimeOrchestratorAuthorityOptions {
  readonly lease: HostedApprovalRuntimeOwnerLeasePort;
  readonly ownerProofKey: OrchestratorLifecycleOwnerProofKey;
  readonly authority: HostedApprovalRuntimeWireAuthority;
  readonly timeoutMs?: number;
  readonly generateExchangeId?: () => string;
  readonly connect?: (path: string) => Socket;
  readonly inspectSocketIdentity?: (path: string) => Promise<OrchestratorSocketIdentity>;
  /** Trusted lifecycle admission lookup; null or any field mismatch fails closed. */
  readonly getAdmittedIngressAuthority: (
    authority: RuntimePermissionApprovalIngressAuthority
  ) => Promise<RuntimePermissionApprovalIngressAuthority | null>;
}

function hasExactKeys(value: Record<PropertyKey, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => typeof key === 'string' && keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

/**
 * Approval-only transport over the already admitted lifecycle-owner socket. It owns no runtime,
 * provider, browser, storage, or authority policy and invalidates the shared lease on a proof,
 * binding, or socket-identity mismatch.
 */
export class HostedApprovalRuntimeOrchestratorAuthority
  implements
    HostedRuntimePermissionIngressEffectPort,
    HostedRuntimePermissionIngressAuthorityPort,
    HostedApprovalDecisionExternalLifecycleDeliveryPort,
    HostedApprovalDecisionReconciliationPort
{
  private readonly timeoutMs: number;
  private readonly generateExchangeId: () => string;
  private readonly connect: (path: string) => Socket;
  private readonly inspectSocketIdentity: (path: string) => Promise<OrchestratorSocketIdentity>;
  private readonly authority: HostedApprovalRuntimeWireAuthority;
  private readonly activeSockets = new Set<Socket>();
  private epoch = 0;
  private closed = false;

  constructor(private readonly options: HostedApprovalRuntimeOrchestratorAuthorityOptions) {
    this.authority = parseHostedApprovalRuntimeWireAuthority(options.authority);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) {
      throw new TypeError('hosted-approval-runtime-timeout-invalid');
    }
    this.generateExchangeId =
      options.generateExchangeId ?? (() => `approval-request_${randomBytes(16).toString('hex')}`);
    this.connect = options.connect ?? connectSocket;
    this.inspectSocketIdentity =
      options.inspectSocketIdentity ?? inspectOrchestratorLifecycleSocketIdentity;
  }

  claimPermissionApprovalIngressEffects(
    request: Parameters<
      HostedRuntimePermissionIngressEffectPort['claimPermissionApprovalIngressEffects']
    >[0]
  ): ReturnType<HostedRuntimePermissionIngressEffectPort['claimPermissionApprovalIngressEffects']> {
    return this.exchange('approval_ingress_claim', request);
  }

  acknowledgePermissionApprovalIngressEffect(
    request: Parameters<
      HostedRuntimePermissionIngressEffectPort['acknowledgePermissionApprovalIngressEffect']
    >[0]
  ): ReturnType<
    HostedRuntimePermissionIngressEffectPort['acknowledgePermissionApprovalIngressEffect']
  > {
    return this.exchange('approval_ingress_ack', request);
  }

  resolvePersistedIngressAuthority(
    authority: RuntimePermissionApprovalIngressAuthority
  ): ReturnType<HostedRuntimePermissionIngressAuthorityPort['resolvePersistedIngressAuthority']> {
    return this.exchangeWithPrivateAuthority('approval_ingress_authority_resolve', authority);
  }

  deliverRuntimePermissionDecision(
    request: HostedApprovalDecisionDeliveryRequest
  ): ReturnType<
    HostedApprovalDecisionExternalLifecycleDeliveryPort['deliverRuntimePermissionDecision']
  > {
    return this.exchange('approval_decision_deliver', request);
  }

  reconcileRuntimePermissionDecision(request: {
    readonly reconciliationRef: string;
    readonly providerDeliveryId: string;
    readonly partition: Readonly<{ readonly teamId: TeamId; readonly runId: RunId }>;
  }): Promise<HostedApprovalRuntimeResponsePayloadByOperation['approval_decision_reconcile']> {
    return this.exchange('approval_decision_reconcile', request);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.revokeSockets(false);
  }

  private async exchange<Operation extends HostedApprovalRuntimeOperation>(
    operation: Operation,
    unparsedPayload: HostedApprovalRuntimeRequestPayloadByOperation[Operation]
  ): Promise<HostedApprovalRuntimeResponsePayloadByOperation[Operation]> {
    const epoch = this.epoch;
    this.assertActive(epoch);
    const ownerBinding = this.options.lease.currentBinding();
    if (ownerBinding === null) throw new Error('hosted-approval-runtime-owner-unavailable');
    const payload = parseHostedApprovalRuntimeRequestPayload(operation, unparsedPayload);
    const exchangeId = parseHostedApprovalRuntimeExchangeId(this.generateExchangeId());
    await this.assertSocketIdentity(ownerBinding);
    this.assertCurrentOwner(epoch, ownerBinding);
    const unsignedRequest = Object.freeze({
      schemaVersion: HOSTED_APPROVAL_RUNTIME_WIRE_SCHEMA_VERSION,
      exchangeId,
      operation,
      ownerBinding,
      authority: this.authority,
      payload,
    });
    const serializedUnsignedEnvelope = JSON.stringify(unsignedRequest);
    const body = Buffer.from(
      `${serializedUnsignedEnvelope.slice(0, -1)},"ownerProof":"${createHostedApprovalRuntimeOwnerProof(
        this.options.ownerProofKey,
        'request',
        serializedUnsignedEnvelope
      )}"}\n`,
      'utf8'
    );
    if (body.byteLength > HOSTED_APPROVAL_RUNTIME_MAXIMUM_FRAME_BYTES) {
      throw new Error('hosted-approval-runtime-request-too-large');
    }
    const responseFrame = await this.request(body, epoch, ownerBinding);
    let signed: ReturnType<typeof parseStrictOrchestratorSignedJsonFrame>;
    try {
      signed = parseStrictOrchestratorSignedJsonFrame(responseFrame);
    } catch (error) {
      this.ownerMismatch();
      throw error;
    }
    const response = signed.value;
    if (
      !hasExactKeys(response, [
        'schemaVersion',
        'exchangeId',
        'operation',
        'ownerBinding',
        'authority',
        'payload',
        'ownerProof',
      ]) ||
      response.schemaVersion !== HOSTED_APPROVAL_RUNTIME_WIRE_SCHEMA_VERSION ||
      response.exchangeId !== exchangeId ||
      response.operation !== operation
    ) {
      this.ownerMismatch();
      throw new Error('hosted-approval-runtime-response-invalid');
    }
    let responseBinding: OrchestratorLifecycleOwnerBinding;
    let responseAuthority: HostedApprovalRuntimeWireAuthority;
    try {
      responseBinding = parseOrchestratorLifecycleOwnerBinding(response.ownerBinding);
      responseAuthority = parseHostedApprovalRuntimeWireAuthority(response.authority);
    } catch (error) {
      this.ownerMismatch();
      throw error;
    }
    if (
      !sameOrchestratorLifecycleOwnerBinding(ownerBinding, responseBinding) ||
      !sameHostedApprovalRuntimeWireAuthority(this.authority, responseAuthority) ||
      !hostedApprovalRuntimeOwnerProofMatches(
        createHostedApprovalRuntimeOwnerProof(
          this.options.ownerProofKey,
          'response',
          signed.serializedUnsignedEnvelope
        ),
        signed.ownerProof
      )
    ) {
      this.ownerMismatch();
      throw new Error('hosted-approval-runtime-response-proof-invalid');
    }
    const result = parseHostedApprovalRuntimeResponsePayload(
      operation,
      response.payload,
      payload,
      this.authority
    );
    if (operation === 'approval_ingress_claim') {
      for (const record of result as readonly {
        authority: RuntimePermissionApprovalIngressAuthority;
      }[]) {
        await this.assertPrivateAuthority(record.authority);
      }
    }
    await this.assertSocketIdentity(ownerBinding);
    this.assertCurrentOwner(epoch, ownerBinding);
    return result;
  }

  private async exchangeWithPrivateAuthority(
    operation: 'approval_ingress_authority_resolve',
    authority: RuntimePermissionApprovalIngressAuthority
  ): Promise<
    HostedApprovalRuntimeResponsePayloadByOperation['approval_ingress_authority_resolve']
  > {
    await this.assertPrivateAuthority(authority);
    return this.exchange(operation, authority);
  }

  private async assertPrivateAuthority(
    authority: RuntimePermissionApprovalIngressAuthority
  ): Promise<void> {
    const admitted = await this.options.getAdmittedIngressAuthority(authority);
    if (
      admitted === null ||
      !isExactRuntimePermissionApprovalIngressAuthority(admitted, authority)
    ) {
      throw new Error('hosted-approval-runtime-private-authority-unavailable');
    }
  }

  private request(
    body: Buffer,
    epoch: number,
    ownerBinding: OrchestratorLifecycleOwnerBinding
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      this.assertCurrentOwner(epoch, ownerBinding);
      const socket = this.connect(this.options.lease.socketPath);
      this.activeSockets.add(socket);
      const responseChunks: Buffer[] = [];
      let responseBytes = 0;
      let settled = false;
      let readableEnded = false;
      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.activeSockets.delete(socket);
        socket.removeAllListeners();
        socket.destroy();
        if (error === undefined) {
          try {
            resolve(
              new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
                Buffer.concat(responseChunks)
              )
            );
          } catch {
            this.ownerMismatch();
            reject(new Error('hosted-approval-runtime-response-utf8-invalid'));
          }
        } else reject(error instanceof Error ? error : new Error('hosted-approval-runtime-error'));
      };
      const timer = setTimeout(
        () => finish(new Error('hosted-approval-runtime-timeout')),
        this.timeoutMs
      );
      timer.unref?.();
      socket.once('connect', () => {
        void (async () => {
          this.assertCurrentOwner(epoch, ownerBinding);
          await this.assertSocketIdentity(ownerBinding);
          this.assertCurrentOwner(epoch, ownerBinding);
          socket.end(body);
        })().catch(finish);
      });
      socket.on('data', (chunk: Buffer) => {
        responseBytes += chunk.byteLength;
        if (responseBytes > HOSTED_APPROVAL_RUNTIME_MAXIMUM_FRAME_BYTES) {
          this.ownerMismatch();
          finish(new Error('hosted-approval-runtime-response-too-large'));
          return;
        }
        responseChunks.push(chunk);
        const response = Buffer.concat(responseChunks);
        const newline = response.indexOf(0x0a);
        if (newline >= 0 && newline !== response.length - 1) {
          this.ownerMismatch();
          finish(new Error('hosted-approval-runtime-response-trailing-data'));
        }
      });
      socket.once('error', finish);
      socket.once('end', () => {
        readableEnded = true;
        const response = Buffer.concat(responseChunks);
        if (response.at(-1) !== 0x0a || response.indexOf(0x0a) !== response.length - 1) {
          this.ownerMismatch();
          finish(new Error('hosted-approval-runtime-response-incomplete'));
          return;
        }
        finish();
      });
      socket.once('close', () => {
        if (!settled) {
          finish(
            new Error(
              readableEnded
                ? 'hosted-approval-runtime-response-invalid-close'
                : 'hosted-approval-runtime-response-closed'
            )
          );
        }
      });
    });
  }

  private async assertSocketIdentity(
    ownerBinding: OrchestratorLifecycleOwnerBinding
  ): Promise<void> {
    let identity: OrchestratorSocketIdentity;
    try {
      identity = await this.inspectSocketIdentity(this.options.lease.socketPath);
    } catch (error) {
      this.ownerMismatch();
      throw error;
    }
    if (!sameOrchestratorSocketIdentity(identity, ownerBinding.socketIdentity)) {
      this.ownerMismatch();
      throw new Error('hosted-approval-runtime-owner-socket-changed');
    }
  }

  private assertActive(epoch: number): void {
    if (this.closed || this.epoch !== epoch) {
      throw new Error('hosted-approval-runtime-unavailable');
    }
  }

  private assertCurrentOwner(epoch: number, ownerBinding: OrchestratorLifecycleOwnerBinding): void {
    this.assertActive(epoch);
    const current = this.options.lease.currentBinding();
    if (current === null || !sameOrchestratorLifecycleOwnerBinding(current, ownerBinding)) {
      this.ownerMismatch();
      throw new Error('hosted-approval-runtime-owner-changed');
    }
  }

  private ownerMismatch(): void {
    this.revokeSockets(true);
  }

  private revokeSockets(invalidateLease: boolean): void {
    this.epoch += 1;
    for (const socket of this.activeSockets) socket.destroy();
    this.activeSockets.clear();
    if (invalidateLease) this.options.lease.invalidate();
  }
}
