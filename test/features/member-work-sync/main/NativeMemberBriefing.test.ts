import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import {
  createTeamController,
  createTeamPolicy,
} from '../../../../packages/legacy-agent-host/src/adapters/team/ControllerAdapter.js';
import { createFilesystemTeamOwner } from '../../../../packages/legacy-agent-host/src/adapters/team/createFilesystemTeamOwner.js';
import { TaskEffectPlan } from '../../../../packages/legacy-agent-host/src/adapters/team/TaskEffectPlan.js';
import { TeamOwnerStore } from '../../../../packages/legacy-agent-host/src/adapters/team/TeamOwnerStore.js';
import { createTeamMcpTools } from '../../../../packages/legacy-agent-host/src/mcp/tools.js';
import { TeamOwner } from '../../../../packages/legacy-agent-host/src/team/TeamOwner.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const done of cleanup.splice(0)) done();
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-native-bound-briefing-')));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const binding = {
    backendId: 'TEST-backend',
    teamId: 'TEST-team',
    teamName: 'test-native-briefing',
  };
  const source = { memberId: 'actual-agent-id' };
  const owner = createFilesystemTeamOwner({
    root,
    binding,
    members: [
      { memberId: 'actual-lead-id', name: 'leader', role: 'lead' },
      { memberId: source.memberId, name: 'alice', role: 'member' },
    ],
    grants: [
      {
        principalId: 'human',
        memberName: 'user',
        permissions: ['read', 'task.write', 'message.write', 'admin'],
      },
      {
        principalId: 'native-connection',
        memberName: 'alice',
        permissions: ['read', 'task.write', 'message.write'],
      },
    ],
  });
  const f = { root, binding, source, owner, human: owner.connect('human') };
  const path = join(f.root, 'teams', f.binding.teamName, 'config.json');
  mkdirSync(join(f.root, 'teams', f.binding.teamName), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      name: f.binding.teamName,
      leadAgentId: 'actual-lead-id',
      projectPath: join(f.root, 'TEST-project'),
      members: [
        { name: 'leader', agentId: 'actual-lead-id', agentType: 'team-lead' },
        {
          name: 'alice',
          agentId: f.source.memberId,
          role: 'TEST canonical engineer',
          workflow: 'TEST durable workflow rules',
          providerId: 'codex',
        },
      ],
    })
  );
  return f;
}
const value = (response: Awaited<ReturnType<ReturnType<typeof createTeamMcpTools>['callAsync']>>) =>
  response.structuredContent?.result as string;
it('member_briefing reuses canonical durable formatter and working queue for actual bound actor with no root or actor selectors', async () => {
  const f = fixture();
  const task = f.human.execute({
    commandId: 'TEST-member-briefing-task',
    operation: 'task.create',
    payload: { subject: 'TEST actual assigned task', owner: 'alice' },
  }).effects.taskId;
  const tools = createTeamMcpTools(f.owner.connect('native-connection'));
  const tool = tools.list().find((t) => t.name === 'member_briefing')!;
  expect(tool.inputSchema.properties).toEqual({ includeActiveProcesses: expect.any(Object) });
  const taskPath = join(f.root, 'tasks', f.binding.teamName, task + '.json');
  const before = readFileSync(taskPath, 'utf8');
  const commands = join(f.root, 'teams', f.binding.teamName, '.host-owner', 'commands');
  const inventory = readdirSync(commands).sort();
  const response = value(
    await tools.callAsync('member_briefing', { includeActiveProcesses: false })
  );
  const canonical = await createTeamPolicy(f.root, f.binding.teamName).reads!.memberBriefing!(
    'alice',
    { includeActiveProcesses: false }
  );
  expect(response).toBe(canonical);
  expect(response).toContain('Member briefing for alice');
  expect(response).toContain('TEST durable workflow rules');
  expect(response).toContain('TEST actual assigned task');
  expect(response).toContain('commandId');
  expect(response).not.toMatch(/\{ teamName:|actor: "|from: "|fromMember:|note\?:|SendMessage \{/);
  expect(response).not.toContain('agent-teams_message_send');
  expect(response).toContain('message_send');
  expect(readFileSync(taskPath, 'utf8')).toBe(before);
  expect(readdirSync(commands).sort()).toEqual(inventory);
  for (const selector of [
    { memberName: 'leader' },
    { teamName: 'foreign' },
    { claudeDir: '/foreign' },
    { from: 'leader' },
  ])
    await expect(tools.callAsync('member_briefing', selector)).rejects.toThrow(/invalid/);
});
it.each(['revocation', 'roster'] as const)(
  'member_briefing refuses original awaited read after %s without returning captured contents',
  async (change) => {
    const f = fixture();
    const store = new TeamOwnerStore(f.root, f.binding.teamName);
    const state = store.read<{
      members: ConstructorParameters<typeof TeamOwner>[0]['members'];
      grants: ConstructorParameters<typeof TeamOwner>[0]['grants'];
    }>('state.json')!;
    const policy = createTeamPolicy(f.root, f.binding.teamName);
    const original = policy.reads!.memberBriefing!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const observed = new Promise<void>((resolve) => {
      reached = resolve;
    });
    policy.reads = {
      ...policy.reads!,
      memberBriefing: async (member, options) => {
        const content = await original(member, options);
        reached();
        await gate;
        return content;
      },
    };
    const owner = new TeamOwner({
      binding: f.binding,
      members: state.members,
      grants: state.grants,
      store,
      policy,
      taskMutations: new TaskEffectPlan(f.root, f.binding.teamName, store),
    });
    const pending = createTeamMcpTools(owner.connect('native-connection')).callAsync(
      'member_briefing',
      {}
    );
    await observed;
    if (change === 'revocation') f.human.revoke('native-connection');
    else
      f.human.replaceRoster({
        commandId: 'TEST-changed-roster',
        expectedRevision: f.human.readRoster().revision,
        members: [{ name: 'alice', workflow: 'TEST replacement workflow' }],
      });
    release();
    await expect(pending).rejects.toThrow(/forbidden/);
  }
);
it('canonical bound member formatter refuses ambient runtime identity fallback for missing metadata', async () => {
  const f = fixture();
  const context = createTeamController(f.root, f.binding.teamName);
  const argv = process.argv;
  process.argv = [
    ...argv,
    '--agent-name',
    'not-in-canonical-metadata',
    '--team-name',
    f.binding.teamName,
  ];
  try {
    await expect(
      context.taskBoard.memberBriefing!('not-in-canonical-metadata', {
        includeActiveProcesses: false,
        boundTeamToolExample: true,
        allowRuntimeIdentityFallback: false,
      })
    ).rejects.toThrow(/not found/);
  } finally {
    process.argv = argv;
  }
});
