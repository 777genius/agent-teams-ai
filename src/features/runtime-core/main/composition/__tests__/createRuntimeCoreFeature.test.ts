import { describe, expect, it, vi } from 'vitest';

import {
  createRuntimeCoreFeature,
  createRuntimeCoreProviderJsonParsingServices,
  createRuntimeCoreTeamUseCases,
  type RuntimeCoreTeamOrchestrationSource,
} from '../createRuntimeCoreFeature';

import type { TeamHttpDataApi } from '@main/services/team/contracts/TeamProvisioningApis';

const ORCHESTRATION_METHOD_NAMES = [
  'createTeam',
  'launchTeam',
  'getProvisioningStatus',
  'getCliHelpOutput',
  'prepareForProvisioning',
  'cancelProvisioning',
  'hasProvisioningRun',
  'repairStaleTaskActivityIntervalsBeforeSnapshot',
  'getRuntimeState',
  'stopTeam',
  'isTeamAlive',
  'getAliveTeams',
  'getCurrentRunId',
  'getMemberSpawnStatuses',
  'attachLiveRosterMember',
  'detachLiveRosterMember',
  'restartMember',
  'retryFailedOpenCodeSecondaryLanes',
  'skipMemberForLaunch',
  'getLeadActivityState',
  'getLeadContextUsage',
  'getTeamAgentRuntimeSnapshot',
  'getClaudeLogs',
  'sendMessageToTeam',
  'relayOpenCodeMemberInboxMessages',
  'relayLeadInboxMessages',
  'getOpenCodeRuntimeDeliveryStatus',
  'resolveRuntimeRecipientProviderId',
  'getLiveLeadProcessMessages',
  'getCurrentLeadSessionId',
  'pushLiveLeadProcessMessage',
  'respondToToolApproval',
  'updateToolApprovalSettings',
  'recordOpenCodeRuntimeBootstrapCheckin',
  'deliverOpenCodeRuntimeMessage',
  'recordOpenCodeRuntimeTaskEvent',
  'recordOpenCodeRuntimeHeartbeat',
  'answerOpenCodeRuntimePermission',
] as const;

function makeOrchestrationSource(): RuntimeCoreTeamOrchestrationSource & {
  calls: string[];
  marker: string;
} {
  const source: Record<string, unknown> = {
    calls: [],
    marker: 'bound-source',
  };
  for (const name of ORCHESTRATION_METHOD_NAMES) {
    source[name] = function boundMethod(this: { calls: string[]; marker: string }) {
      this.calls.push(name);
      return this.marker;
    };
  }
  return source as unknown as RuntimeCoreTeamOrchestrationSource & {
    calls: string[];
    marker: string;
  };
}

function makeTeamDataApi(): TeamHttpDataApi & { calls: string[]; marker: string } {
  const calls: string[] = [];
  const marker = 'data-source';
  return {
    calls,
    marker,
    listTeams() {
      calls.push('listTeams');
      return Promise.resolve([]);
    },
    getTeamData() {
      calls.push('getTeamData');
      return Promise.resolve({ teamName: marker } as never);
    },
    getSavedRequest() {
      calls.push('getSavedRequest');
      return Promise.resolve(null);
    },
    createTeamConfig() {
      calls.push('createTeamConfig');
      return Promise.resolve();
    },
  };
}

describe('createRuntimeCoreFeature', () => {
  it('keeps provider JSON parsing services in the backend runtime facade', () => {
    const providerJsonParsing = {
      projectScanner: { scan: vi.fn() },
      sessionParser: { parseSession: vi.fn() },
      subagentResolver: { resolveSubagents: vi.fn() },
      chunkBuilder: { buildGroups: vi.fn() },
      dataCache: { get: vi.fn() },
    };

    const result = createRuntimeCoreProviderJsonParsingServices(providerJsonParsing as never);

    expect(result).toEqual(providerJsonParsing);
  });

  it('exposes bound team use cases for HTTP and IPC adapters', async () => {
    const data = makeTeamDataApi();
    const orchestration = makeOrchestrationSource();

    const useCases = createRuntimeCoreTeamUseCases({ data, orchestration });

    await useCases.data.listTeams();
    expect(useCases.http.runtime.getAliveTeams()).toBe('bound-source');
    expect(useCases.http.taskActivity.repairStaleTaskActivityIntervalsBeforeSnapshot('alpha')).toBe(
      'bound-source'
    );
    expect(useCases.ipc.preflight.getCliHelpOutput()).toBe('bound-source');
    expect(useCases.ipc.memberLifecycle.restartMember('alpha', 'lead')).toBe('bound-source');

    expect(data.calls).toEqual(['listTeams']);
    expect(orchestration.calls).toEqual([
      'getAliveTeams',
      'repairStaleTaskActivityIntervalsBeforeSnapshot',
      'getCliHelpOutput',
      'restartMember',
    ]);
    expect('preflight' in useCases.http).toBe(false);
  });

  it('can compose provider parsing without team runtime sources', () => {
    const providerJsonParsing = {
      projectScanner: {},
      sessionParser: {},
      subagentResolver: {},
      chunkBuilder: {},
      dataCache: {},
    };

    const feature = createRuntimeCoreFeature({
      providerJsonParsing: providerJsonParsing as never,
    });

    expect(feature.providerJsonParsing).toEqual(providerJsonParsing);
    expect(feature.teams).toBeUndefined();
  });
});
