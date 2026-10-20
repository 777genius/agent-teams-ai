import crypto from 'node:crypto';

import {
  gatewayBindingKey,
  GatewayValidationError,
  normalizeGatewayBaseUrl,
  resolveGatewayConnectionSpec,
  utcDayAt,
} from '../../core/domain/index';
import {
  GatewayCredentialError,
  hashGatewayLiteral,
  hashGatewayUsageRef,
} from '../adapters/output/GatewayCredentialStore';
import { probeGatewayModels, readGatewayUsageDay } from '../adapters/output/HttpGatewayClient';

import type {
  GatewayBindMemberRequest,
  GatewayCredentialStatus,
  GatewayMemberBindingDto,
  GatewayProbeModelsRequest,
  GatewayProfileDto,
  GatewayProfileSaveRequest,
  GatewayUnbindMemberRequest,
} from '../../contracts/index';
import type { GatewayClockPort,GatewayProviderStorePort } from '../../core/application/ports';
import type {
  GatewayModelUsage,
  GatewayUsageSourceInfo,
} from '../../core/application/usage';
import type { GatewayConnectionSpec, GatewayProviderState, GatewayUsageSource } from '../../core/domain/index';
import type { GatewayCredentialStore } from '../adapters/output/GatewayCredentialStore';

export interface ResolvedMemberGatewayConnection {
  spec: GatewayConnectionSpec;
  apiKey: string;
  gatewayUsageRef: string;
  teamName: string;
  memberName: string;
}

export interface GatewayProviderServiceDeps {
  store: GatewayProviderStorePort;
  credentials: Pick<GatewayCredentialStore, 'ensure' | 'readExact' | 'status'>;
  clock: GatewayClockPort;
  probeModels?: typeof probeGatewayModels;
  readUsageDay?: typeof readGatewayUsageDay;
}

const NAME_MAX_LENGTH = 120;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function requireName(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > NAME_MAX_LENGTH) {
    throw new GatewayValidationError(`${label} is required.`);
  }
  return trimmed;
}

function requireDay(value: string): string {
  if (!DAY_PATTERN.test(value)) throw new GatewayValidationError('Invalid gateway usage day.');
  return value;
}

function toProfileDto(profile: GatewayProviderState['profiles'][number]): GatewayProfileDto {
  return { ...profile };
}

export class GatewayProviderService {
  private readonly store: GatewayProviderStorePort;
  private readonly credentials: GatewayProviderServiceDeps['credentials'];
  private readonly clock: GatewayClockPort;
  private readonly probeModelsImpl: typeof probeGatewayModels;
  private readonly readUsageDayImpl: typeof readGatewayUsageDay;

  constructor(deps: GatewayProviderServiceDeps) {
    this.store = deps.store;
    this.credentials = deps.credentials;
    this.clock = deps.clock;
    this.probeModelsImpl = deps.probeModels ?? probeGatewayModels;
    this.readUsageDayImpl = deps.readUsageDay ?? readGatewayUsageDay;
  }

  async listProfiles(): Promise<GatewayProfileDto[]> {
    const state = await this.store.read();
    return state.profiles
      .slice()
      .sort((left, right) => left.displayName.localeCompare(right.displayName))
      .map(toProfileDto);
  }

  async saveProfile(request: GatewayProfileSaveRequest): Promise<GatewayProfileDto> {
    const displayName = requireName(request.displayName, 'Profile name');
    const now = this.clock.now().toISOString();
    return this.store.mutate((state) => {
      if (request.id) {
        const index = state.profiles.findIndex((profile) => profile.id === request.id);
        if (index === -1) throw new GatewayValidationError('Gateway profile was not found.');
        const existing = state.profiles[index];
        const baseUrl = normalizeGatewayBaseUrl({
          baseUrl: request.baseUrl,
          allowPrivateNetwork: request.allowPrivateNetwork,
        });
        if (baseUrl !== existing.baseUrl && state.bindings.some((b) => b.profileId === existing.id)) {
          throw new GatewayValidationError(
            'Unbind teammates from this profile before changing its URL, or create another profile.'
          );
        }
        state.profiles[index] = {
          ...existing,
          displayName,
          baseUrl,
          allowPrivateNetwork: request.allowPrivateNetwork === true,
          updatedAt: now,
        };
        return toProfileDto(state.profiles[index]);
      }

      const baseUrl = normalizeGatewayBaseUrl({
        baseUrl: request.baseUrl,
        allowPrivateNetwork: request.allowPrivateNetwork,
      });
      const profile = {
        id: crypto.randomUUID(),
        displayName,
        baseUrl,
        allowPrivateNetwork: request.allowPrivateNetwork === true,
        createdAt: now,
        updatedAt: now,
      };
      state.profiles.push(profile);
      return toProfileDto(profile);
    });
  }

  async deleteProfile(id: string): Promise<void> {
    await this.store.mutate((state) => {
      if (state.bindings.some((binding) => binding.profileId === id)) {
        throw new GatewayValidationError(
          'Unbind teammates from this profile before deleting it.'
        );
      }
      const index = state.profiles.findIndex((profile) => profile.id === id);
      if (index === -1) throw new GatewayValidationError('Gateway profile was not found.');
      state.profiles.splice(index, 1);
    });
  }

  async listBindings(teamName?: string): Promise<GatewayMemberBindingDto[]> {
    const state = await this.store.read();
    const bindings = teamName
      ? state.bindings.filter((binding) => binding.teamName === teamName)
      : state.bindings;
    return Promise.all(
      bindings.map(async (binding) => {
        const profile = state.profiles.find((candidate) => candidate.id === binding.profileId);
        const source = state.sources.find(
          (candidate) => candidate.gatewayUsageRef === binding.gatewayUsageRef
        );
        const credentialStatus = source
          ? await this.credentials.status(source.secretStorageRef, source.keyFingerprint)
          : 'credential_missing';
        return {
          teamName: binding.teamName,
          memberName: binding.memberName,
          profileId: binding.profileId,
          profileDisplayName: profile?.displayName ?? 'Deleted profile',
          gatewayUsageRef: binding.gatewayUsageRef,
          boundAt: binding.boundAt,
          credentialStatus,
        };
      })
    );
  }

  async probeModels(request: GatewayProbeModelsRequest): Promise<string[]> {
    const apiKey = request.apiKey.trim();
    if (!apiKey) throw new GatewayValidationError('Gateway API key is required.');
    const state = await this.store.read();
    const profile = state.profiles.find((candidate) => candidate.id === request.profileId);
    if (!profile) throw new GatewayValidationError('Gateway profile was not found.');
    const baseUrl = normalizeGatewayBaseUrl({
      baseUrl: profile.baseUrl,
      allowPrivateNetwork: profile.allowPrivateNetwork,
    });
    this.assertKeyAvailableForEndpoint(state, apiKey, baseUrl);
    return this.probeModelsImpl({ baseUrl, apiKey });
  }

  async bindMember(request: GatewayBindMemberRequest): Promise<GatewayMemberBindingDto> {
    const teamName = requireName(request.teamName, 'Team name');
    const memberName = requireName(request.memberName, 'Member name');
    const apiKey = request.apiKey.trim();
    if (!apiKey) throw new GatewayValidationError('Gateway API key is required.');
    const fingerprint = hashGatewayLiteral(apiKey);
    const now = this.clock.now();
    const nowIso = now.toISOString();

    return this.store.mutate(async (state) => {
      const profile = state.profiles.find((candidate) => candidate.id === request.profileId);
      if (!profile) throw new GatewayValidationError('Gateway profile was not found.');
      const baseUrl = normalizeGatewayBaseUrl({
        baseUrl: profile.baseUrl,
        allowPrivateNetwork: profile.allowPrivateNetwork,
      });

      let source = state.sources.find((candidate) => candidate.keyFingerprint === fingerprint);
      if (source && source.canonicalEndpoint !== baseUrl) {
        throw new GatewayValidationError(
          'This key is already bound to another gateway endpoint. Use a new key for this profile.'
        );
      }
      if (source && (source.teamName !== teamName || source.memberName !== memberName)) {
        throw new GatewayValidationError(
          'This key belongs to another teammate. Use a new key for this teammate.'
        );
      }

      const storageRef = await this.credentials.ensure({
        apiKey,
        keyFingerprint: fingerprint,
        teamName,
        memberName,
        existingStorageRef: source?.secretStorageRef,
      });

      if (!source) {
        const gatewayUsageRef = hashGatewayUsageRef(baseUrl, fingerprint);
        source = {
          gatewayUsageRef,
          canonicalEndpoint: baseUrl,
          allowPrivateNetwork: profile.allowPrivateNetwork,
          keyFingerprint: fingerprint,
          secretStorageRef: storageRef,
          teamName,
          memberName,
          firstUsageDay: utcDayAt(now),
          createdAt: nowIso,
          lastBoundAt: nowIso,
          hasActiveBinding: true,
          hasRuntimeArtifact: false,
        };
        state.sources.push(source);
      } else {
        source.secretStorageRef = storageRef;
        source.hasActiveBinding = true;
        source.lastBoundAt = nowIso;
        delete source.lastUnboundAt;
      }

      const bindingId = gatewayBindingKey(teamName, memberName);
      const bindingIndex = state.bindings.findIndex(
        (binding) => gatewayBindingKey(binding.teamName, binding.memberName) === bindingId
      );
      const conflicting = state.bindings.find(
        (binding) =>
          binding.gatewayUsageRef === source.gatewayUsageRef &&
          gatewayBindingKey(binding.teamName, binding.memberName) !== bindingId
      );
      if (conflicting) {
        throw new GatewayValidationError('This gateway key is already bound to another teammate.');
      }

      const binding = {
        teamName,
        memberName,
        profileId: profile.id,
        apiKeyRef: storageRef,
        gatewayUsageRef: source.gatewayUsageRef,
        boundAt: nowIso,
      };
      if (bindingIndex === -1) {
        state.bindings.push(binding);
      } else {
        const previous = state.bindings[bindingIndex];
        state.bindings[bindingIndex] = binding;
        if (previous.gatewayUsageRef !== source.gatewayUsageRef) {
          this.retireSource(state, previous.gatewayUsageRef, nowIso);
        }
      }
      return {
        teamName,
        memberName,
        profileId: profile.id,
        profileDisplayName: profile.displayName,
        gatewayUsageRef: binding.gatewayUsageRef,
        boundAt: binding.boundAt,
        credentialStatus: 'ready' as GatewayCredentialStatus,
      };
    });
  }

  async unbindMember(request: GatewayUnbindMemberRequest): Promise<void> {
    const teamName = requireName(request.teamName, 'Team name');
    const memberName = requireName(request.memberName, 'Member name');
    const nowIso = this.clock.now().toISOString();
    await this.store.mutate((state) => {
      const bindingId = gatewayBindingKey(teamName, memberName);
      const index = state.bindings.findIndex(
        (binding) => gatewayBindingKey(binding.teamName, binding.memberName) === bindingId
      );
      if (index === -1) return;
      const [removed] = state.bindings.splice(index, 1);
      this.retireSource(state, removed.gatewayUsageRef, nowIso);
    });
  }

  async resolveMemberConnection(
    teamName: string,
    memberName: string,
    model?: string
  ): Promise<ResolvedMemberGatewayConnection | null> {
    const state = await this.store.read();
    const binding = state.bindings.find(
      (candidate) => candidate.teamName === teamName && candidate.memberName === memberName
    );
    if (!binding) return null;
    const profile = state.profiles.find((candidate) => candidate.id === binding.profileId);
    if (!profile) {
      throw new GatewayValidationError('Gateway profile for this teammate was not found.');
    }
    const source = state.sources.find(
      (candidate) => candidate.gatewayUsageRef === binding.gatewayUsageRef
    );
    if (!source) {
      throw new GatewayValidationError('Gateway usage source for this teammate was not found.');
    }
    const credential = await this.credentials.readExact(
      source.secretStorageRef,
      source.keyFingerprint
    );
    return {
      spec: resolveGatewayConnectionSpec({
        profile,
        credentialRef: source.secretStorageRef,
        model,
      }),
      apiKey: credential.value,
      gatewayUsageRef: source.gatewayUsageRef,
      teamName: source.teamName,
      memberName: source.memberName,
    };
  }

  async markRuntimeArtifactActive(gatewayUsageRef: string): Promise<void> {
    await this.store.mutate((state) => {
      const source = state.sources.find((candidate) => candidate.gatewayUsageRef === gatewayUsageRef);
      if (source) source.hasRuntimeArtifact = true;
    });
  }

  async markRuntimeArtifactRetired(gatewayUsageRef: string): Promise<void> {
    const nowIso = this.clock.now().toISOString();
    await this.store.mutate((state) => {
      const source = state.sources.find((candidate) => candidate.gatewayUsageRef === gatewayUsageRef);
      if (!source) return;
      source.hasRuntimeArtifact = false;
      source.runtimeArtifactRetiredAt = nowIso;
    });
  }

  async listUsageSources(): Promise<GatewayUsageSourceInfo[]> {
    const state = await this.store.read();
    return state.sources.map(sourceToUsageInfo);
  }

  async readUsageDay(gatewayUsageRef: string, day: string): Promise<GatewayModelUsage[]> {
    const normalizedDay = requireDay(day);
    const state = await this.store.read();
    const source = state.sources.find((candidate) => candidate.gatewayUsageRef === gatewayUsageRef);
    if (!source) throw new GatewayCredentialError('Gateway usage source was not found.', 'credential_missing');
    const baseUrl = normalizeGatewayBaseUrl({
      baseUrl: source.canonicalEndpoint,
      allowPrivateNetwork: source.allowPrivateNetwork,
    });
    if (baseUrl !== source.canonicalEndpoint) {
      throw new GatewayValidationError('Stored gateway endpoint is not canonical.');
    }
    const credential = await this.credentials.readExact(
      source.secretStorageRef,
      source.keyFingerprint
    );
    return this.readUsageDayImpl({ baseUrl, apiKey: credential.value, day: normalizedDay });
  }

  private assertKeyAvailableForEndpoint(
    state: GatewayProviderState,
    apiKey: string,
    baseUrl: string
  ): void {
    const fingerprint = hashGatewayLiteral(apiKey);
    const source = state.sources.find((candidate) => candidate.keyFingerprint === fingerprint);
    if (source && source.canonicalEndpoint !== baseUrl) {
      throw new GatewayValidationError(
        'This key is already bound to another gateway endpoint. Use a new key for this profile.'
      );
    }
  }

  private retireSource(state: GatewayProviderState, gatewayUsageRef: string, nowIso: string): void {
    const stillBound = state.bindings.some(
      (binding) => binding.gatewayUsageRef === gatewayUsageRef
    );
    if (stillBound) return;
    const source = state.sources.find((candidate) => candidate.gatewayUsageRef === gatewayUsageRef);
    if (!source) return;
    source.hasActiveBinding = false;
    source.lastUnboundAt = nowIso;
  }
}

export function sourceToUsageInfo(source: GatewayUsageSource): GatewayUsageSourceInfo {
  return {
    gatewayUsageRef: source.gatewayUsageRef,
    canonicalEndpoint: source.canonicalEndpoint,
    allowPrivateNetwork: source.allowPrivateNetwork,
    teamName: source.teamName,
    memberName: source.memberName,
    agentId: source.agentId,
    firstUsageDay: source.firstUsageDay,
    hasActiveBinding: source.hasActiveBinding,
    lastBoundAt: source.lastBoundAt,
    lastUnboundAt: source.lastUnboundAt,
    hasRuntimeArtifact: source.hasRuntimeArtifact,
    runtimeArtifactRetiredAt: source.runtimeArtifactRetiredAt,
  };
}
