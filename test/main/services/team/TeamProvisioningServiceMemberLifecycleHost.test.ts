import {
  getMemberLifecycleOperationKey,
} from '@main/services/team/provisioning/TeamProvisioningMemberLifecycleKeys';
import { TeamProvisioningService } from '@main/services/team/TeamProvisioningService';
import { describe, expect, it } from 'vitest';

import {
  memberFixture,
  memberLifecycleHostHarness,
  teamConfigFixture,
  teamMetaFixture,
  TeamProvisioningHarnessBuilder,
} from './provisioningHarness';

type MemberLifecycleHostProbe = {
  memberLifecycleHost: {
    readConfigForStrictDecision(teamName: string): Promise<unknown>;
    mcpConfigBuilder: {
      writeConfigFile(projectPath?: string): Promise<string>;
    };
    membersMetaStore: {
      getMembers(teamName: string): Promise<unknown[]>;
    };
    teamMetaStore: {
      getMeta(teamName: string): Promise<unknown>;
    };
    buildTrackedMemberMcpLaunchConfig(input: {
      cwd: string;
      mcpPolicy?: unknown;
      run: { id: string };
    }): Promise<unknown>;
    removeTrackedMemberMcpLaunchConfig(run: { id: string }, config: unknown): Promise<void>;
  };
  memberLifecycleOperationUseCases: {
    isMemberLifecycleOperationActive(teamName: string, memberName: string): boolean;
    runMemberLifecycleOperation?<T>(
      teamName: string,
      memberName: string,
      kind: 'manual_restart' | 'primary_member_updated',
      operation: () => Promise<T>
    ): Promise<T>;
  };
  memberLifecycleOperations: Map<string, { kind: string; startedAtMs: number }>;
  getRuntimeSnapshotCacheGeneration(teamName: string): number;
};

type MemberMcpLaunchConfigProvisionerProbe = {
  memberMcpLaunchConfigProvisioner: {
    buildTrackedMemberMcpLaunchConfig(input: {
      cwd: string;
      mcpPolicy?: unknown;
      run: { id: string };
    }): Promise<unknown>;
    removeTrackedMemberMcpLaunchConfig(run: { id: string }, config: unknown): Promise<void>;
  };
};

describe('TeamProvisioningService member lifecycle host', () => {
  it('binds member lifecycle host callbacks through harness store fixtures', async () => {
    const teamName = 'lifecycle-host-harness-team';
    const harness = await TeamProvisioningHarnessBuilder.create()
      .withTempWorkspace({ applyPathOverride: false })
      .withTeam(
        teamName,
        teamConfigFixture.basic({
          teamName,
          members: [memberFixture.lead(), memberFixture.codex('Builder')],
        })
      )
      .withMembersMeta(teamName, [memberFixture.codex('Builder')])
      .withTeamMeta(
        teamName,
        teamMetaFixture.basic({
          displayName: 'Lifecycle Host Harness Team',
          cwd: '/tmp/agent-teams-harness/lifecycle-host',
        })
      )
      .build();
    const mcpConfigBuilder = {
      marker: 'mcp-bound',
      async writeConfigFile(this: { marker: string }, projectPath?: string) {
        return `${projectPath ?? ''}/${this.marker}.json`;
      },
    };

    try {
      const service = new TeamProvisioningService(
        harness.stores.configReader as unknown as ConstructorParameters<
          typeof TeamProvisioningService
        >[0],
        undefined,
        harness.stores.membersMetaStore as unknown as ConstructorParameters<
          typeof TeamProvisioningService
        >[2],
        undefined,
        mcpConfigBuilder as unknown as ConstructorParameters<typeof TeamProvisioningService>[4],
        harness.stores.teamMetaStore as unknown as ConstructorParameters<
          typeof TeamProvisioningService
        >[5]
      );
      const host = memberLifecycleHostHarness(service);

      await expect(host.readConfigForStrictDecision(teamName)).resolves.toMatchObject({
        name: teamName,
        members: [
          expect.objectContaining({ name: 'Lead' }),
          expect.objectContaining({ name: 'Builder' }),
        ],
      });
      await expect(host.mcpConfigBuilder.writeConfigFile('/repo')).resolves.toBe(
        '/repo/mcp-bound.json'
      );
      await expect(host.membersMetaStore.getMembers(teamName)).resolves.toEqual([
        expect.objectContaining({ name: 'Builder' }),
      ]);
      await expect(host.teamMetaStore.getMeta(teamName)).resolves.toMatchObject({
        cwd: '/tmp/agent-teams-harness/lifecycle-host',
      });
    } finally {
      await harness.cleanup();
    }
  });

  it('does not expose service-level optional lifecycle seams after construction', () => {
    const service = new TeamProvisioningService();
    const serviceSeams = service as unknown as {
      marker: string;
      updateDirectTmuxRestartMemberConfig?: (this: { marker: string }, input: unknown) => void;
      enqueueDirectRestartPrompt?: (this: { marker: string }, input: unknown) => void;
    };
    const calls: unknown[] = [];
    serviceSeams.marker = 'service-seam-bound';
    serviceSeams.updateDirectTmuxRestartMemberConfig = function (input: unknown) {
      calls.push({ kind: 'update', marker: this.marker, input });
    };
    serviceSeams.enqueueDirectRestartPrompt = function (input: unknown) {
      calls.push({ kind: 'enqueue', marker: this.marker, input });
    };
    const host = (service as unknown as MemberLifecycleHostProbe).memberLifecycleHost;

    expect(
      (host as { updateDirectTmuxRestartMemberConfig?: unknown }).updateDirectTmuxRestartMemberConfig
    ).toBeUndefined();
    expect(
      (host as { enqueueDirectRestartPrompt?: unknown }).enqueueDirectRestartPrompt
    ).toBeUndefined();
    expect(
      (host as { runMemberLifecycleOperation?: unknown }).runMemberLifecycleOperation
    ).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('lazily resolves the member MCP launch config provisioner', async () => {
    const service = new TeamProvisioningService();
    const serviceProbe = service as unknown as MemberLifecycleHostProbe &
      MemberMcpLaunchConfigProvisionerProbe;
    const calls: string[] = [];
    serviceProbe.memberMcpLaunchConfigProvisioner = {
      async buildTrackedMemberMcpLaunchConfig(input) {
        calls.push(`build:${input.run.id}:${input.cwd}`);
        return { configPath: '/tmp/member-mcp.json' };
      },
      async removeTrackedMemberMcpLaunchConfig(run, config) {
        calls.push(`remove:${run.id}:${config ? 'config' : 'none'}`);
      },
    };

    const config = await serviceProbe.memberLifecycleHost.buildTrackedMemberMcpLaunchConfig({
      cwd: '/repo',
      mcpPolicy: undefined,
      run: { id: 'run-lazy' },
    });
    await serviceProbe.memberLifecycleHost.removeTrackedMemberMcpLaunchConfig(
      { id: 'run-lazy' },
      config
    );

    expect(calls).toEqual(['build:run-lazy:/repo', 'remove:run-lazy:config']);
  });

  it('runs lifecycle operations through the service-owned use case port', async () => {
    const service = new TeamProvisioningService();
    const serviceProbe = service as unknown as MemberLifecycleHostProbe;
    const operationUseCases = serviceProbe.memberLifecycleOperationUseCases;
    let resolveOperation: () => void = () => undefined;
    const operationBlocker = new Promise<void>((resolve) => {
      resolveOperation = resolve;
    });

    expect(operationUseCases.runMemberLifecycleOperation).toBeTypeOf('function');
    expect(operationUseCases.isMemberLifecycleOperationActive('team-a', 'Worker')).toBe(false);

    const operation = operationUseCases.runMemberLifecycleOperation!(
      'team-a',
      'Worker',
      'manual_restart',
      async () => {
        await operationBlocker;
        return 'done';
      }
    );

    try {
      expect(
        serviceProbe.memberLifecycleOperations.get(
          getMemberLifecycleOperationKey('team-a', 'Worker')
        )
      ).toMatchObject({
        kind: 'manual_restart',
      });
      expect(operationUseCases.isMemberLifecycleOperationActive('team-a', 'Worker')).toBe(true);
      const generationDuringOperation =
        serviceProbe.getRuntimeSnapshotCacheGeneration('team-a');

      await expect(
        operationUseCases.runMemberLifecycleOperation!(
          ' TEAM-A ',
          ' worker ',
          'primary_member_updated',
          async () => 'overlap'
        )
      ).rejects.toThrow('Lifecycle operation for teammate " worker " is already in progress');

      resolveOperation();
      await expect(operation).resolves.toBe('done');
      expect(serviceProbe.memberLifecycleOperations.size).toBe(0);
      expect(serviceProbe.getRuntimeSnapshotCacheGeneration('team-a')).toBeGreaterThan(
        generationDuringOperation
      );
    } finally {
      resolveOperation();
    }
  });
});
