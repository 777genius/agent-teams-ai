import { bindRuntimeInputEvidence } from './bindRuntimeInputEvidence.js';
import type {
  NativeInputCaptureIdentity,
  RuntimeInputEvidenceBinding,
  RuntimeInputEvidenceAttribution,
} from './bindRuntimeInputEvidence.js';
export type { EvidenceWorkspace, TaskToolEvidenceGap } from './bindRuntimeInputEvidence.js';
export interface NativeToolCaptureIdentity extends NativeInputCaptureIdentity {
  readonly toolUseId: string;
  readonly toolName: string;
}
export type TaskToolEvidenceBinding = RuntimeInputEvidenceBinding & {
  readonly toolUseId: string;
  readonly toolName: string;
};
export type TaskToolEvidenceAttribution =
  | Readonly<{ kind: 'bound'; binding: Readonly<TaskToolEvidenceBinding> }>
  | Exclude<RuntimeInputEvidenceAttribution, { kind: 'bound' }>;
/** Adds actual tool identity to the same canonical original-input authority check. */
export function bindTaskToolEvidence(
  options: Omit<Parameters<typeof bindRuntimeInputEvidence>[0], 'request'> & {
    request: NativeToolCaptureIdentity;
  }
): TaskToolEvidenceAttribution {
  const valid = (value: unknown): value is string =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1024 &&
    !/[\0\r\n]/u.test(value);
  // Preserve the existing ordering for aborted/native-gap observations.
  if (options.request.signal.aborted) return Object.freeze({ kind: 'gap', reason: 'aborted' });
  if (options.request.phase === 'gap') return Object.freeze({ kind: 'gap', reason: 'native-gap' });
  if (!valid(options.request.toolUseId) || !valid(options.request.toolName))
    return Object.freeze({ kind: 'gap', reason: 'input' });
  const result = bindRuntimeInputEvidence(options);
  if (result.kind === 'gap') return result;
  return Object.freeze({
    kind: 'bound',
    binding: Object.freeze({
      ...result.binding,
      toolUseId: options.request.toolUseId,
      toolName: options.request.toolName,
    }),
  });
}
