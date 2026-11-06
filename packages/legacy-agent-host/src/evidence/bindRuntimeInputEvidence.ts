import { isAbsolute, resolve } from 'node:path';
import { digest, effectId } from '../team/identity.js';
import { deliveryFingerprint, normalizeBinding, runtimeDigest } from '../runtime/identity.js';
import { TeamOwnerError } from '../team/contracts.js';
import type { ToolInputCause } from '../team/lookupEvidenceCause.js';
import type { TaskStartCause } from '../team/TaskStartCause.js';
import type {
  RuntimeBinding,
  RuntimeDelivery,
  RuntimeSessionRecord,
} from '../runtime/contracts.js';

/** Structural private D observation seam; tool arguments never select workspace or Task. */
export interface NativeInputCaptureIdentity {
  readonly phase: 'before' | 'after' | 'gap';
  readonly sessionRef: string;
  readonly inputId?: string;
  readonly operationRef?: string;
  readonly signal: Pick<AbortSignal, 'aborted'>;
}
export interface EvidenceWorkspace {
  readonly path: string;
  /** Stable filesystem identity captured by trusted profile/descriptor composition. */
  readonly identity: string;
}
export type TaskToolEvidenceGap =
  | 'native-gap'
  | 'aborted'
  | 'runtime'
  | 'input'
  | 'unattributed'
  | 'authority'
  | 'storage';
export type RuntimeInputEvidenceBinding = ToolInputCause & {
  readonly windowId: string;
  readonly sessionRef: string;
  readonly operationRef: string;
  readonly hostIncarnation: string;
  readonly configRevision: string;
  readonly workspace: Readonly<EvidenceWorkspace>;
  readonly provenance: Readonly<{
    phase: 'claimed' | 'consumed' | 'terminal' | 'unknown';
    outcome: 'handed-off' | 'unknown';
    /** Causal ownership alone never proves complete file/change evidence. */
    reviewableComplete: false;
  }>;
};
export type RuntimeInputEvidenceAttribution =
  | Readonly<{ kind: 'bound'; binding: Readonly<RuntimeInputEvidenceBinding> }>
  | Readonly<{ kind: 'gap'; reason: TaskToolEvidenceGap }>;
const gap = (reason: TaskToolEvidenceGap): RuntimeInputEvidenceAttribution =>
  Object.freeze({ kind: 'gap', reason });
const validId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\0\r\n]/u.test(value);

/** No I/O ownership, state mutation or heuristic fallback: both persisted owners must agree. */
export function bindRuntimeInputEvidence(options: {
  captured: Readonly<{
    binding: RuntimeBinding;
    profileId: string;
    hostIncarnation: string;
    config: NonNullable<RuntimeSessionRecord['config']>;
    workspace: EvidenceWorkspace;
  }>;
  request: NativeInputCaptureIdentity;
  readRuntime(): { record: RuntimeSessionRecord | undefined; attached: boolean };
  lookupTaskCause(intent: RuntimeDelivery): TaskStartCause | null;
  lookupInputCause?(intent: RuntimeDelivery): ToolInputCause | null;
  assertCurrent(): void;
}): RuntimeInputEvidenceAttribution {
  const { request, captured } = options;
  if (request.signal.aborted) return gap('aborted');
  if (request.phase === 'gap') return gap('native-gap');
  if (![request.sessionRef, request.inputId, request.operationRef].every(validId))
    return gap('input');
  try {
    options.assertCurrent();
    const workspace = captured.workspace;
    if (
      !isAbsolute(workspace.path) ||
      resolve(workspace.path) !== workspace.path ||
      !validId(workspace.identity)
    )
      return gap('runtime');
    const { record, attached } = options.readRuntime();
    if (
      !record ||
      !attached ||
      record.schemaVersion !== 1 ||
      record.phase !== 'allocated' ||
      record.sealed ||
      record.custody !== 'owned' ||
      record.profileId !== captured.profileId ||
      record.hostIncarnation !== captured.hostIncarnation ||
      record.sessionRef !== request.sessionRef ||
      digest(normalizeBinding(record.binding)) !== digest(normalizeBinding(captured.binding)) ||
      runtimeDigest(record.config) !== runtimeDigest(captured.config) ||
      record.openFingerprint !==
        runtimeDigest({ profileId: captured.profileId, config: captured.config })
    )
      return gap('runtime');
    const matching = record.inputs.filter(
      (entry) =>
        entry.intent.inputId === request.inputId && entry.operationRef === request.operationRef
    );
    if (matching.length !== 1) return gap('input');
    const input = matching[0]!;
    if (
      !['claimed', 'consumed', 'terminal', 'unknown'].includes(input.phase) ||
      (input.phase === 'terminal' && input.terminal === 'cancelled') ||
      input.intent.inputId !== input.intent.deliveryId ||
      digest(normalizeBinding(input.intent.binding)) !==
        digest(normalizeBinding(captured.binding)) ||
      input.fingerprint !== deliveryFingerprint(input.intent)
    )
      return gap('input');
    const cause = (options.lookupInputCause ?? options.lookupTaskCause)(
      structuredClone(input.intent)
    );
    if (!cause) return gap('unattributed');
    if (
      cause.inputId !== input.intent.inputId ||
      cause.deliveryId !== input.intent.deliveryId ||
      cause.messageId !== input.intent.messageId ||
      digest(normalizeBinding(cause.binding)) !== digest(normalizeBinding(captured.binding))
    )
      return gap('input');
    options.assertCurrent();
    if (request.signal.aborted) return gap('aborted');
    const phase = input.phase as RuntimeInputEvidenceBinding['provenance']['phase'];
    return Object.freeze({
      kind: 'bound',
      binding: Object.freeze({
        ...cause,
        binding: Object.freeze({ ...cause.binding }),
        windowId: effectId(
          'task-evidence-window',
          digest({
            cause,
            operationRef: request.operationRef,
            sessionRef: request.sessionRef,
            hostIncarnation: captured.hostIncarnation,
            workspace,
          })
        ),
        sessionRef: request.sessionRef,
        operationRef: request.operationRef!,
        hostIncarnation: captured.hostIncarnation,
        configRevision: captured.config.configRevision,
        workspace: Object.freeze({ ...workspace }),
        provenance: Object.freeze({
          phase,
          outcome: phase === 'unknown' ? 'unknown' : 'handed-off',
          reviewableComplete: false,
        }),
      }),
    });
  } catch (error) {
    return gap(
      error instanceof TeamOwnerError && error.code === 'forbidden' ? 'authority' : 'storage'
    );
  }
}
