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
  'opencode_lead_with_native_members',
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
 * deployment supports. Admits what a desktop launch admits: pure OpenCode teams, and teams led from
 * a native lane with native teammates of any provider (one lane per native provider) and OpenCode
 * teammates in OpenCode lanes.
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
  // Owner launches one lane per native provider; the plan keeps one lane per provider too.
  if (new Set(providers).size !== providers.length) return refuse('multi_lane_native_topology');
  if (native.flatMap((lane) => lane.members).length > HOSTED_NATIVE_LANE_MAX_TEAMMATES + 1) {
    return refuse('native_lane_too_many_members');
  }
  // Inboxes and the OpenCode relay address members by name, so `a.b` and `a_b` in any two lanes
  // would be one runtime member.
  const members = configuration.lanes.flatMap((lane) => lane.members);
  if (new Set(members.map(({ name }) => nativeRuntimeMemberKey(name))).size !== members.length) {
    return refuse('native_member_name_collision');
  }
  const leadLane = configuration.lanes.find((lane) =>
    lane.members.some(({ name }) => name === HOSTED_TEAM_LEAD_NAME)
  );
  if (!leadLane) return refuse('mixed_runtime_topology');
  // The desktop lane planner decides what is launchable: native teammates join the lead's primary
  // lane, OpenCode teammates run as side lanes, and an OpenCode lead cannot lead native members.
  const plan = planTeamRuntimeLanes({
    leadProviderId: leadLane.provider,
    members: configuration.lanes.flatMap((lane) =>
      lane.members
        .filter(({ name }) => name !== HOSTED_TEAM_LEAD_NAME)
        .map(({ name, model }) => ({ name, model, providerId: lane.provider }))
    ),
  });
  if (!plan.ok) return refuse('opencode_lead_with_native_members');
  if (plan.plan.mode !== 'primary_only' && plan.plan.mode !== 'mixed_opencode_side_lanes') {
    return refuse('mixed_runtime_topology');
  }
  if (!isHostedNativeLaneProvider(leadLane.provider)) {
    return refuse('opencode_lead_with_native_members');
  }
  return Object.freeze({
    kind: 'admitted',
    topology: 'native',
    leadProvider: leadLane.provider,
    providers: Object.freeze(providers.filter(isHostedNativeLaneProvider)),
  });
}
