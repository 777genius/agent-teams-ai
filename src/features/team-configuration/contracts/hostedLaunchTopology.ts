import { planTeamRuntimeLanes } from '@features/team-runtime-lanes';

import { HOSTED_TEAM_LEAD_NAME } from './hostedRosterConfiguration';

import type { HostedRosterConfiguration } from './hostedRosterConfiguration';
import type { TeamProviderId } from '@shared/types';

/**
 * Native providers the Hosted MVP can run as host-local Owner lanes. Gemini is intentionally
 * absent: it stays configurable for desktop parity but is never admitted for a hosted launch.
 */
export const HOSTED_NATIVE_LANE_PROVIDERS = Object.freeze(['anthropic', 'codex'] as const);
export type HostedNativeLaneProvider = (typeof HOSTED_NATIVE_LANE_PROVIDERS)[number];

export function isHostedNativeLaneProvider(
  provider: TeamProviderId
): provider is HostedNativeLaneProvider {
  return (HOSTED_NATIVE_LANE_PROVIDERS as readonly TeamProviderId[]).includes(provider);
}

/**
 * Deployment facts that decide whether native lanes may launch. Native CLIs run as trusted
 * processes of the deployment OS user, so they need the declared trusted_process runtime profile.
 */
export interface HostedLaunchTopologyPolicy {
  readonly nativeHostLocalLanes: boolean;
}

export const HOSTED_LAUNCH_TOPOLOGY_REFUSALS = Object.freeze([
  'native_provider_unsupported',
  'native_runtime_isolation_unavailable',
  'mixed_runtime_topology',
  'multi_lane_native_topology',
  'native_lane_too_many_members',
  'native_member_name_collision',
] as const);
export type HostedLaunchTopologyRefusal = (typeof HOSTED_LAUNCH_TOPOLOGY_REFUSALS)[number];

export function isHostedLaunchTopologyRefusal(
  value: unknown
): value is HostedLaunchTopologyRefusal {
  return (HOSTED_LAUNCH_TOPOLOGY_REFUSALS as readonly unknown[]).includes(value);
}

/** Owner bootstraps at most this many native teammates next to team-lead. */
export const HOSTED_NATIVE_LANE_MAX_TEAMMATES = 20;

/** Owner's runtime member key: every non-alphanumeric character becomes `-`, then lowercase. */
function nativeRuntimeMemberKey(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
}

export type HostedLaunchTopologyAdmission =
  | Readonly<{ kind: 'admitted'; topology: 'opencode' }>
  | Readonly<{
      kind: 'admitted';
      topology: 'native';
      leadProvider: HostedNativeLaneProvider;
      providers: readonly HostedNativeLaneProvider[];
    }>
  | Readonly<{ kind: 'refused'; reason: HostedLaunchTopologyRefusal }>;

/**
 * Launch-time topology gate, separate from parsing: saved drafts stay readable whatever the
 * deployment supports. MVP admits pure OpenCode teams and native teams with one lane per native
 * provider, e.g. a Claude lead lane plus a Codex lane.
 * TODO(hosted-native-opencode): native + OpenCode teams stay refused until Owner runs OpenCode side
 * lanes next to a native lead (desktop mixed_opencode_side_lanes).
 */
export function admitHostedLaunchTopology(
  configuration: Pick<HostedRosterConfiguration, 'lanes'>,
  policy: HostedLaunchTopologyPolicy
): HostedLaunchTopologyAdmission {
  const native = configuration.lanes.filter((lane) => lane.kind === 'native');
  if (native.length === 0) return Object.freeze({ kind: 'admitted', topology: 'opencode' });
  const refuse = (reason: HostedLaunchTopologyRefusal): HostedLaunchTopologyAdmission =>
    Object.freeze({ kind: 'refused', reason });
  const providers = native.map((lane) => lane.provider);
  if (!providers.every(isHostedNativeLaneProvider)) return refuse('native_provider_unsupported');
  if (!policy.nativeHostLocalLanes) return refuse('native_runtime_isolation_unavailable');
  if (native.length !== configuration.lanes.length) return refuse('mixed_runtime_topology');
  // Owner launches one lane per provider; the plan keeps one lane per provider too.
  if (new Set(providers).size !== providers.length) return refuse('multi_lane_native_topology');
  const members = native.flatMap((lane) => lane.members);
  if (members.length > HOSTED_NATIVE_LANE_MAX_TEAMMATES + 1) {
    return refuse('native_lane_too_many_members');
  }
  // `a.b` and `a_b` are distinct roster names but one native runtime member.
  if (new Set(members.map(({ name }) => nativeRuntimeMemberKey(name))).size !== members.length) {
    return refuse('native_member_name_collision');
  }
  const leadLane = native.find((lane) =>
    lane.members.some(({ name }) => name === HOSTED_TEAM_LEAD_NAME)
  );
  if (!leadLane || !isHostedNativeLaneProvider(leadLane.provider)) {
    return refuse('mixed_runtime_topology');
  }
  // Same rule as a desktop launch: native teammates of any provider join the lead's primary lane.
  const plan = planTeamRuntimeLanes({
    leadProviderId: leadLane.provider,
    members: native.flatMap((lane) =>
      lane.members
        .filter(({ name }) => name !== HOSTED_TEAM_LEAD_NAME)
        .map(({ name, model }) => ({ name, model, providerId: lane.provider }))
    ),
  });
  if (!plan.ok || plan.plan.mode !== 'primary_only') return refuse('mixed_runtime_topology');
  return Object.freeze({
    kind: 'admitted',
    topology: 'native',
    leadProvider: leadLane.provider,
    providers: Object.freeze(providers.filter(isHostedNativeLaneProvider)),
  });
}
