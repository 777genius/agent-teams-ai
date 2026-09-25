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
] as const);
export type HostedLaunchTopologyRefusal = (typeof HOSTED_LAUNCH_TOPOLOGY_REFUSALS)[number];

export function isHostedLaunchTopologyRefusal(
  value: unknown
): value is HostedLaunchTopologyRefusal {
  return (HOSTED_LAUNCH_TOPOLOGY_REFUSALS as readonly unknown[]).includes(value);
}

export type HostedLaunchTopologyAdmission =
  | Readonly<{ kind: 'admitted'; topology: 'opencode' }>
  | Readonly<{ kind: 'admitted'; topology: 'native'; provider: HostedNativeLaneProvider }>
  | Readonly<{ kind: 'refused'; reason: HostedLaunchTopologyRefusal }>;

/**
 * Launch-time topology gate, separate from parsing: saved drafts stay readable whatever the
 * deployment supports. MVP admits pure OpenCode teams and single-lane native teams.
 * TODO(hosted-native-mixed): a mixed Claude lead + Codex member team needs Owner support for
 * several native lanes before multi_lane_native_topology can be admitted.
 */
export function admitHostedLaunchTopology(
  configuration: Pick<HostedRosterConfiguration, 'lanes'>,
  policy: HostedLaunchTopologyPolicy
): HostedLaunchTopologyAdmission {
  const native = configuration.lanes.filter((lane) => lane.kind === 'native');
  if (native.length === 0) return Object.freeze({ kind: 'admitted', topology: 'opencode' });
  const refuse = (reason: HostedLaunchTopologyRefusal): HostedLaunchTopologyAdmission =>
    Object.freeze({ kind: 'refused', reason });
  if (native.some((lane) => !isHostedNativeLaneProvider(lane.provider))) {
    return refuse('native_provider_unsupported');
  }
  if (!policy.nativeHostLocalLanes) return refuse('native_runtime_isolation_unavailable');
  if (native.length !== configuration.lanes.length) return refuse('mixed_runtime_topology');
  if (native.length !== 1) return refuse('multi_lane_native_topology');
  const provider = native[0].provider;
  return isHostedNativeLaneProvider(provider)
    ? Object.freeze({ kind: 'admitted', topology: 'native', provider })
    : refuse('native_provider_unsupported');
}
