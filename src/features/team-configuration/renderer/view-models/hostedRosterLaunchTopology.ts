import {
  admitHostedLaunchTopology,
  HOSTED_NATIVE_LANE_MAX_TEAMMATES,
  HOSTED_NATIVE_LANE_PROVIDERS,
  type HostedLaunchTopologyPolicy,
  type HostedLaunchTopologyRefusal,
  isHostedLaunchTopologyRefusal,
} from '../../contracts/hostedLaunchTopology';

import type { HostedRosterConfiguration } from '../../contracts/hostedRosterConfiguration';
import type { TeamProviderId } from '@shared/types';

/** Fail closed until the deployment declares its trusted_process runtime profile. */
export const HOSTED_LAUNCH_TOPOLOGY_POLICY_UNDECLARED: HostedLaunchTopologyPolicy = Object.freeze({
  nativeHostLocalLanes: false,
});

const PROVIDER_LABELS: Readonly<Record<TeamProviderId, string>> = Object.freeze({
  anthropic: 'Claude / Anthropic',
  codex: 'Codex',
  gemini: 'Gemini',
  opencode: 'OpenCode',
});

export function hostedRosterProviderLabel(provider: TeamProviderId): string {
  return PROVIDER_LABELS[provider];
}

/** Providers offered for new or changed lanes. Saved lanes keep displaying their own provider. */
export function hostedRosterProviderOptions(
  policy: HostedLaunchTopologyPolicy
): readonly TeamProviderId[] {
  return Object.freeze([
    ...(policy.nativeHostLocalLanes ? HOSTED_NATIVE_LANE_PROVIDERS : []),
    'opencode' as const,
  ]);
}

const REFUSAL_TEXT: Readonly<Record<HostedLaunchTopologyRefusal, string>> = Object.freeze({
  native_provider_unsupported:
    'This roster uses a runtime provider that Hosted cannot launch. Use OpenCode, Claude or Codex lanes.',
  native_runtime_isolation_unavailable:
    'This deployment does not run agents as trusted host processes, so only OpenCode lanes can launch.',
  mixed_runtime_topology:
    'A Hosted team launches either OpenCode lanes or Claude and Codex lanes, not both.',
  multi_lane_native_topology:
    'Hosted launches one lane per provider. Move all Claude members into one lane and all Codex members into another.',
  native_lane_too_many_members: `Claude and Codex lanes launch at most ${HOSTED_NATIVE_LANE_MAX_TEAMMATES} members besides team-lead.`,
  native_member_name_collision:
    'Two member names differ only by ".", "_" or "-". Rename one so the Claude and Codex lanes can launch.',
});

export function hostedLaunchTopologyRefusalText(reason: HostedLaunchTopologyRefusal): string {
  return REFUSAL_TEXT[reason];
}

/** Launch-only notice: the roster can still be saved, it just cannot be promoted here. */
export function hostedRosterLaunchNotice(
  configuration: HostedRosterConfiguration,
  policy: HostedLaunchTopologyPolicy
): string | null {
  const admission = admitHostedLaunchTopology(configuration, policy);
  return admission.kind === 'refused' ? hostedLaunchTopologyRefusalText(admission.reason) : null;
}

/** Maps a typed server refusal (`promotion_<reason>`) back to operator-facing text. */
export function hostedPromotionRefusalText(reason: string): string | null {
  const refusal = reason.startsWith('promotion_') ? reason.slice('promotion_'.length) : null;
  return isHostedLaunchTopologyRefusal(refusal) ? hostedLaunchTopologyRefusalText(refusal) : null;
}
