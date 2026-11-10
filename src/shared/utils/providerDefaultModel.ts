import type { CliProviderStatus } from '@shared/types';

type AnthropicDefaultStatus = Pick<
  CliProviderStatus,
  'providerId' | 'effectiveDefaultModel' | 'defaultModel'
> &
  Partial<
    Pick<CliProviderStatus, 'verificationState' | 'statusCheckOutcome' | 'statusCheckErrorCode'>
  >;

/** Current runtime resolution wins; older runtimes retain their model-list default. */
export function getAnthropicRuntimeDefaultLaunchModel(
  status?: AnthropicDefaultStatus | null
): string | null {
  if (status?.providerId !== 'anthropic') return null;
  const effective =
    status.verificationState === 'verified' &&
    status.statusCheckOutcome === 'authoritative' &&
    status.statusCheckErrorCode == null
      ? status.effectiveDefaultModel
      : null;
  const legacy = status.defaultModel;
  return (
    (typeof effective === 'string' ? effective.trim() : '') ||
    (typeof legacy === 'string' ? legacy.trim() : '') ||
    null
  );
}
