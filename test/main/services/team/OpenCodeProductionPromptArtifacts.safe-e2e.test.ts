import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TeamProvisioningService } from '../../../../src/main/services/team/TeamProvisioningService';
import { TeamRuntimeAdapterRegistry } from '../../../../src/main/services/team/runtime';
import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';
import {
  buildOpenCodeScenarioTeamRequest,
  buildScenarioRuntimeMessageInput,
  CapturingOpenCodeRuntimeAdapter,
  createCapturingOpenCodeBridge,
  createOpenCodeRuntimeAdapterFromCapture,
  dumpOpenCodePromptArtifacts,
  loadOpenCodeSemanticScenario,
  materializeOpenCodeScenarioProject,
  materializeOpenCodeScenarioTasks,
} from './openCodeSemanticScenarioHarness';

describe('OpenCode production prompt artifacts safe e2e', () => {
  let tempDir: string;
  let tempClaudeRoot: string;
  let projectPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-production-prompts-safe-e2e-'));
    tempClaudeRoot = path.join(tempDir, '.claude');
    projectPath = path.join(tempDir, 'project');
    await fs.mkdir(tempClaudeRoot, { recursive: true });
    await fs.mkdir(projectPath, { recursive: true });
    setClaudeBasePathOverride(tempClaudeRoot);
  });

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('builds realistic OpenCode launch and runtime delivery prompts through production paths', async () => {
    const scenario = await loadOpenCodeSemanticScenario();
    await materializeOpenCodeScenarioProject(scenario, projectPath);

    const selectedModel = 'openrouter/qwen/qwen3-coder';
    const teamName = `${scenario.teamNamePrefix}-dry`;
    const captureAdapter = new CapturingOpenCodeRuntimeAdapter();
    const service = new TeamProvisioningService();
    service.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([captureAdapter]));

    await service.createTeam(
      buildOpenCodeScenarioTeamRequest({
        scenario,
        teamName,
        projectPath,
        model: selectedModel,
      }),
      () => undefined
    );
    await materializeOpenCodeScenarioTasks({ scenario, teamName, projectPath });

    expect(captureAdapter.launchInputs).toHaveLength(1);
    const launchInput = captureAdapter.launchInputs[0];
    expect(launchInput).toBeDefined();
    expect(launchInput?.prompt ?? '').toContain('production desktop app');
    expect(launchInput?.expectedMembers.map((member) => member.name)).toEqual(['bob', 'jack']);
    expect(launchInput?.prompt?.length ?? 0).toBeGreaterThan(1_500);

    const bridgeCapture = createCapturingOpenCodeBridge(selectedModel);
    const realAdapter = createOpenCodeRuntimeAdapterFromCapture(bridgeCapture);
    await expect(realAdapter.launch(launchInput!)).resolves.toMatchObject({
      teamLaunchState: 'clean_success',
    });

    expect(bridgeCapture.launchCommands).toHaveLength(1);
    const launchCommand = bridgeCapture.launchCommands[0];
    expect(launchCommand?.leadPrompt).toContain('Known risk areas include stale runtime sessions');
    expect(launchCommand?.leadPrompt).toContain('OpenCode members bootstrap silently');
    expect(launchCommand?.leadPrompt.length ?? 0).toBeGreaterThan(1_500);
    expect(launchCommand?.leadPrompt.length ?? 0).toBeLessThan(80_000);
    expect(launchCommand?.members.map((member) => member.name)).toEqual(['bob', 'jack']);

    for (const member of launchCommand?.members ?? []) {
      expect(member.prompt).toContain(`You are ${member.name}`);
      expect(member.prompt).toContain('Team launch context:');
      expect(member.prompt).toContain('agent-teams_member_briefing');
      expect(member.prompt).toContain('"runtimeProvider": "opencode"');
      expect(member.prompt).toContain('agent-teams_message_send');
      expect(member.prompt).toContain('Launch bootstrap is a silent attach');
      expect(member.prompt).toContain('stay idle silently');
      expect(member.prompt).not.toContain('Call SendMessage');
      expect(member.prompt).not.toContain('Use SendMessage');
      expect(member.prompt.length).toBeGreaterThan(2_000);
      expect(member.prompt.length).toBeLessThan(100_000);
    }

    await expect(
      realAdapter.sendMessageToMember(
        buildScenarioRuntimeMessageInput({
          scenario,
          teamName,
          projectPath,
          runId: launchInput?.runId,
          kind: 'direct',
        })
      )
    ).resolves.toMatchObject({ ok: true });
    await expect(
      realAdapter.sendMessageToMember(
        buildScenarioRuntimeMessageInput({
          scenario,
          teamName,
          projectPath,
          runId: launchInput?.runId,
          kind: 'peer',
        })
      )
    ).resolves.toMatchObject({ ok: true });

    expect(bridgeCapture.messageCommands).toHaveLength(2);
    const [directCommand, peerCommand] = bridgeCapture.messageCommands;
    expect(directCommand?.text).toContain('Use teamName="opencode-semantic-realistic-dry"');
    expect(directCommand?.text).toContain('to="user"');
    expect(directCommand?.text).toContain('from="bob"');
    expect(directCommand?.text).toContain('Include source="runtime_delivery"');
    expect(directCommand?.text).toContain('Include relayOfMessageId="semantic-direct-');
    expect(directCommand?.text).toContain('Action mode for this message: ask.');
    expect(directCommand?.text).toContain('"displayId":"59560c95"');
    expect(directCommand?.text).toContain('Do not use SendMessage or runtime_deliver_message');
    expect(directCommand?.text).toContain('never use #00000000');
    expect(directCommand?.taskRefs).toEqual([
      { taskId: 'task-59560c95-runtime-delivery', displayId: '59560c95', teamName },
    ]);

    expect(peerCommand?.text).toContain('to="jack"');
    expect(peerCommand?.text).toContain('from="bob"');
    expect(peerCommand?.text).toContain('Action mode for this message: delegate.');
    expect(peerCommand?.text).toContain('"displayId":"3375c939"');
    expect(peerCommand?.taskRefs).toEqual([
      { taskId: 'task-3375c939-peer-relay', displayId: '3375c939', teamName },
    ]);

    if (process.env.OPENCODE_E2E_DUMP_PROMPTS === '1') {
      await dumpOpenCodePromptArtifacts({
        outputDir: path.join(
          process.cwd(),
          'test-results',
          'opencode-semantic-prompts',
          teamName
        ),
        launchInput: launchInput!,
        launchCommand: launchCommand!,
        messageCommands: bridgeCapture.messageCommands,
      });
    }
  });
});
